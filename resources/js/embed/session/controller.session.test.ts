/**
 * Two tabs of one host page share ONE stored visitor session (the loader keeps it in the host's localStorage). A rotation in one
 * tab revokes the token the other tab still holds: that tab must adopt the newer session, never wipe it.
 */
import { describe, expect, it } from 'vite-plus/test';
import type { StoredSession } from '@/embed/session/controller';
import { dropStoredSession } from '@/embed/session/storage';
import { useBackend } from '@/tests/msw/server';
import { createHarness, makeInit, until } from '@/tests/embed-harness';

/** What the loader's shared `localStorage` entry does for two panels. */
function sharedHostStore(initial: StoredSession | null) {
    const store = { current: initial as StoredSession | null, drops: 0 };

    return {
        store,
        deps: {
            persistSession: (session: StoredSession | null) => {
                store.current = session;
            },
            dropSession: async (token: string) => {
                store.drops += 1;

                if (store.current !== null && store.current.token !== token) {
                    return store.current;
                }

                store.current = null;

                return null;
            },
        },
    };
}

describe('two tabs sharing one stored session', () => {
    it('a stale tab refused as revoked adopts the newer stored session instead of clearing it', async () => {
        const backend = useBackend();
        const first = backend.issueToken();

        backend.seedConversation(first.token, 'active');

        const host = sharedHostStore(first);
        let clock = Date.now();
        const tabB = createHarness({
            backend,
            pollMs: 100_000,
            deps: { ...host.deps, now: () => clock },
        });

        await tabB.init(makeInit({ visitorSession: first }));
        await until(() => tabB.sockets.length === 1);

        const held = host.store.current;

        expect(held?.token).not.toBe(first.token);

        // tab A (opened later, reads the stored session) rotates it again: tab B now holds a revoked token
        const tabA = createHarness({
            backend,
            pollMs: 100_000,
            deps: host.deps,
        });

        await tabA.init(makeInit({ visitorSession: host.store.current! }));

        const newest = host.store.current;

        expect(newest?.token).not.toBe(held?.token);
        expect(backend.state.revoked.has(held?.token ?? '')).toBe(true);

        // long after tab B's own rotation, so the "just rotated" grace does not hide the refusal
        clock += 60_000;
        await tabB.controller.syncConversation();
        await until(() => host.store.drops > 0);

        expect(host.store.current?.token).toBe(newest?.token);
        expect(tabB.state().phase).toBe('active');
        expect(tabB.state().closedReason).toBeNull();

        // tab B carries on with the adopted token
        await tabB.controller.syncConversation();
        expect(backend.callsTo('GET', '/conversation').at(-1)?.auth).toBe(
            `Bearer ${newest?.token}`,
        );
        expect(tabB.state().phase).toBe('active');
        // ... and its socket is re-authorised with it
        await until(() => tabB.sockets.length === 2);
        expect(tabB.socket()?.input.token).toBe(newest?.token);
    });

    it('a refusal of the very token that is stored still ends the session and clears the storage', async () => {
        const backend = useBackend();
        const first = backend.issueToken();

        backend.seedConversation(first.token, 'active');

        const host = sharedHostStore(first);
        const tab = createHarness({
            backend,
            pollMs: 100_000,
            deps: host.deps,
        });

        await tab.init(makeInit({ visitorSession: first }));
        await until(() => tab.sockets.length === 1);

        backend.revoke(host.store.current?.token ?? '');
        tab.controller.send({ body: 'Anyone?' });
        await until(() => tab.state().phase === 'closed');

        expect(tab.state().closedReason).toBe('expired');
        expect(host.store.current).toBeNull();
    });

    it('a stale tab that starts a new chat lands in the chat the newer session already runs', async () => {
        const backend = useBackend();
        const first = backend.issueToken();
        const host = sharedHostStore(first);
        const stale = createHarness({
            backend,
            pollMs: 100_000,
            deps: host.deps,
        });

        await stale.init(makeInit({ visitorSession: first }));
        expect(stale.state().phase).toBe('prechat');

        // another tab starts the chat with a rotated session; the first token is revoked
        const rotated = backend.issueToken();

        backend.seedConversation(rotated.token, 'queued');
        backend.revoke(first.token);
        host.store.current = rotated;

        stale.controller.submitPrechat({
            name: 'Vera',
            email: '',
            phone: '',
            consent: false,
        });
        stale.controller.chooseCategory('billing');
        await until(() => stale.state().phase === 'queued');

        // the adopted session is the one that then learns where Reverb lives (it rotates once more): never the revoked first token
        await until(() => backend.state.rotated.has(rotated.token));
        expect(host.store.current?.token).toBe(
            backend.state.rotated.get(rotated.token),
        );
        expect(stale.state().conversation?.ulid).toBe(
            backend.state.conversation?.ulid,
        );
    });

    it('the host never answering (an older loader) means the session is gone after the controller gave up waiting', async () => {
        const backend = useBackend();
        const first = backend.issueToken();

        backend.seedConversation(first.token, 'active');

        const tab = createHarness({
            backend,
            pollMs: 100_000,
            deps: {
                persistSession: () => undefined,
                // the link of main.tsx resolves `null` after its own timeout
                dropSession: async () => null,
            },
        });

        await tab.init(makeInit({ visitorSession: first }));
        await until(() => tab.sockets.length === 1);

        backend.revoke(backend.state.rotated.get(first.token) ?? '');
        tab.controller.send({ body: 'hello?' });
        await until(() => tab.state().phase === 'closed');

        expect(tab.state().closedReason).toBe('expired');
    });
});

describe('a tab whose session lost the chat to the other tab (the token rotated away lives on for a minute)', () => {
    /** Tab A resumed the active chat; then another tab rotated and the chat now belongs to `other`, which the host stored. */
    async function movedChat() {
        const backend = useBackend();
        const first = backend.issueToken();

        backend.seedConversation(first.token, 'active');

        const host = sharedHostStore(first);
        const tab = createHarness({
            backend,
            pollMs: 100_000,
            deps: host.deps,
        });

        await tab.init(makeInit({ visitorSession: first }));
        await until(() => tab.sockets.length === 1);

        const other = backend.issueToken();

        backend.state.owner = other.token;
        host.store.current = other;

        return { backend, host, tab, other };
    }

    it('a sync that finds the session without a conversation adopts the newer session and stays in the chat (it is not closed)', async () => {
        const { backend, host, tab, other } = await movedChat();
        const before = tab.state().messages.length;

        document.dispatchEvent(new Event('visibilitychange'));
        await until(() => host.store.drops === 1);
        await until(
            () =>
                backend.callsTo('GET', '/conversation').at(-1)?.auth ===
                `Bearer ${other.token}`,
        );

        expect(tab.state().phase).toBe('active');
        expect(tab.state().messages.length).toBeGreaterThanOrEqual(before);
        // the socket re-authorises with the adopted session
        await until(() => tab.sockets.length === 2);
        expect(tab.sockets.at(-1)?.input.token).toBe(other.token);
    });

    it('a message the old token cannot send (404) stays with its Retry, and the retry goes out with the adopted session', async () => {
        const { backend, tab, other } = await movedChat();

        tab.controller.send({ body: 'From the stale tab' });
        await until(() =>
            tab.state().messages.some((message) => message.status === 'failed'),
        );
        await until(
            () =>
                backend.callsTo('GET', '/conversation').at(-1)?.auth ===
                `Bearer ${other.token}`,
        );

        const failed = tab
            .state()
            .messages.find((message) => message.status === 'failed');

        expect(tab.state().phase).toBe('active');
        expect(failed?.clientMsgId).toBeTruthy();

        tab.controller.retry(failed?.clientMsgId ?? '');
        await until(() =>
            backend.state.messages.some(
                (message) => message.body === 'From the stale tab',
            ),
        );
        expect(
            tab
                .state()
                .messages.filter(
                    (message) => message.body === 'From the stale tab',
                ),
        ).toHaveLength(1);
        expect(
            tab
                .state()
                .messages.every((message) => message.status !== 'failed'),
        ).toBe(true);
    });

    it('with no newer session stored the chat is over for this tab: the expired screen, nothing is invented', async () => {
        const { host, tab } = await movedChat();

        host.store.current = null;
        document.dispatchEvent(new Event('visibilitychange'));
        await until(() => tab.state().phase === 'closed');

        expect(tab.state().closedReason).toBe('expired');
    });
});

describe('session creation tolerates what the visitor cannot fix', () => {
    const FORM = {
        name: 'Vera',
        email: '',
        phone: '',
        consent: false,
    };

    it('a 422 blaming only the optional visitor / page fields is retried once without them', async () => {
        const backend = useBackend();

        backend.fail(
            'POST',
            '/sessions$',
            422,
            {
                error: {
                    code: 'validation_failed',
                    message: 'The given data was invalid.',
                    details: {
                        'visitor.email': [
                            'The visitor.email field must be a valid email address.',
                        ],
                    },
                },
            },
            1,
        );

        const h = createHarness({ backend });

        await h.init(
            makeInit({
                visitor: { name: 'Ann', email: 'ann@example.com' },
                page: {
                    url: 'https://shop.example/',
                    title: 'T'.repeat(300),
                    referrer: '',
                },
            }),
        );
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        const attempts = backend.callsTo('POST', '/sessions');

        expect(attempts).toHaveLength(2);
        expect(
            (attempts[0].body as { page: { title: string } }).page.title,
        ).toHaveLength(255);
        expect(attempts[1].body).not.toHaveProperty('visitor');
        expect(h.state().notice).toBeNull();
    });

    it('a signed identity the server refuses is not retried and says so', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init(makeInit({ identityToken: 'bad.token.value' }));
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().notice !== null);

        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
        expect(h.state().notice?.code).toBe('identity');
    });
});

describe('dropStoredSession (standalone pages)', () => {
    const key = 'wk_dropstoredsession0000';

    it('clears the entry only while it still holds the dropped token and hands a newer one back', () => {
        const stored = {
            token: 'vt_new',
            expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
        };

        window.localStorage.setItem(
            `chatfeature:${key}:session`,
            JSON.stringify(stored),
        );

        expect(dropStoredSession(key, 'vt_old')).toEqual(stored);
        expect(
            window.localStorage.getItem(`chatfeature:${key}:session`),
        ).not.toBeNull();

        expect(dropStoredSession(key, 'vt_new')).toBeNull();
        expect(
            window.localStorage.getItem(`chatfeature:${key}:session`),
        ).toBeNull();
    });
});
