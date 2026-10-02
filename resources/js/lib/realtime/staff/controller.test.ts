import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ApiError } from '@/lib/api-client';
import type { StaffApi } from '@/lib/chat-api/staff';
import {
    makeActiveConversationStaff,
    makeConversationStaff,
    makeOffer,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { interpolate } from '@/lib/i18n';
import {
    createStaffController,
    HEARTBEAT_INTERVAL_MS,
    KEEPALIVE_AFTER_HIDDEN_MS,
    KEEPALIVE_INTERVAL_MS,
    MESSAGE_NOTICE_WAIT_MS,
    offerTag,
    POLL_INTERVAL_MS,
    PRESENCE_RESYNC_AFTER_FAILED_BEATS,
    PRESENCE_RESYNC_AFTER_MS,
    SYNC_DEBOUNCE_MS,
    type StaffEffects,
} from '@/lib/realtime/staff/controller';
import {
    createInboxStore,
    OFFER_EXIT_MS,
    type InboxStore,
} from '@/lib/realtime/staff/store';
import { en } from '@/tests/lang';

const ME = { id: 7, isAdmin: false, isAgent: true };

type Rig = {
    store: InboxStore;
    api: {
        [
            K in
                | 'queue'
                | 'conversations'
                | 'conversation'
                | 'claim'
                | 'setPresence'
                | 'presence'
                | 'heartbeat'
                | 'keepAlive'
        ]: ReturnType<typeof vi.fn>;
    };
    effects: { [K in keyof StaffEffects]: ReturnType<typeof vi.fn> };
    viewing: { current: string | null };
    /** Whether the (fake) tab is in the foreground; every heartbeat reports it. */
    visible: { current: boolean };
    controller: ReturnType<typeof createStaffController>;
};

function rig(viewer = ME): Rig {
    const store = createInboxStore();
    const api = {
        queue: vi.fn().mockResolvedValue([]),
        conversations: vi.fn().mockResolvedValue([]),
        conversation: vi.fn(),
        claim: vi.fn(),
        setPresence: vi.fn(),
        presence: vi.fn(),
        heartbeat: vi.fn().mockResolvedValue(null),
        keepAlive: vi.fn().mockResolvedValue(null),
    };
    const effects = {
        playSound: vi.fn(),
        toast: vi.fn(),
        dismissToast: vi.fn(),
        notify: vi.fn(),
        closeNotification: vi.fn(),
        signOut: vi.fn(),
        openConversation: vi.fn(),
    };
    const viewing: { current: string | null } = { current: null };
    const visible = { current: true };
    const controller = createStaffController({
        store,
        api: api as unknown as StaffApi,
        viewer,
        t: (key, replacements) => interpolate(en[key] ?? key, replacements),
        effects,
        isViewing: (ulid) => viewing.current === ulid,
        isVisible: () => visible.current,
    });

    return { store, api, effects, viewing, visible, controller };
}

const taken = (by = 'Sam') =>
    new ApiError({
        status: 409,
        code: 'already_claimed',
        message: 'Already claimed.',
        details: { by: [by] },
    });

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-20T10:00:00.000Z'));
    resetFixtures();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('offers', () => {
    it('adds the card, rings, toasts with an Accept action and notifies the OS', () => {
        const { store, effects, controller } = rig();
        const offer = makeOffer({
            visitor: { name: 'Mina', verified: false },
            category: { slug: 'billing', label: 'Billing' },
            expiresAt: new Date(Date.now() + 90_000).toISOString(),
        });

        controller.handle('chat.offered', offer);

        expect(store.getState().queue).toHaveLength(1);
        expect(effects.playSound).toHaveBeenCalledWith('offer');
        expect(effects.toast).toHaveBeenCalledWith(
            'offer',
            'New chat request',
            expect.objectContaining({
                id: offerTag(offer.conversation),
                description: 'Mina, Billing',
                action: expect.objectContaining({ label: 'Accept' }),
            }),
        );
        expect(effects.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                tag: offerTag(offer.conversation),
                body: 'Mina, Billing',
            }),
        );
    });

    it('hands the notification a generic wording without the visitor name (previews off): the topic only, like the push', () => {
        const { effects, controller } = rig();

        controller.handle(
            'chat.offered',
            makeOffer({
                visitor: { name: 'Mina', verified: false },
                category: { slug: 'billing', label: 'Billing' },
            }),
        );

        const options = effects.notify.mock.calls[0][0];

        expect(options.kind).toBe('offer');
        expect(options.generic).toEqual({
            title: 'New chat request',
            body: 'Billing',
        });
        expect(JSON.stringify(options.generic)).not.toContain('Mina');
    });

    it('names an anonymous visitor and an uncategorised chat', () => {
        const { effects, controller } = rig();

        controller.handle(
            'chat.offered',
            makeOffer({
                visitor: { name: null, verified: false },
                category: null,
            }),
        );

        expect(effects.toast).toHaveBeenCalledWith(
            'offer',
            expect.any(String),
            expect.objectContaining({ description: 'Visitor, General' }),
        );
    });

    it('ignores offers when the viewer does not take chats (an admin who is not an agent)', () => {
        const { store, effects, controller } = rig({
            id: 1,
            isAdmin: true,
            isAgent: false,
        });

        controller.handle('chat.offered', makeOffer());

        expect(store.getState().queue).toEqual([]);
        expect(effects.playSound).not.toHaveBeenCalled();
    });

    it('accepts from the toast: claims, then opens the chat', async () => {
        const { api, effects, controller } = rig();
        const offer = makeOffer();
        const claimed = makeActiveConversationStaff({
            ulid: offer.conversation,
            assignedAgent: { id: ME.id, name: 'Me' },
        });

        api.claim.mockResolvedValue(claimed);
        controller.handle('chat.offered', offer);
        effects.toast.mock.calls[0][2].action.onClick();
        await flush();

        expect(api.claim).toHaveBeenCalledWith(offer.conversation);
        expect(effects.openConversation).toHaveBeenCalledWith(
            offer.conversation,
        );
    });

    it('ignores a payload version it does not know', () => {
        const { store, controller } = rig();

        controller.handle('chat.offered', { ...makeOffer(), v: 2 });

        expect(store.getState().queue).toEqual([]);
    });
});

describe('claim race', () => {
    it('the winner moves the chat to My chats and clears the toast and notification', async () => {
        const { api, store, effects, controller } = rig();
        const offer = makeOffer();
        const claimed = makeActiveConversationStaff({
            ulid: offer.conversation,
            assignedAgent: { id: ME.id, name: 'Me' },
        });

        api.claim.mockResolvedValue(claimed);
        controller.handle('chat.offered', offer);

        const outcome = await controller.claim(offer.conversation);

        expect(outcome).toEqual({ ok: true, conversation: claimed });
        expect(store.getState().queue).toEqual([]);
        expect(store.getState().mine.map((c) => c.ulid)).toEqual([
            offer.conversation,
        ]);
        expect(effects.closeNotification).toHaveBeenCalledWith(
            offerTag(offer.conversation),
        );
        expect(effects.dismissToast).toHaveBeenCalledWith(
            offerTag(offer.conversation),
        );
    });

    it('the loser sees "Taken by Sam": the card says so, a toast says so, and the card leaves', async () => {
        const { api, store, effects, controller } = rig();
        const offer = makeOffer();

        api.claim.mockRejectedValue(taken('Sam'));
        controller.start();
        controller.handle('chat.offered', offer);

        const outcome = await controller.claim(offer.conversation);

        expect(outcome).toEqual({ ok: false, reason: 'taken' });
        expect(store.getState().queue[0]).toMatchObject({
            state: 'taken',
            takenBy: 'Sam',
        });
        expect(effects.toast).toHaveBeenLastCalledWith('info', 'Taken by Sam');

        vi.advanceTimersByTime(OFFER_EXIT_MS);

        expect(store.getState().queue).toEqual([]);
        controller.stop();
    });

    it('says "another agent" when the server did not name the winner', async () => {
        const { api, effects, controller } = rig();

        api.claim.mockRejectedValue(
            new ApiError({
                status: 409,
                code: 'already_claimed',
                message: 'x',
            }),
        );

        await controller.claim('01JFAKE0000000000000000001');

        expect(effects.toast).toHaveBeenLastCalledWith(
            'info',
            'Another agent took this chat',
        );
    });

    it("any other failure is an error toast with the server's sentence and leaves the card open", async () => {
        const { api, store, effects, controller } = rig();
        const offer = makeOffer();

        api.claim.mockRejectedValue(
            new ApiError({
                status: 409,
                code: 'at_limit',
                message: 'You are at your chat limit.',
            }),
        );
        controller.handle('chat.offered', offer);

        const outcome = await controller.claim(offer.conversation);

        expect(outcome).toEqual({ ok: false, reason: 'failed' });
        expect(effects.toast).toHaveBeenLastCalledWith(
            'error',
            'You are at your chat limit.',
        );
        expect(store.getState().queue[0].state).toBe('open');
    });

    it('chat.taken from the websocket does the same for the other agents', () => {
        const { store, effects, controller } = rig();
        const offer = makeOffer();

        controller.start();
        controller.handle('chat.offered', offer);
        controller.handle('chat.taken', {
            v: 1,
            conversation: offer.conversation,
            by: { id: 9, name: 'Omar' },
        });

        expect(store.getState().queue[0]).toMatchObject({
            state: 'taken',
            takenBy: 'Omar',
        });
        expect(effects.dismissToast).toHaveBeenCalledWith(
            offerTag(offer.conversation),
        );
        expect(effects.closeNotification).toHaveBeenCalledWith(
            offerTag(offer.conversation),
        );

        vi.advanceTimersByTime(OFFER_EXIT_MS);
        expect(store.getState().queue).toEqual([]);
        controller.stop();
    });
});

describe('offer expiry', () => {
    it('marks an offer expired when its deadline passes, then removes the card', () => {
        const { store, controller } = rig();

        controller.start();
        controller.handle(
            'chat.offered',
            makeOffer({
                expiresAt: new Date(Date.now() + 30_000).toISOString(),
                ttlSeconds: undefined,
            }),
        );
        vi.advanceTimersByTime(29_999);
        expect(store.getState().queue[0].state).toBe('open');

        vi.advanceTimersByTime(1);
        expect(store.getState().queue[0].state).toBe('expired');

        vi.advanceTimersByTime(OFFER_EXIT_MS);
        expect(store.getState().queue).toEqual([]);
        controller.stop();
    });

    it('re-plans for the next deadline when the earliest offer is gone', () => {
        const { store, controller } = rig();
        const soon = makeOffer({
            expiresAt: new Date(Date.now() + 10_000).toISOString(),
            ttlSeconds: undefined,
        });
        const later = makeOffer({
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            ttlSeconds: undefined,
        });

        controller.start();
        controller.handle('chat.offered', later);
        controller.handle('chat.offered', soon);
        vi.advanceTimersByTime(10_000);

        const stateOf = (ulid: string) =>
            store.getState().queue.find((i) => i.conversation === ulid)?.state;

        expect(stateOf(soon.conversation)).toBe('expired');
        expect(stateOf(later.conversation)).toBe('open');

        vi.advanceTimersByTime(50_000);
        expect(
            store
                .getState()
                .queue.find((i) => i.conversation === later.conversation)
                ?.state,
        ).toBe('expired');
        controller.stop();
    });
});

describe('other events', () => {
    it('conversation.updated reaches the store with the viewer', () => {
        const { store, controller } = rig();
        const mine = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
        });

        controller.handle('conversation.updated', { v: 1, conversation: mine });

        expect(store.getState().mine).toHaveLength(1);
    });

    it('a new unread message rings and notifies once, naming the visitor', () => {
        const { store, effects, controller } = rig();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
            lastMessagePreview: 'Are you there?',
            unseenByAgent: 0,
        });

        store.dispatch({ type: 'hydrate', queue: [], mine: [chat] });
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 1,
        });

        expect(store.getState().mine[0].unseenByAgent).toBe(1);
        expect(effects.playSound).toHaveBeenCalledWith('message');

        // The notification waits for the conversation update that carries the NEW words (the server sends it right after the counter):
        // the page still holds the previous message's preview at this moment.
        expect(effects.notify).not.toHaveBeenCalled();
        controller.handle('conversation.updated', {
            v: 1,
            conversation: {
                ...chat,
                unseenByAgent: 1,
                lastMessagePreview: 'Hello? Anyone?',
            },
        });
        expect(effects.notify).toHaveBeenCalledTimes(1);
        expect(effects.notify).toHaveBeenCalledWith(
            expect.objectContaining({
                title: 'New message from Vera Visitor',
                body: 'Hello? Anyone?',
                tag: `message-${chat.ulid}`,
            }),
        );

        const options = effects.notify.mock.calls[0][0];

        // Previews off: neither the visitor's name nor their words.
        expect(options.kind).toBe('message');
        expect(options.generic).toEqual({
            title: 'New message',
            body: 'Open the chat to read it.',
        });
        expect(JSON.stringify(options.generic)).not.toMatch(
            /Vera|Are you there/,
        );

        // Nothing is left waiting: the timer does not notify a second time.
        vi.advanceTimersByTime(MESSAGE_NOTICE_WAIT_MS * 2);
        expect(effects.notify).toHaveBeenCalledTimes(1);

        effects.playSound.mockClear();
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 1,
        });
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 0,
        });
        expect(effects.playSound).not.toHaveBeenCalled();
    });

    it('a message notification whose conversation update never comes is made after the wait, with what the page holds', () => {
        const { store, effects, controller } = rig();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
            lastMessagePreview: 'Are you there?',
            unseenByAgent: 0,
        });

        store.dispatch({ type: 'hydrate', queue: [], mine: [chat] });
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 1,
        });
        expect(effects.notify).not.toHaveBeenCalled();

        vi.advanceTimersByTime(MESSAGE_NOTICE_WAIT_MS);
        expect(effects.notify).toHaveBeenCalledWith(
            expect.objectContaining({ body: 'Are you there?' }),
        );
    });

    it('a chat the agent opens while the notification waits is not announced', () => {
        const { store, effects, viewing, controller } = rig();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
            unseenByAgent: 0,
        });

        store.dispatch({ type: 'hydrate', queue: [], mine: [chat] });
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 1,
        });
        viewing.current = chat.ulid;
        vi.advanceTimersByTime(MESSAGE_NOTICE_WAIT_MS);

        expect(effects.notify).not.toHaveBeenCalled();
    });

    it('stays quiet and clears the badge for the chat the agent is reading', () => {
        const { store, effects, viewing, controller } = rig();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
            unseenByAgent: 2,
        });

        store.dispatch({ type: 'hydrate', queue: [], mine: [chat] });
        viewing.current = chat.ulid;
        controller.handle('unread.updated', {
            v: 1,
            conversation: chat.ulid,
            unseen: 3,
        });

        expect(store.getState().mine[0].unseenByAgent).toBe(0);
        expect(effects.playSound).not.toHaveBeenCalled();
        expect(effects.notify).not.toHaveBeenCalled();
    });

    it('does not ring for a chat it has never heard of', () => {
        const { effects, controller } = rig();

        controller.handle('unread.updated', {
            v: 1,
            conversation: 'unknown',
            unseen: 1,
        });

        expect(effects.playSound).not.toHaveBeenCalled();
    });

    it('chat.assigned fetches the chat, adds it and tells the agent', async () => {
        const { api, store, effects, controller } = rig();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
        });

        api.conversation.mockResolvedValue(chat);
        controller.handle('chat.assigned', { v: 1, conversation: chat.ulid });
        await flush();

        expect(api.conversation).toHaveBeenCalledWith(chat.ulid);
        expect(store.getState().mine).toHaveLength(1);
        expect(effects.toast).toHaveBeenCalledWith(
            'info',
            'A chat was assigned to you',
            expect.objectContaining({ description: 'Vera Visitor' }),
        );
        expect(effects.playSound).toHaveBeenCalled();
    });

    describe('session.revoked', () => {
        const unauthenticated = new ApiError({
            status: 401,
            code: 'session_revoked',
            message: 'Your session has ended.',
        });

        it('signs out with the reason once the server confirms this session is over', async () => {
            const { api, effects, controller } = rig();

            api.presence.mockRejectedValue(unauthenticated);
            controller.handle('session.revoked', {
                v: 1,
                reason: 'deactivated',
            });
            expect(effects.signOut).not.toHaveBeenCalled();

            await flush();
            expect(api.presence).toHaveBeenCalledTimes(1);
            expect(effects.signOut).toHaveBeenCalledWith('deactivated');
        });

        it('also leaves when the role is gone (403 no_chat_access)', async () => {
            const { api, effects, controller } = rig();

            api.presence.mockRejectedValue(
                new ApiError({
                    status: 403,
                    code: 'no_chat_access',
                    message: 'No access.',
                }),
            );
            controller.handle('session.revoked', {
                v: 1,
                reason: 'role_removed',
            });
            await flush();

            expect(effects.signOut).toHaveBeenCalledWith('role_removed');
        });

        it('stays when the server says this session is fine (another session of the person was revoked)', async () => {
            const { api, effects, controller } = rig();

            api.presence.mockResolvedValue({
                userId: ME.id,
                status: 'online',
                isManual: false,
                lastSeenAt: null,
            });
            controller.handle('session.revoked', {
                v: 1,
                reason: 'auth_revoked',
            });
            await flush();

            expect(effects.signOut).not.toHaveBeenCalled();
        });

        it('proves nothing from a network error or a server error', async () => {
            const { api, effects, controller } = rig();

            api.presence.mockRejectedValueOnce(
                new ApiError({ status: 0, code: 'network', message: 'down' }),
            );
            api.presence.mockRejectedValueOnce(
                new ApiError({
                    status: 500,
                    code: 'server_error',
                    message: 'x',
                }),
            );
            controller.handle('session.revoked', {
                v: 1,
                reason: 'deactivated',
            });
            controller.handle('session.revoked', {
                v: 1,
                reason: 'deactivated',
            });
            await flush();

            expect(effects.signOut).not.toHaveBeenCalled();
        });
    });

    it('presence.changed updates the roster, and my own status when it is me', () => {
        const { store, controller } = rig();

        store.dispatch({
            type: 'rosterHere',
            members: [
                { id: 9, name: 'Omar', avatarUrl: null, status: 'online' },
            ],
        });
        controller.handle('presence.changed', {
            v: 1,
            userId: 9,
            status: 'away',
        });
        controller.handle('presence.changed', {
            v: 1,
            userId: ME.id,
            status: 'offline',
        });

        expect(store.getState().roster[0].status).toBe('away');
        expect(store.getState().presence).toBe('offline');
    });

    it('presence.changed is remembered for everybody (the agents page lists people who are not on the roster), with the time it was heard', () => {
        const { store, controller } = rig();

        controller.handle('presence.changed', {
            v: 1,
            userId: 42,
            status: 'offline',
        });

        expect(store.getState().seenPresence).toEqual({
            42: { status: 'offline', at: Date.now() },
        });
    });

    it('offline-ticket.created adds the ticket and announces it', () => {
        const { store, effects, controller } = rig({
            id: 1,
            isAdmin: true,
            isAgent: true,
        });
        const ticket = makeConversationStaff({ type: 'offline' });

        controller.handle('offline-ticket.created', {
            v: 1,
            conversation: ticket,
        });

        expect(store.getState().tickets.map((t) => t.ulid)).toEqual([
            ticket.ulid,
        ]);
        expect(effects.toast).toHaveBeenCalledWith(
            'info',
            'New offline ticket',
            expect.objectContaining({ description: 'Vera Visitor' }),
        );
    });
});

describe('REST snapshots', () => {
    it('sync reads the queue, active chats and tickets into the store', async () => {
        const { api, store, controller } = rig();
        const queued = makeConversationStaff();
        const active = makeActiveConversationStaff({
            assignedAgent: { id: ME.id, name: 'Me' },
        });
        const ticket = makeConversationStaff({ type: 'offline' });

        api.queue.mockResolvedValue([queued, ticket]);
        api.conversations.mockImplementation(
            async (query: { status?: string; type?: string }) =>
                query.type === 'live' && query.status === 'active'
                    ? [active]
                    : query.type === 'offline' && query.status === 'queued'
                      ? [ticket]
                      : [],
        );

        await controller.sync();

        expect(store.getState().queue.map((i) => i.conversation)).toEqual([
            queued.ulid,
        ]);
        expect(store.getState().mine.map((c) => c.ulid)).toEqual([active.ulid]);
        expect(store.getState().tickets.map((c) => c.ulid)).toEqual([
            ticket.ulid,
        ]);
        expect(store.getState().hydrated).toBe(true);
    });

    it('keeps finished chats a REST snapshot does not list', async () => {
        const { store, controller } = rig();
        const ended = makeActiveConversationStaff({
            status: 'ended',
            assignedAgent: { id: ME.id, name: 'Me' },
        });

        store.dispatch({ type: 'hydrate', queue: [], mine: [ended] });
        await controller.sync();

        expect(store.getState().mine.map((c) => c.ulid)).toEqual([ended.ulid]);
    });

    it('collapses overlapping syncs into one extra run', async () => {
        const { api, controller } = rig();
        let release: () => void = () => undefined;

        api.queue.mockImplementationOnce(
            () => new Promise((resolve) => (release = () => resolve([]))),
        );

        const first = controller.sync();

        void controller.sync();
        void controller.sync();
        release();
        await first;
        await flush();

        expect(api.queue).toHaveBeenCalledTimes(2);
    });

    it('does not undo a claim that finished while the snapshot was on its way', async () => {
        const { api, store, controller } = rig();
        const offer = makeOffer();
        const claimed = makeActiveConversationStaff({
            ulid: offer.conversation,
            assignedAgent: { id: ME.id, name: 'Me' },
        });
        let answer: (rows: unknown[]) => void = () => undefined;

        controller.handle('chat.offered', offer);
        api.queue.mockImplementationOnce(
            () => new Promise((resolve) => (answer = resolve)),
        );
        api.claim.mockResolvedValue(claimed);

        const syncing = controller.sync();

        await controller.claim(offer.conversation);
        // The slow answer still lists the chat as waiting, as the server saw it before the claim.
        answer([makeConversationStaff({ ulid: offer.conversation })]);
        await syncing;

        expect(store.getState().mine.map((c) => c.ulid)).toEqual([
            offer.conversation,
        ]);
        expect(store.getState().queue).toEqual([]);
    });

    it('survives a failing request and tries again on the next trigger', async () => {
        const { api, store, controller } = rig();

        api.queue.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );
        await controller.sync();

        expect(store.getState().hydrated).toBe(false);

        await controller.sync();
        expect(store.getState().hydrated).toBe(true);
    });

    it('queue.updated refetches once after a short pause, however many events arrive', async () => {
        const { api, controller } = rig();

        controller.handle('queue.updated', { v: 1, queued: 1 });
        controller.handle('queue.updated', { v: 1, queued: 2 });
        controller.handle('queue.updated', { v: 1, queued: 3 });
        expect(api.queue).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS);
        expect(api.queue).toHaveBeenCalledTimes(1);
    });
});

describe('polling fallback and reconnects', () => {
    it('polls every 15 seconds while the websocket is down, and stops once it is back', async () => {
        const { api, controller } = rig();

        controller.start();
        await flush();
        api.queue.mockClear();

        controller.setConnection('reconnecting');
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(api.queue).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(api.queue).toHaveBeenCalledTimes(2);

        api.queue.mockClear();
        controller.setConnection('connected');
        await flush();
        expect(api.queue).toHaveBeenCalledTimes(1); // the catch-up after the reconnect

        api.queue.mockClear();
        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
        expect(api.queue).not.toHaveBeenCalled();
        controller.stop();
    });

    it('polls forever when there is no websocket in this build', async () => {
        const { api, store, controller } = rig();

        controller.start();
        controller.setConnection('unavailable');
        await flush();
        api.queue.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);

        expect(api.queue).toHaveBeenCalledTimes(2);
        expect(store.getState().connection).toBe('unavailable');
        controller.stop();
    });

    it('a first connection (connecting -> connected) is not a reconnect', async () => {
        const { api, controller } = rig();

        controller.start();
        await flush();
        api.queue.mockClear();
        controller.setConnection('connected');
        await flush();

        expect(api.queue).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('wake() (tab visible again) catches up and beats the heartbeat', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        await flush();
        api.queue.mockClear();
        api.heartbeat.mockClear();

        controller.wake();
        await flush();

        expect(api.queue).toHaveBeenCalledTimes(1);
        expect(api.heartbeat).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('stop() cancels every timer', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        await flush();
        controller.stop();
        api.queue.mockClear();
        api.heartbeat.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);

        expect(api.queue).not.toHaveBeenCalled();
        expect(api.heartbeat).not.toHaveBeenCalled();
    });
});

describe('session keep-alive', () => {
    it('asks for the keep-alive page every 20 minutes, and stops with the controller', async () => {
        const { api, controller } = rig();

        controller.start();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS - 1);
        expect(api.keepAlive).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(1);
        expect(api.keepAlive).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(api.keepAlive).toHaveBeenCalledTimes(2);

        controller.stop();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS * 3);
        expect(api.keepAlive).toHaveBeenCalledTimes(2);
    });

    it('asks as soon as a tab that was hidden for more than 10 minutes is visible again', async () => {
        const { api, controller } = rig();

        controller.start();
        await flush();
        controller.sleep();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_AFTER_HIDDEN_MS + 1);
        controller.wake();
        await flush();

        expect(api.keepAlive).toHaveBeenCalledTimes(1);

        // Back for good: a second return with no absence in between asks for nothing.
        controller.wake();
        await flush();
        expect(api.keepAlive).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('does not ask after a short absence', async () => {
        const { api, controller } = rig();

        controller.start();
        await flush();
        controller.sleep();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_AFTER_HIDDEN_MS);
        controller.wake();
        await flush();

        expect(api.keepAlive).not.toHaveBeenCalled();
        controller.stop();
    });

    it('counts the absence from the first time the tab went hidden', async () => {
        const { api, controller } = rig();

        controller.start();
        await flush();
        controller.sleep();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_AFTER_HIDDEN_MS / 2);
        controller.sleep();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_AFTER_HIDDEN_MS / 2 + 1);
        controller.wake();
        await flush();

        expect(api.keepAlive).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('does nothing before start() and after stop()', async () => {
        const { api, controller } = rig();

        controller.sleep();
        await vi.advanceTimersByTimeAsync(KEEPALIVE_AFTER_HIDDEN_MS + 1);
        controller.wake();
        await flush();
        expect(api.keepAlive).not.toHaveBeenCalled();
    });

    it('signs out when the server says the session is over (401, 419) and ignores every other failure', async () => {
        const { api, effects, controller } = rig();

        controller.start();
        api.keepAlive.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'offline' }),
        );
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        api.keepAlive.mockRejectedValueOnce(
            new ApiError({
                status: 503,
                code: 'server_error',
                message: 'down',
            }),
        );
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(effects.signOut).not.toHaveBeenCalled();

        api.keepAlive.mockRejectedValueOnce(
            new ApiError({
                status: 401,
                code: 'session_revoked',
                message: 'Your session has ended.',
            }),
        );
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(effects.signOut).toHaveBeenCalledTimes(1);
        expect(effects.signOut).toHaveBeenCalledWith('auth_revoked');

        api.keepAlive.mockRejectedValueOnce(
            new ApiError({ status: 419, code: 'request_failed', message: 'x' }),
        );
        await vi.advanceTimersByTimeAsync(KEEPALIVE_INTERVAL_MS);
        expect(effects.signOut).toHaveBeenCalledTimes(2);
        controller.stop();
    });
});

describe('presence', () => {
    it('beats every 30 seconds while online or away, never while offline or unknown', async () => {
        const { api, store, controller } = rig();

        controller.start();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.heartbeat).not.toHaveBeenCalled();

        store.dispatch({ type: 'presence', status: 'online' });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.heartbeat).toHaveBeenCalledTimes(1);

        store.dispatch({ type: 'presence', status: 'away' });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.heartbeat).toHaveBeenCalledTimes(2);

        store.dispatch({ type: 'presence', status: 'offline' });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
        expect(api.heartbeat).toHaveBeenCalledTimes(2);
        controller.stop();
    });

    it('asks the server for the status when the page did not bring it, then beats at once', async () => {
        const { api, store, controller } = rig();

        api.presence.mockResolvedValue({
            userId: ME.id,
            status: 'online',
            isManual: true,
            lastSeenAt: null,
        });
        controller.start();
        await flush();

        expect(store.getState().presence).toBe('online');
        expect(api.heartbeat).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('setPresence is optimistic, saves, and beats right away when going online', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'offline' });
        api.setPresence.mockResolvedValue({
            userId: ME.id,
            status: 'online',
            isManual: true,
            lastSeenAt: null,
        });

        const pending = controller.setPresence('online');

        expect(store.getState().presence).toBe('online');
        expect(await pending).toBe(true);
        expect(api.setPresence).toHaveBeenCalledWith('online');
        expect(api.heartbeat).toHaveBeenCalledTimes(1);
    });

    it('setPresence rolls back and says why when the server refuses', async () => {
        const { api, store, effects, controller } = rig();

        store.dispatch({ type: 'presence', status: 'away' });
        api.setPresence.mockRejectedValue(
            new ApiError({
                status: 422,
                code: 'validation_failed',
                message: 'No.',
                details: { status: ['The status is invalid.'] },
            }),
        );

        expect(await controller.setPresence('online')).toBe(false);
        expect(store.getState().presence).toBe('away');
        expect(effects.toast).toHaveBeenCalledWith(
            'error',
            'The status is invalid.',
        );
    });

    it('accepts an empty answer to the status change as the confirmation', async () => {
        const { api, store, controller } = rig();

        api.setPresence.mockResolvedValue(null);

        expect(await controller.setPresence('away')).toBe(true);
        expect(store.getState().presence).toBe('away');
    });

    it('does not beat when going offline', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.setPresence.mockResolvedValue({
            userId: ME.id,
            status: 'offline',
            isManual: true,
            lastSeenAt: null,
        });
        await controller.setPresence('offline');

        expect(api.heartbeat).not.toHaveBeenCalled();
    });
});

describe('presence: visibility and resync', () => {
    it('says whether the tab is visible with every beat', async () => {
        const { api, store, visible, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        await flush();
        expect(api.heartbeat).toHaveBeenLastCalledWith(true);

        visible.current = false;
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.heartbeat).toHaveBeenLastCalledWith(false);

        visible.current = true;
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.heartbeat).toHaveBeenLastCalledWith(true);
        controller.stop();
    });

    it('beats at once, as visible, when the tab comes back to the foreground', async () => {
        const { api, store, visible, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        controller.sleep();
        visible.current = false;
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        api.heartbeat.mockClear();

        visible.current = true;
        controller.wake();
        await flush();

        expect(api.heartbeat).toHaveBeenCalledTimes(1);
        expect(api.heartbeat).toHaveBeenCalledWith(true);
        // A short absence is not worth asking the server what happened.
        expect(api.presence).not.toHaveBeenCalled();
        controller.stop();
    });

    it('asks the server for the status after a long absence, once the beat is out', async () => {
        const { api, store, visible, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockResolvedValue({
            userId: ME.id,
            status: 'offline',
            isManual: false,
            lastSeenAt: null,
        });
        controller.start();
        controller.sleep();
        visible.current = false;
        await vi.advanceTimersByTimeAsync(PRESENCE_RESYNC_AFTER_MS + 1);
        api.heartbeat.mockClear();
        api.presence.mockClear();

        visible.current = true;
        controller.wake();
        await flush();

        expect(api.heartbeat).toHaveBeenCalledWith(true);
        expect(api.presence).toHaveBeenCalledTimes(1);
        expect(store.getState().presence).toBe('offline');
        controller.stop();
    });

    it('re-reads the status after a long gap between two beats (the timers were suspended), not after a normal one', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockResolvedValue({
            userId: ME.id,
            status: 'away',
            isManual: false,
            lastSeenAt: null,
        });
        controller.start();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
        expect(api.presence).not.toHaveBeenCalled();

        // A laptop that slept: the clock jumps, the next tick fires late.
        vi.setSystemTime(Date.now() + PRESENCE_RESYNC_AFTER_MS * 4);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

        expect(api.presence).toHaveBeenCalledTimes(1);
        expect(store.getState().presence).toBe('away');
        controller.stop();
    });

    it('does not apply an answer that is older than my own change', async () => {
        const { api, store, visible, controller } = rig();
        let answer: (value: unknown) => void = () => undefined;

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockReturnValue(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        api.setPresence.mockResolvedValue({
            userId: ME.id,
            status: 'away',
            isManual: true,
            lastSeenAt: null,
        });
        controller.start();
        controller.sleep();
        visible.current = false;
        await vi.advanceTimersByTimeAsync(PRESENCE_RESYNC_AFTER_MS + 1);
        visible.current = true;
        controller.wake();
        await flush();

        await controller.setPresence('away');
        answer({
            userId: ME.id,
            status: 'online',
            isManual: false,
            lastSeenAt: null,
        });
        await flush();

        expect(store.getState().presence).toBe('away');
        controller.stop();
    });

    it('an own presence.changed event wins over an answer that was already on its way', async () => {
        const { api, store, controller } = rig();
        let answer: (value: unknown) => void = () => undefined;

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockReturnValue(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        controller.start();
        vi.setSystemTime(Date.now() + PRESENCE_RESYNC_AFTER_MS * 4);
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

        controller.handle('presence.changed', {
            v: 1,
            userId: ME.id,
            status: 'away',
        });
        answer({
            userId: ME.id,
            status: 'online',
            isManual: false,
            lastSeenAt: null,
        });
        await flush();

        expect(store.getState().presence).toBe('away');
        controller.stop();
    });
});

describe('presence: an agent the server forgot (an outage, a gap longer than its window)', () => {
    const own = (status: 'online' | 'away' | 'offline') => ({
        userId: ME.id,
        status,
        isManual: false,
        lastSeenAt: null,
    });
    const down = () =>
        new ApiError({ status: 0, code: 'network', message: 'offline' });

    it('follows the status a beat answers at once (no second request)', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.heartbeat.mockResolvedValue({ status: 'offline', isManual: false });
        controller.start();
        await flush();

        expect(store.getState().presence).toBe('offline');
        expect(api.presence).not.toHaveBeenCalled();

        // Offline: no more beats.
        api.heartbeat.mockClear();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 2);
        expect(api.heartbeat).not.toHaveBeenCalled();
        controller.stop();
    });

    it('applies an automatic away the server announces in a beat, and an empty or unknown answer changes nothing', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        await flush();

        for (const answer of [null, undefined, {}, { status: 'busy' }, 'ok']) {
            api.heartbeat.mockResolvedValueOnce(answer);
            await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
            expect(store.getState().presence).toBe('online');
        }

        api.heartbeat.mockResolvedValueOnce({
            status: 'away',
            isManual: false,
        });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(store.getState().presence).toBe('away');
        controller.stop();
    });

    it("drops a beat's answer that is older than the agent's own change", async () => {
        const { api, store, controller } = rig();
        let answer: (value: unknown) => void = () => undefined;

        store.dispatch({ type: 'presence', status: 'online' });
        api.heartbeat.mockReturnValueOnce(
            new Promise((resolve) => {
                answer = resolve;
            }),
        );
        api.setPresence.mockResolvedValue(own('away'));
        controller.start();
        await flush();

        await controller.setPresence('away');
        answer({ status: 'online', isManual: false });
        await flush();

        expect(store.getState().presence).toBe('away');
        controller.stop();
    });

    it('reads the status once a beat succeeds after failures (the old backend answers 204)', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockResolvedValue(own('offline'));
        controller.start();
        await flush();
        api.heartbeat.mockClear();
        api.presence.mockClear();

        api.heartbeat.mockRejectedValueOnce(down());
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        // One miss is not worth a question; the selector still says what it said.
        expect(api.presence).not.toHaveBeenCalled();
        expect(store.getState().presence).toBe('online');

        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.presence).toHaveBeenCalledTimes(1);
        expect(store.getState().presence).toBe('offline');
        controller.stop();
    });

    it('a beat that succeeds after failures and answers the status needs no second request', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        controller.start();
        await flush();
        api.presence.mockClear();

        api.heartbeat.mockRejectedValueOnce(down());
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        api.heartbeat.mockResolvedValueOnce({
            status: 'offline',
            isManual: false,
        });
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);

        expect(store.getState().presence).toBe('offline');
        expect(api.presence).not.toHaveBeenCalled();
        controller.stop();
    });

    it(`reads the status after ${PRESENCE_RESYNC_AFTER_FAILED_BEATS} failed beats in a row, once, not on every further miss`, async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockResolvedValue(own('offline'));
        api.heartbeat.mockRejectedValue(down());
        controller.start();
        await flush();
        api.presence.mockClear();

        // The start() beat was the first miss.
        for (let i = 1; i < PRESENCE_RESYNC_AFTER_FAILED_BEATS - 1; i++) {
            await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
            expect(api.presence).not.toHaveBeenCalled();
        }

        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS);
        expect(api.presence).toHaveBeenCalledTimes(1);
        expect(store.getState().presence).toBe('offline');

        // Offline now: nothing more is sent or asked.
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 3);
        expect(api.presence).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('a status the server cannot be asked for stays as it is (the next success or event settles it)', async () => {
        const { api, store, controller } = rig();

        store.dispatch({ type: 'presence', status: 'online' });
        api.presence.mockRejectedValue(down());
        api.heartbeat.mockRejectedValue(down());
        controller.start();
        await vi.advanceTimersByTimeAsync(HEARTBEAT_INTERVAL_MS * 5);

        expect(store.getState().presence).toBe('online');
        controller.stop();
    });

    describe('after a reconnect and when the network comes back', () => {
        it('a RECONNECT of the websocket beats and re-reads the status; the first connection does not', async () => {
            const { api, store, controller } = rig();

            store.dispatch({ type: 'presence', status: 'online' });
            api.presence.mockResolvedValue(own('offline'));
            controller.start();
            await flush();
            api.heartbeat.mockClear();
            api.presence.mockClear();

            controller.setConnection('connecting');
            controller.setConnection('connected');
            await flush();
            expect(api.presence).not.toHaveBeenCalled();
            expect(api.heartbeat).not.toHaveBeenCalled();

            controller.setConnection('reconnecting');
            controller.setConnection('connected');
            await flush();

            expect(api.heartbeat).toHaveBeenCalledTimes(1);
            expect(api.presence).toHaveBeenCalledTimes(1);
            expect(store.getState().presence).toBe('offline');
            controller.stop();
        });

        it('a reconnect whose beat answers the status needs no second request', async () => {
            const { api, store, controller } = rig();

            store.dispatch({ type: 'presence', status: 'online' });
            controller.start();
            controller.setConnection('connected');
            await flush();
            api.presence.mockClear();

            controller.setConnection('disconnected');
            api.heartbeat.mockResolvedValueOnce({
                status: 'away',
                isManual: false,
            });
            controller.setConnection('connected');
            await flush();

            expect(store.getState().presence).toBe('away');
            expect(api.presence).not.toHaveBeenCalled();
            controller.stop();
        });

        it('the browser online event re-reads the lists and the status, even when the tab is in the background', async () => {
            const { api, store, visible, controller } = rig();

            store.dispatch({ type: 'presence', status: 'online' });
            api.presence.mockResolvedValue(own('offline'));
            controller.start();
            await flush();
            api.heartbeat.mockClear();
            api.presence.mockClear();
            api.queue.mockClear();

            visible.current = false;
            controller.online();
            await flush();

            expect(api.queue).toHaveBeenCalled();
            expect(api.heartbeat).toHaveBeenCalledWith(false);
            expect(api.presence).toHaveBeenCalledTimes(1);
            expect(store.getState().presence).toBe('offline');
            controller.stop();
        });

        it('only reads the status for an agent who is offline or unknown (nothing to beat)', async () => {
            const { api, store, controller } = rig();

            store.dispatch({ type: 'presence', status: 'offline' });
            api.presence.mockResolvedValue(own('online'));
            controller.start();
            await flush();
            api.presence.mockClear();

            controller.online();
            await flush();

            expect(api.heartbeat).not.toHaveBeenCalled();
            expect(api.presence).toHaveBeenCalledTimes(1);
            expect(store.getState().presence).toBe('online');
            controller.stop();
        });

        it('does nothing before start() or after stop()', async () => {
            const { api, controller } = rig();

            controller.online();
            controller.start();
            controller.stop();
            api.queue.mockClear();
            api.presence.mockClear();
            controller.online();
            await flush();

            expect(api.queue).not.toHaveBeenCalled();
            expect(api.presence).not.toHaveBeenCalled();
        });
    });
});

describe('timer limits', () => {
    it('does not fire early for a deadline further away than a timer can wait', () => {
        const { store, controller } = rig();

        controller.start();
        controller.handle(
            'chat.offered',
            makeOffer({
                expiresAt: new Date(
                    Date.now() + 40 * 24 * 3_600_000,
                ).toISOString(),
                ttlSeconds: undefined,
            }),
        );
        vi.advanceTimersByTime(3_000_000_000);

        expect(store.getState().queue[0].state).toBe('open');
        controller.stop();
    });
});

describe('a chat transferred to this agent while a refresh is already on its way', () => {
    it('still gets its offer card: the refresh that follows the event brings it', async () => {
        const { store, api, controller } = rig();
        const chat = makeConversationStaff({
            status: 'queued',
            type: 'live',
            agent: null,
            assignedAgent: null,
            queueExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        });
        let release: (rows: unknown[]) => void = () => undefined;

        api.conversation.mockResolvedValue(chat);

        // Let the start-up snapshot finish, so the slow one below is the only refresh in flight.
        controller.start();
        await flush();
        await flush();

        // This snapshot is slow, and was asked for before the transfer happened (it does not contain the chat) ...
        api.queue.mockReset();
        api.queue.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        );
        // ... every later one does.
        api.queue.mockResolvedValue([chat]);

        const first = controller.sync();

        // The transfer's pushes arrive while that snapshot is out: `chat.assigned` (the colleague is told) and the list refresh.
        controller.handle('chat.assigned', { v: 1, conversation: chat.ulid });
        await flush();
        controller.handle('conversation.updated', { v: 1, conversation: chat });
        release([]);
        await first;
        await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 10);
        await flush();

        expect(store.getState().queue.map((item) => item.conversation)).toEqual(
            [chat.ulid],
        );
        controller.stop();
    });

    it('asks nobody again for a chat the agent already has a card for, nor as an administrator', async () => {
        const { api, controller } = rig({ ...ME, isAdmin: true });
        const chat = makeConversationStaff({ status: 'queued', type: 'live' });

        controller.start();
        await flush();
        api.queue.mockClear();

        controller.handle('conversation.updated', { v: 1, conversation: chat });
        await vi.advanceTimersByTimeAsync(SYNC_DEBOUNCE_MS + 10);

        expect(api.queue).not.toHaveBeenCalled();
        controller.stop();
    });
});
