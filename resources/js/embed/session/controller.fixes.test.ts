import { describe, expect, it } from 'vite-plus/test';
import { createVisitorApi } from '@/lib/chat-api/visitor';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import {
    createHarness,
    loaderBoot,
    makeInit,
    until,
    type Harness,
} from '@/tests/embed-harness';

const FORM = { name: 'Vera', email: 'vera@x.test', phone: '', consent: false };

/** A widget without a pre-chat form and with one topic: a chat can start from the first screen. */
function noForm(): Record<string, unknown> {
    const base = bootConfig().config as object;

    return loaderBoot({
        config: {
            ...base,
            preChat: {
                fields: {
                    name: { enabled: false, required: false },
                    email: { enabled: false, required: false },
                    phone: { enabled: false, required: false },
                },
                consentText: null,
            },
        },
    });
}

async function queue(h: Harness, topic = 'billing'): Promise<void> {
    await h.init();
    h.open();
    h.controller.submitPrechat(FORM);
    h.controller.chooseCategory(topic);
    await until(() => h.state().phase === 'queued');
    await until(() => h.socket()?.status() === 'connected');
}

async function activate(h: Harness): Promise<void> {
    await queue(h);
    h.backend.claim('Sam');
    h.socket()?.emit('chat.claimed', {
        v: 1,
        agent: { name: 'Sam', avatarUrl: null },
        claimedAt: 'x',
    });
    await until(() => h.state().phase === 'active');
    await until(() => h.state().messages.length > 0);
}

describe('startChat from the host while the panel boots', () => {
    it('is remembered and applied once the first screen is known (the loader flushes it right after init:result)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });
        const booting = h.init(makeInit({ boot: noForm() }));

        // not awaited: the panel is still `booting` when the queued host message arrives
        expect(h.state().phase).toBe('booting');
        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'tech', message: 'Where is my invoice?' },
        });
        await booting;
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')[0].body).toEqual({
            category: 'tech',
            message: 'Where is my invoice?',
        });
    });

    it('through the real message path (init, then startChat in the same tick), with a form the category waits for the visitor', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        h.controller.handleHostMessage({
            type: 'init',
            payload: makeInit(),
        });
        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'tech', message: 'Hi' },
        });
        await until(() => h.state().phase === 'prechat');

        expect(h.state()).toMatchObject({
            category: 'tech',
            initialMessage: 'Hi',
        });
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });

    it('is dropped when the boot resumes a running chat', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const h = createHarness({ backend });
        const booting = h.init(makeInit({ visitorSession: stored }));

        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'tech' },
        });
        await booting;

        expect(h.state().phase).toBe('active');
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });

    it('startChat after a finished chat starts clean: no stale receipt counters, no stale unread badge', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await h.init(makeInit({ boot: noForm() }));
        h.open();
        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'billing' },
        });
        await until(() => h.state().phase === 'queued');
        await until(() => h.socket()?.status() === 'connected');
        backend.claim('Sam');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');

        // the visitor sees five agent messages: the receipt counter climbs to seq 6
        h.controller.setViewing(true);

        for (let i = 0; i < 5; i++) {
            backend.agentSays(`m${i}`);
        }

        await h.controller.syncConversation();
        await until(() => backend.callsTo('POST', '/receipts').length > 0);
        h.controller.setViewing(false);
        await h.controller.endChat();
        h.controller.skipRating();
        expect(h.state().phase).toBe('closed');

        // the host starts a second chat
        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'billing' },
        });
        await until(() => h.state().phase === 'queued');
        await until(() => h.socket()?.status() === 'connected');
        backend.claim('Mia');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Mia', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');

        // panel closed: the first agent message of the new chat counts as unread, and seeing it is reported
        h.close();
        backend.agentSays('hello again');
        await h.controller.syncConversation();
        expect(h.hostStates().at(-1)?.unread).toBe(1);

        h.open();
        h.controller.setViewing(true);

        const receiptsBefore = backend.callsTo('POST', '/receipts').length;

        await until(
            () => backend.callsTo('POST', '/receipts').length > receiptsBefore,
        );
        expect(h.hostStates().at(-1)?.unread).toBe(0);
        expect(backend.callsTo('POST', '/receipts').at(-1)?.body).toMatchObject(
            { seen_upto: 2 },
        );
    });
});

describe('a stale GET /conversation', () => {
    it('answering "queued" after chat.claimed landed does not move the chat back to the queue', async () => {
        const backend = useBackend();
        let release: () => void = () => undefined;
        let hold = false;
        let answered = false;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = createHarness({
            backend,
            pollMs: 100_000,
            deps: {
                createApi: (options) => {
                    const real = createVisitorApi(options);

                    return {
                        ...real,
                        getConversation: async (signal?: AbortSignal) => {
                            const answer = await real.getConversation(signal);

                            if (hold) {
                                answered = true;
                                await gate;
                            }

                            return answer;
                        },
                    };
                },
            },
        });

        await queue(h);
        hold = true;

        // the poll reads "queued" ...
        const sync = h.controller.syncConversation();

        await until(() => answered);

        // ... then the claim arrives over the socket, before that answer is applied
        backend.claim('Sam');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        expect(h.state().phase).toBe('active');
        release();
        await sync;

        expect(h.state().phase).toBe('active');
        expect(h.state().transferred).toBe(false);
    });
});

describe('ratings switched off', () => {
    it('an ended chat goes straight to the thank-you screen and the server is told the visitor declined (rating/skip)', async () => {
        const backend = useBackend();
        const base = bootConfig().config as { features: object };
        const h = createHarness({ backend });

        await h.init(
            makeInit({
                boot: loaderBoot({
                    config: {
                        ...base,
                        features: { ...base.features, rating: false },
                    },
                }),
            }),
        );
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await until(() => h.socket()?.status() === 'connected');
        backend.claim('Sam');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');
        await h.controller.endChat();

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'ended',
        });
        await until(() => backend.callsTo('POST', '/rating/skip').length === 1);
        expect(backend.state.conversation?.status).toBe('closed');
    });

    it('does not call skip when the server itself closed the chat without a rating request', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.socket()?.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: false,
        });

        expect(h.state().phase).toBe('closed');
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(backend.callsTo('POST', '/rating/skip')).toHaveLength(0);
    });
});

describe('requests that never answer', () => {
    it('a sync pass that hangs is given up on after a while: the next call starts a fresh one instead of waiting forever', async () => {
        const backend = useBackend();
        let hangFirst = false;
        let calls = 0;
        let clock = Date.now();
        const h = createHarness({
            backend,
            pollMs: 100_000,
            deps: {
                now: () => clock,
                createApi: (options) => {
                    const real = createVisitorApi(options);

                    return {
                        ...real,
                        getConversation: (signal?: AbortSignal) => {
                            calls += 1;

                            return hangFirst && calls === 1
                                ? new Promise<never>(() => undefined)
                                : real.getConversation(signal);
                        },
                    };
                },
            },
        });

        await queue(h);
        calls = 0;
        hangFirst = true;
        void h.controller.syncConversation();
        expect(calls).toBe(1);

        // a second call while the first is young just joins it
        void h.controller.syncConversation();
        expect(calls).toBe(1);

        clock += 60_000;
        backend.claim('Sam');
        await h.controller.syncConversation();

        expect(calls).toBe(2);
        expect(h.state().phase).toBe('active');
    });

    it('a request that times out leaves the visitor with a retry, never a stuck "sending" bubble', async () => {
        const backend = useBackend();
        const h = createHarness({
            backend,
            pollMs: 100_000,
            deps: {
                createApi: (options) =>
                    createVisitorApi({
                        ...options,
                        timeoutMs: 40,
                        fetchImpl: (input, init) =>
                            String(input as string).endsWith('/messages') &&
                            init?.method === 'POST'
                                ? new Promise<Response>(() => undefined)
                                : fetch(input, init),
                    }),
            },
        });

        await activate(h);
        h.controller.send({ body: 'Hello?' });
        await until(() =>
            h.state().messages.some((m) => m.status === 'failed'),
        );

        expect(h.state().messages.at(-1)).toMatchObject({
            body: 'Hello?',
            status: 'failed',
        });
    });
});
