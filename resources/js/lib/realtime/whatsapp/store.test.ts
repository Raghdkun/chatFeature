import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import {
    byRecency,
    createWaLiveStore,
    EMPTY_WA_STATE,
    selectUnreadChats,
    selectUnreadTotal,
    waLiveReducer,
    type WaLiveAction,
    type WaLiveState,
} from '@/lib/realtime/whatsapp/store';
import {
    makeWaChat,
    makeWaMessage,
    makeWaReply,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';

const run = (state: WaLiveState, ...actions: WaLiveAction[]): WaLiveState =>
    actions.reduce(waLiveReducer, state);

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

describe('chats', () => {
    it('applies a snapshot once and ignores an identical one', () => {
        const chat = makeWaChat({ unreadByAdmin: 2 });
        const first = run(EMPTY_WA_STATE, {
            type: 'chatsLoaded',
            chats: [chat],
        });

        expect(first.hydrated).toBe(true);
        expect(first.chats[chat.ulid]).toEqual(chat);
        expect(
            waLiveReducer(first, { type: 'chatsLoaded', chats: [chat] }),
        ).toBe(first);
    });

    it('an empty snapshot still means "known": nothing unread, not unknown', () => {
        const state = run(EMPTY_WA_STATE, { type: 'chatsLoaded', chats: [] });

        expect(state.hydrated).toBe(true);
        expect(selectUnreadTotal(state)).toBe(0);
    });

    it('lets an event change a chat and ignores a repeat of it', () => {
        const chat = makeWaChat({ unreadByAdmin: 1 });
        const changed = {
            ...chat,
            unreadByAdmin: 3,
            lastMessagePreview: 'new',
        };
        const once = run(
            EMPTY_WA_STATE,
            { type: 'chatsLoaded', chats: [chat] },
            { type: 'chatChanged', chat: changed },
        );

        expect(once.chats[chat.ulid].unreadByAdmin).toBe(3);
        expect(
            waLiveReducer(once, { type: 'chatChanged', chat: changed }),
        ).toBe(once);
    });

    it('never lets an older snapshot overwrite what an event brought while the request was in flight', () => {
        const chat = makeWaChat({ unreadByAdmin: 0 });
        const since = EMPTY_WA_STATE.clock;
        const state = run(
            EMPTY_WA_STATE,
            // The event arrives while the REST request (made at `since`) is still out ...
            { type: 'chatChanged', chat: { ...chat, unreadByAdmin: 4 } },
            // ... and the older picture it carries comes in afterwards.
            {
                type: 'chatsLoaded',
                chats: [{ ...chat, unreadByAdmin: 1 }],
                since,
            },
        );

        expect(state.chats[chat.ulid].unreadByAdmin).toBe(4);
    });

    it('zeroes a chat the unread snapshot no longer lists (read in another tab or on the phone)', () => {
        const stays = makeWaChat({ unreadByAdmin: 2 });
        const read = makeWaChat({ unreadByAdmin: 5 });
        const state = run(
            EMPTY_WA_STATE,
            { type: 'chatsLoaded', chats: [stays, read] },
            { type: 'chatsLoaded', chats: [stays], unreadOnly: true },
        );

        expect(state.chats[read.ulid].unreadByAdmin).toBe(0);
        expect(state.chats[stays.ulid].unreadByAdmin).toBe(2);
    });

    it('does not zero a chat an event touched after the snapshot was requested', () => {
        const chat = makeWaChat({ unreadByAdmin: 1 });
        const base = run(EMPTY_WA_STATE, {
            type: 'chatsLoaded',
            chats: [chat],
        });
        const since = base.clock;
        const state = run(
            base,
            { type: 'chatChanged', chat: { ...chat, unreadByAdmin: 2 } },
            { type: 'chatsLoaded', chats: [], since, unreadOnly: true },
        );

        expect(state.chats[chat.ulid].unreadByAdmin).toBe(2);
    });

    it('reads a chat: its unread count drops to zero and only then', () => {
        const chat = makeWaChat({ unreadByAdmin: 2 });
        const loaded = run(EMPTY_WA_STATE, {
            type: 'chatsLoaded',
            chats: [chat],
        });
        const read = waLiveReducer(loaded, {
            type: 'chatRead',
            ulid: chat.ulid,
        });

        expect(read.chats[chat.ulid].unreadByAdmin).toBe(0);
        expect(waLiveReducer(read, { type: 'chatRead', ulid: chat.ulid })).toBe(
            read,
        );
        expect(waLiveReducer(read, { type: 'chatRead', ulid: 'unknown' })).toBe(
            read,
        );
    });
});

describe('unread counts', () => {
    it('sums the unread messages of open chats; an archived chat is out of sight and out of the count', () => {
        const state = run(EMPTY_WA_STATE, {
            type: 'chatsLoaded',
            chats: [
                makeWaChat({ unreadByAdmin: 2 }),
                makeWaChat({ unreadByAdmin: 3 }),
                makeWaChat({ unreadByAdmin: 9, status: 'archived' }),
                makeWaChat({ unreadByAdmin: 0 }),
            ],
        });

        expect(selectUnreadTotal(state)).toBe(5);
        expect(selectUnreadChats(state)).toBe(2);
    });

    it('orders chats by the last message, newest first, with the id as the tie-break', () => {
        const old = makeWaChat({ lastMessageAt: '2026-11-20T10:00:00.000Z' });
        const recent = makeWaChat({
            lastMessageAt: '2026-11-20T12:00:00.000Z',
        });
        const tied = makeWaChat({ lastMessageAt: '2026-11-20T12:00:00.000Z' });
        const never = makeWaChat({
            lastMessageAt: null,
            createdAt: '2026-11-19T00:00:00.000Z',
        });

        expect(
            [old, never, recent, tied].sort(byRecency).map((c) => c.ulid),
        ).toEqual([tied.ulid, recent.ulid, old.ulid, never.ulid]);
    });
});

describe('transcripts', () => {
    const chat = fakeUlid(6001);

    it('stores what a page loaded and merges the rest idempotently', () => {
        const a = makeWaMessage({ chat });
        const b = makeWaMessage({ chat });
        const state = run(
            EMPTY_WA_STATE,
            { type: 'messagesLoaded', chat, messages: [a] },
            { type: 'messagesLoaded', chat, messages: [a, b] },
        );

        expect(state.messages[chat].map((m) => m.ulid)).toEqual([
            a.ulid,
            b.ulid,
        ]);
        expect(
            waLiveReducer(state, {
                type: 'messagesLoaded',
                chat,
                messages: [a, b],
            }),
        ).toBe(state);
    });

    it('creates the transcript of a chat the first time it is loaded, even when the page was empty', () => {
        const state = run(EMPTY_WA_STATE, {
            type: 'messagesLoaded',
            chat,
            messages: [],
        });

        expect(state.messages[chat]).toEqual([]);
    });

    it('drops an event for a chat that was never opened (the page reads it when it opens)', () => {
        const state = run(EMPTY_WA_STATE, {
            type: 'messageChanged',
            message: makeWaMessage({ chat }),
        });

        expect(state).toBe(EMPTY_WA_STATE);
    });

    it('moves a status forward only, whatever order the acks arrive in', () => {
        const sent = makeWaReply({ chat, status: 'sent' });
        const opened = run(EMPTY_WA_STATE, {
            type: 'messagesLoaded',
            chat,
            messages: [sent],
        });
        const read = waLiveReducer(opened, {
            type: 'messageChanged',
            message: { ...sent, status: 'read' },
        });
        const late = waLiveReducer(read, {
            type: 'messageChanged',
            message: { ...sent, status: 'delivered' },
        });

        expect(read.messages[chat][0].status).toBe('read');
        expect(late).toBe(read);
    });
});

describe('a failed reply that the server put back in its queue', () => {
    const chat = fakeUlid(6001);
    const failedReply = () =>
        makeWaReply({ chat, status: 'failed', error: 'not queued' });
    const opened = (messages = [failedReply()]) =>
        run(EMPTY_WA_STATE, { type: 'messagesLoaded', chat, messages });

    it('steps back from failed to pending for the answer to a retry, and then moves forward again as usual', () => {
        const failed = failedReply();
        const state = opened([failed]);

        // An EVENT never moves a failed message (the status is final for events) ...
        expect(
            waLiveReducer(state, {
                type: 'messageChanged',
                message: { ...failed, status: 'pending', error: null },
            }).messages[chat][0].status,
        ).toBe('failed');

        // ... only the answer to our own retry does.
        const queued = waLiveReducer(state, {
            type: 'messageRequeued',
            message: { ...failed, status: 'pending', error: null },
        });

        expect(queued.messages[chat][0]).toMatchObject({
            status: 'pending',
            error: null,
        });

        const sent = waLiveReducer(queued, {
            type: 'messageChanged',
            message: { ...failed, status: 'sent', error: null },
        });

        expect(sent.messages[chat][0].status).toBe('sent');
    });

    it('does nothing for anything else: an unknown message, one that is not failed, a customer message, a non-pending answer', () => {
        const failed = failedReply();
        const sent = makeWaReply({ chat, status: 'sent' });
        const incoming = makeWaMessage({ chat });
        const state = opened([failed, sent, incoming]);
        const requeue = (message: ReturnType<typeof makeWaReply>) =>
            waLiveReducer(state, { type: 'messageRequeued', message });

        expect(requeue(makeWaReply({ chat, status: 'pending' }))).toBe(state);
        expect(requeue({ ...sent, status: 'pending' })).toBe(state);
        expect(requeue({ ...incoming, status: 'pending' })).toBe(state);
        expect(requeue({ ...failed, status: 'sent' })).toBe(state);
        expect(
            waLiveReducer(EMPTY_WA_STATE, {
                type: 'messageRequeued',
                message: { ...failed, status: 'pending' },
            }),
        ).toBe(EMPTY_WA_STATE);
    });
});

describe('sessions', () => {
    it('lists, changes and removes sessions; a full list is the truth', () => {
        const a = makeWaSession({ status: 'starting' });
        const b = makeWaSession();
        const loaded = run(EMPTY_WA_STATE, {
            type: 'sessionsLoaded',
            sessions: [a, b],
        });

        expect(loaded.sessionsHydrated).toBe(true);

        const ready = waLiveReducer(loaded, {
            type: 'sessionChanged',
            session: { ...a, status: 'ready' },
        });

        expect(ready.sessions[a.ulid].status).toBe('ready');
        expect(
            waLiveReducer(ready, {
                type: 'sessionChanged',
                session: { ...a, status: 'ready' },
            }),
        ).toBe(ready);

        const relisted = waLiveReducer(ready, {
            type: 'sessionsLoaded',
            sessions: [{ ...a, status: 'ready' }],
        });

        expect(Object.keys(relisted.sessions)).toEqual([a.ulid]);
        expect(
            Object.keys(
                waLiveReducer(relisted, {
                    type: 'sessionRemoved',
                    ulid: a.ulid,
                }).sessions,
            ),
        ).toEqual([]);
    });

    it('keeps a session an event created while the list was in flight, and its live status', () => {
        const a = makeWaSession({ status: 'starting' });
        const since = EMPTY_WA_STATE.clock;
        const created = makeWaSession();
        const state = run(
            EMPTY_WA_STATE,
            { type: 'sessionChanged', session: { ...a, status: 'ready' } },
            { type: 'sessionChanged', session: created },
            { type: 'sessionsLoaded', sessions: [a], since },
        );

        expect(state.sessions[a.ulid].status).toBe('ready');
        expect(state.sessions[created.ulid]).toEqual(created);
    });
});

describe('connection and the store', () => {
    it('tracks the connection and tells subscribers only about real changes', () => {
        const store = createWaLiveStore();
        let calls = 0;
        const stop = store.subscribe(() => (calls += 1));

        store.dispatch({ type: 'connection', status: 'connected' });
        store.dispatch({ type: 'connection', status: 'connected' });
        store.dispatch({ type: 'connection', status: 'reconnecting' });
        stop();
        store.dispatch({ type: 'connection', status: 'connected' });

        expect(calls).toBe(2);
        expect(store.getState().connection).toBe('connected');
    });
});
