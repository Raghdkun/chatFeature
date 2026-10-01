import '@/tests/dom-polyfills';
import { toast } from 'sonner';
import { createApiClient } from '@/lib/api-client';
import { createStaffApi } from '@/lib/chat-api/staff';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { InboxNavBadge, TicketsNavBadge } from '@/components/inbox/nav-badges';
import {
    fakeTime,
    makeActiveConversationStaff,
    makeConversationStaff,
    makeOffer,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { ConversationStaff } from '@/lib/chat/types';
import InboxIndex from '@/pages/inbox/index';
import { byTestId, choose, fill } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { routerMock } from '@/tests/inertia-mock';
import { CATEGORIES } from '@/tests/fixtures';
import {
    ADMIN,
    AGENT,
    renderStaff,
    useStaffBackend,
    waitFor,
} from '@/tests/staff-kit';
import { act } from 'react';
import { click } from '@/tests/render';
import type { InboxPageProps } from '@/types/chat-staff';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

const backend = useStaffBackend();

const mineOf = (overrides: Partial<ConversationStaff> = {}) =>
    makeActiveConversationStaff({
        assignedAgent: { id: AGENT.id, name: AGENT.name },
        lastMessageAt: fakeTime(100),
        lastMessagePreview: 'Where is my invoice?',
        ...overrides,
    });

const shell = (overrides: Partial<InboxPageProps> = {}): InboxPageProps => ({
    queue: [],
    mine: [],
    presence: { status: 'online' },
    categories: CATEGORIES,
    ...overrides,
});

beforeEach(() => resetFixtures());
afterEach(() => {
    vi.clearAllMocks();
    document.title = '';
});

describe('the lists', () => {
    it('shows the queue with a big Accept button per request, and my chats with unseen badges, newest first', async () => {
        const waiting = makeConversationStaff({
            visitor: {
                ulid: 'v1',
                name: 'Mina Haddad',
                email: null,
                phone: null,
                verified: true,
                meta: {},
            },
            category: { slug: 'billing', label: 'Billing' },
            lastMessagePreview: 'Can I get a quote?',
        });
        const older = mineOf({
            visitor: {
                ulid: 'v2',
                name: 'Older Chat',
                email: null,
                phone: null,
                verified: false,
                meta: {},
            },
            lastMessageAt: fakeTime(10),
        });
        const newer = mineOf({
            visitor: {
                ulid: 'v3',
                name: 'Newer Chat',
                email: null,
                phone: null,
                verified: false,
                meta: {},
            },
            lastMessageAt: fakeTime(90),
            unseenByAgent: 3,
        });
        const { view } = await renderStaff(
            <InboxIndex
                {...shell({ queue: [waiting], mine: [older, newer] })}
            />,
        );

        const offer = view.byTestId(`offer-${waiting.ulid}`);

        expect(offer?.textContent).toContain('Mina Haddad');
        expect(offer?.textContent).toContain('Billing');
        expect(offer?.textContent).toContain('Can I get a quote?');
        expect(
            view.byTestId(`offer-accept-${waiting.ulid}`)?.textContent,
        ).toContain('Accept');
        expect(view.byTestId('inbox-queue-count')?.textContent).toBe('1');

        const rows = Array.from(
            view.container.querySelectorAll('[data-testid^="chat-row-"]'),
        ).map((row) => row.getAttribute('data-testid'));

        expect(rows).toEqual([
            `chat-row-${newer.ulid}`,
            `chat-row-${older.ulid}`,
        ]);
        expect(
            view.byTestId(`chat-unseen-${newer.ulid}`)?.textContent,
        ).toContain('3');
        expect(view.byTestId(`chat-unseen-${older.ulid}`)).toBeNull();
        expect(
            view.byTestId(`chat-row-${newer.ulid}`)?.getAttribute('href'),
        ).toBe(`/inbox/${newer.ulid}`);
    });

    it('explains an empty inbox instead of showing nothing', async () => {
        const { view } = await renderStaff(<InboxIndex {...shell()} />);

        expect(view.byTestId('inbox-queue-empty')).not.toBeNull();
        expect(view.byTestId('inbox-mine-empty')?.textContent).toContain(
            'No conversations yet',
        );
        expect(view.byTestId('inbox-empty-conversation')).not.toBeNull();
    });

    it('searches and filters my chats', async () => {
        const vera = mineOf({
            visitor: {
                ulid: 'v1',
                name: 'Vera',
                email: 'vera@x.test',
                phone: null,
                verified: false,
                meta: {},
            },
        });
        const omar = mineOf({
            visitor: {
                ulid: 'v2',
                name: 'Omar',
                email: null,
                phone: null,
                verified: false,
                meta: {},
            },
            unseenByAgent: 2,
        });
        const done = mineOf({
            visitor: {
                ulid: 'v3',
                name: 'Dana',
                email: null,
                phone: null,
                verified: false,
                meta: {},
            },
            status: 'closed',
        });
        const { view } = await renderStaff(
            <InboxIndex {...shell({ mine: [vera, omar, done] })} />,
        );
        const rowIds = () =>
            Array.from(
                view.container.querySelectorAll('[data-testid^="chat-row-"]'),
            ).length;

        expect(rowIds()).toBe(3);

        await fill(view.byTestId('inbox-search') as HTMLInputElement, 'vera@');
        expect(rowIds()).toBe(1);
        await fill(view.byTestId('inbox-search') as HTMLInputElement, 'zzz');
        expect(view.byTestId('inbox-mine-no-match')).not.toBeNull();
        await fill(view.byTestId('inbox-search') as HTMLInputElement, '');

        await click(view.byTestId('inbox-filter-unread'));
        expect(view.byTestId(`chat-row-${omar.ulid}`)).not.toBeNull();
        expect(rowIds()).toBe(1);

        await click(view.byTestId('inbox-filter-finished'));
        expect(view.byTestId(`chat-row-${done.ulid}`)).not.toBeNull();
        expect(rowIds()).toBe(1);
        expect(
            view
                .byTestId('inbox-filter-finished')
                ?.getAttribute('aria-pressed'),
        ).toBe('true');
    });

    it('shows the monitored chats of other agents to an admin, with whose they are', async () => {
        const theirs = mineOf({ assignedAgent: { id: 9, name: 'Omar' } });
        const { view } = await renderStaff(
            <InboxIndex {...shell({ mine: [theirs] })} />,
            { viewer: ADMIN },
        );

        expect(view.byTestId(`chat-row-${theirs.ulid}`)?.textContent).toContain(
            'With Omar',
        );
    });
});

describe('accepting', () => {
    it('claims the chat and opens it', async () => {
        const waiting = makeConversationStaff();

        backend.current.state.conversations.set(waiting.ulid, waiting);
        const { view, session } = await renderStaff(
            <InboxIndex {...shell({ queue: [waiting] })} />,
        );

        await click(view.byTestId(`offer-accept-${waiting.ulid}`));
        await waitFor(() =>
            expect(routerMock.visit).toHaveBeenCalledWith(
                `/inbox/${waiting.ulid}`,
            ),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${waiting.ulid}/claim`,
            ),
        ).toHaveLength(1);
        expect(session.store.getState().mine.map((c) => c.ulid)).toEqual([
            waiting.ulid,
        ]);
        expect(session.store.getState().queue).toEqual([]);
    });

    it('tells the agent who got there first and keeps them in the inbox', async () => {
        const waiting = makeConversationStaff();

        backend.current.state.conversations.set(waiting.ulid, waiting);
        backend.current.state.lostClaims.set(waiting.ulid, 'Omar');
        const { view } = await renderStaff(
            <InboxIndex {...shell({ queue: [waiting] })} />,
        );

        await click(view.byTestId(`offer-accept-${waiting.ulid}`));
        await waitFor(() =>
            expect(
                view.byTestId(`offer-outcome-${waiting.ulid}`)?.textContent,
            ).toContain('Taken by Omar'),
        );

        expect(toast).toHaveBeenCalledWith('Taken by Omar', expect.anything());
        expect(routerMock.visit).not.toHaveBeenCalled();
        expect(view.byTestId(`offer-accept-${waiting.ulid}`)).toBeNull();
    });

    it('does not offer Accept to an admin who does not take chats', async () => {
        const waiting = makeConversationStaff();
        const { view } = await renderStaff(
            <InboxIndex {...shell({ queue: [waiting] })} />,
            {
                viewer: { ...ADMIN, isAgent: false },
            },
        );

        expect(view.byTestId(`offer-${waiting.ulid}`)?.textContent).toContain(
            'do not take chats',
        );
        expect(view.byTestId(`offer-accept-${waiting.ulid}`)).toBeNull();
        expect(view.byTestId('presence-select')).toBeNull();
    });
});

describe('realtime', () => {
    const staffChannel = `staff.${AGENT.id}`;

    it("subscribes to the agent's private channel and the staff presence channel", async () => {
        await renderStaff(<InboxIndex {...shell()} />);

        expect(fakeEcho.channels()).toEqual(
            expect.arrayContaining([
                `private:${staffChannel}`,
                'presence:staff',
            ]),
        );
        expect(fakeEcho.channels()).not.toContain('private:admin');
    });

    it('also listens on the admin channel for administrators', async () => {
        await renderStaff(<InboxIndex {...shell()} />, { viewer: ADMIN });

        expect(fakeEcho.channels()).toContain('private:admin');
    });

    it('shows a new offer as it arrives, rings, and toasts with Accept', async () => {
        const { view, sound } = await renderStaff(<InboxIndex {...shell()} />);
        const offer = makeOffer({
            visitor: { name: 'Nour', verified: false },
            preview: 'Hello?',
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
        });

        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'chat.offered', offer),
        );

        expect(
            view.byTestId(`offer-${offer.conversation}`)?.textContent,
        ).toContain('Nour');
        expect(view.byTestId('offer-countdown')?.textContent).toMatch(
            /^1:(2|3)\d$|^1:30$/,
        );
        expect(sound.play).toHaveBeenCalledWith('offer');
        expect(toast).toHaveBeenCalledWith(
            'New chat request',
            expect.objectContaining({
                action: expect.objectContaining({ label: 'Accept' }),
            }),
        );
    });

    it('marks a card "Taken by" when a colleague wins, and removes the toast', async () => {
        const { view } = await renderStaff(<InboxIndex {...shell()} />);
        const offer = makeOffer();

        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'chat.offered', offer),
        );
        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'chat.taken', {
                v: 1,
                conversation: offer.conversation,
                by: { id: 9, name: 'Omar' },
            }),
        );

        expect(
            view.byTestId(`offer-outcome-${offer.conversation}`)?.textContent,
        ).toContain('Taken by Omar');
        expect(toast.dismiss).toHaveBeenCalledWith(
            `offer-${offer.conversation}`,
        );
    });

    it('moves a chat into My chats on conversation.updated and raises its unseen badge on unread.updated', async () => {
        const { view } = await renderStaff(<InboxIndex {...shell()} />);
        const chat = mineOf({ lastMessagePreview: 'Hi' });

        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'conversation.updated', {
                v: 1,
                conversation: chat,
            }),
        );
        expect(view.byTestId(`chat-row-${chat.ulid}`)).not.toBeNull();

        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'unread.updated', {
                v: 1,
                conversation: chat.ulid,
                unseen: 2,
            }),
        );
        expect(
            view.byTestId(`chat-unseen-${chat.ulid}`)?.textContent,
        ).toContain('2');
    });

    it('shows who else is signed in from the presence roster', async () => {
        const { view } = await renderStaff(<InboxIndex {...shell()} />);

        expect(view.byTestId('roster-toggle')).toBeNull();

        await act(async () =>
            fakeEcho.presence.here([
                {
                    id: AGENT.id,
                    name: 'Sam',
                    avatarUrl: null,
                    status: 'online',
                },
                { id: 9, name: 'Omar', avatarUrl: null, status: 'away' },
            ]),
        );

        expect(view.byTestId('roster-toggle')?.textContent).toContain('1');
    });

    it('signs out once the server confirms the session is revoked', async () => {
        const signOut = vi.fn();
        const onUnauthenticated = vi.fn();
        // The shared client reloads the page on any 401 (which alone ends on the sign-in page); here that is a spy.
        const api = createStaffApi(
            createApiClient({ onUnauthenticated, csrfCookieUrl: null }),
        );

        await renderStaff(<InboxIndex {...shell()} />, {
            effects: { signOut },
            api,
        });
        backend.current.state.revoked = true;
        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'session.revoked', {
                v: 1,
                reason: 'deactivated',
            }),
        );

        await waitFor(() =>
            expect(signOut).toHaveBeenCalledWith('deactivated'),
        );
        expect(
            backend.current.calls('GET', '/api/v1/me/presence').length,
        ).toBeGreaterThan(0);
        expect(onUnauthenticated).toHaveBeenCalled();
    });

    it('stays signed in when the event concerned another session of the same person', async () => {
        const signOut = vi.fn();

        await renderStaff(<InboxIndex {...shell()} />, {
            effects: { signOut },
        });
        await act(async () =>
            fakeEcho.emitServer(staffChannel, 'session.revoked', {
                v: 1,
                reason: 'auth_revoked',
            }),
        );
        await waitFor(() =>
            expect(
                backend.current.calls('GET', '/api/v1/me/presence').length,
            ).toBeGreaterThan(0),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
        });

        expect(signOut).not.toHaveBeenCalled();
    });
});

describe('presence', () => {
    it('shows the status and, while offline, a way to go online', async () => {
        backend.current.state.presence = 'offline';
        const { view, session } = await renderStaff(
            <InboxIndex {...shell({ presence: { status: 'offline' } })} />,
        );

        expect(
            (view.byTestId('presence-select') as HTMLSelectElement).value,
        ).toBe('offline');
        expect(view.byTestId('presence-offline-notice')).not.toBeNull();

        await click(view.byTestId('presence-go-online'));
        await waitFor(() =>
            expect(session.store.getState().presence).toBe('online'),
        );

        expect(
            backend.current.calls('PUT', '/api/v1/me/presence')[0].body,
        ).toEqual({ status: 'online' });
        expect(
            (view.byTestId('presence-select') as HTMLSelectElement).value,
        ).toBe('online');
        expect(view.byTestId('presence-offline-notice')).toBeNull();
        await waitFor(() =>
            expect(
                backend.current.calls('POST', '/api/v1/me/presence/heartbeat')
                    .length,
            ).toBeGreaterThan(0),
        );
    });

    it('changes the status from the select', async () => {
        const { view, session } = await renderStaff(
            <InboxIndex {...shell()} />,
        );

        await choose(
            view.byTestId('presence-select') as HTMLSelectElement,
            'away',
        );
        await waitFor(() =>
            expect(session.store.getState().presence).toBe('away'),
        );

        expect(backend.current.state.presence).toBe('away');
    });

    it('beats right after arriving online', async () => {
        await renderStaff(<InboxIndex {...shell()} />);

        await waitFor(() =>
            expect(
                backend.current.calls('POST', '/api/v1/me/presence/heartbeat'),
            ).toHaveLength(1),
        );
    });
});

describe('without a websocket', () => {
    it('says live updates are off and polls over REST', async () => {
        const waiting = makeConversationStaff();

        backend.current.state.conversations.set(waiting.ulid, waiting);
        const { view } = await renderStaff(<InboxIndex {...shell()} />, {
            sockets: false,
        });

        expect(view.byTestId('connection-banner')?.textContent).toContain(
            'Live updates are off',
        );
        expect(view.byTestId('connection-banner')?.textContent).toContain(
            '15 seconds',
        );
        expect(fakeEcho.channels()).toEqual([]);
    });
});

describe('attention', () => {
    it('puts the number of waiting requests and unread messages in the document title', async () => {
        document.title = 'Inbox - PNE Chat';
        const waiting = makeConversationStaff();
        const unread = mineOf({ unseenByAgent: 2 });
        const { session } = await renderStaff(
            <InboxIndex {...shell({ queue: [waiting], mine: [unread] })} />,
        );

        expect(document.title).toBe('(3) Inbox - PNE Chat');

        await act(async () =>
            session.store.dispatch({ type: 'seen', conversation: unread.ulid }),
        );
        expect(document.title).toBe('(1) Inbox - PNE Chat');
    });

    it('feeds the sidebar badges', async () => {
        const unread = mineOf({ unseenByAgent: 4 });
        const ticket = makeConversationStaff({ type: 'offline' });
        const { view, session } = await renderStaff(
            <>
                <InboxNavBadge />
                <TicketsNavBadge />
                <InboxIndex {...shell({ mine: [unread] })} />
            </>,
        );

        expect(view.byTestId('nav-badge-inbox')?.textContent).toContain('4');
        expect(view.byTestId('nav-badge-tickets')).toBeNull();

        await act(async () =>
            session.store.dispatch({ type: 'hydrate', tickets: [ticket] }),
        );
        expect(view.byTestId('nav-badge-tickets')?.textContent).toContain('1');
        expect(
            byTestId(view.container, 'nav-badge-inbox')?.textContent,
        ).toContain('4 need attention');
    });
});
