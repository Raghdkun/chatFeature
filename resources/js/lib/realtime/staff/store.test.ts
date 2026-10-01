import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    fakeTime,
    makeActiveConversationStaff,
    makeConversationStaff,
    makeOffer,
    resetFixtures,
} from '@/lib/chat/fixtures';
import {
    createInboxStore,
    EMPTY_INBOX,
    inboxReducer,
    isStaleUpdate,
    nextExpiryMs,
    selectAttentionCount,
    selectOpenQueueCount,
    selectTicketCount,
    selectUnseenTotal,
    type InboxAction,
    type InboxState,
    type Viewer,
} from '@/lib/realtime/staff/store';

const me: Viewer = { id: 7, isAdmin: false };
const admin: Viewer = { id: 1, isAdmin: true };
const NOW = Date.parse(fakeTime(0));

const run = (state: InboxState, ...actions: InboxAction[]) =>
    actions.reduce(inboxReducer, state);

beforeEach(() => resetFixtures());

describe('hydrate', () => {
    it('turns queued conversations into open queue items, oldest first, and marks the lists as known', () => {
        const older = makeConversationStaff({ createdAt: fakeTime(-60) });
        const newer = makeConversationStaff({ createdAt: fakeTime(-10) });
        const state = run(EMPTY_INBOX, {
            type: 'hydrate',
            queue: [newer, older],
            mine: [],
        });

        expect(state.hydrated).toBe(true);
        expect(state.queue.map((item) => item.conversation)).toEqual([
            older.ulid,
            newer.ulid,
        ]);
        expect(state.queue[0]).toMatchObject({
            state: 'open',
            expiresAt: null,
            visitorName: 'Vera Visitor',
            waitingSince: older.createdAt,
        });
    });

    it('keeps the deadline of an offer when a snapshot of the same chat arrives', () => {
        const offer = makeOffer({ expiresAt: fakeTime(90) });
        const snapshot = makeConversationStaff({ ulid: offer.conversation });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'hydrate', queue: [snapshot], mine: [] },
        );

        expect(state.queue).toHaveLength(1);
        expect(state.queue[0].expiresAt).toBe(fakeTime(90));
        expect(state.queue[0].wave).toBe(1);
    });

    it('drops queue items the server no longer lists, but lets a card that is leaving finish', () => {
        const gone = makeOffer();
        const leaving = makeOffer();
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer: gone, nowMs: NOW },
            { type: 'offered', offer: leaving, nowMs: NOW },
            { type: 'taken', conversation: leaving.conversation, by: 'Sam' },
            { type: 'hydrate', queue: [], mine: [] },
        );

        expect(state.queue.map((item) => item.conversation)).toEqual([
            leaving.conversation,
        ]);
    });

    it('sorts my chats by last activity and can keep finished chats a partial snapshot did not list', () => {
        const quiet = makeActiveConversationStaff({
            lastMessageAt: fakeTime(10),
        });
        const busy = makeActiveConversationStaff({
            lastMessageAt: fakeTime(50),
        });
        const finished = makeActiveConversationStaff({
            status: 'ended',
            lastMessageAt: fakeTime(30),
        });
        const first = run(EMPTY_INBOX, {
            type: 'hydrate',
            queue: [],
            mine: [quiet, busy, finished],
        });

        expect(first.mine.map((c) => c.ulid)).toEqual([
            busy.ulid,
            finished.ulid,
            quiet.ulid,
        ]);

        const refreshed = run(first, {
            type: 'hydrate',
            queue: [],
            mine: [quiet],
            keepFinished: true,
        });

        expect(refreshed.mine.map((c) => c.ulid)).toEqual([
            finished.ulid,
            quiet.ulid,
        ]);
        expect(
            run(first, { type: 'hydrate', queue: [], mine: [quiet] }).mine,
        ).toHaveLength(1);
    });

    it('a tickets-only snapshot does not claim the queue is known', () => {
        const state = run(EMPTY_INBOX, {
            type: 'hydrate',
            tickets: [makeConversationStaff({ type: 'offline' })],
        });

        expect(state.hydrated).toBe(false);
        expect(state.tickets).toHaveLength(1);
    });
});

describe('offers', () => {
    it('adds an offer card with its deadline and details', () => {
        const offer = makeOffer({
            visitor: { name: 'Mina', verified: true },
            preview: 'Hi there',
            wave: 2,
        });
        const { queue } = run(EMPTY_INBOX, {
            type: 'offered',
            offer,
            nowMs: NOW,
        });

        expect(queue).toEqual([
            expect.objectContaining({
                conversation: offer.conversation,
                visitorName: 'Mina',
                verified: true,
                preview: 'Hi there',
                wave: 2,
                expiresAt: offer.expiresAt,
                state: 'open',
                waitingSince: new Date(NOW).toISOString(),
            }),
        ]);
    });

    it('is idempotent: the same offer twice is one card', () => {
        const offer = makeOffer();
        const once = run(EMPTY_INBOX, { type: 'offered', offer, nowMs: NOW });
        const twice = run(once, { type: 'offered', offer, nowMs: NOW + 5000 });

        expect(twice.queue).toHaveLength(1);
        // It keeps counting from the first time it was seen.
        expect(twice.queue[0].waitingSince).toBe(once.queue[0].waitingSince);
    });

    it('does not resurrect a card that a colleague already took', () => {
        const offer = makeOffer();
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'taken', conversation: offer.conversation, by: 'Sam' },
            { type: 'offered', offer, nowMs: NOW },
        );

        expect(state.queue[0].state).toBe('taken');
    });

    it('marks a card taken (with who) and removes it on dismiss; unknown chats are ignored', () => {
        const offer = makeOffer();
        const taken = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'taken', conversation: offer.conversation, by: 'Sam' },
        );

        expect(taken.queue[0]).toMatchObject({
            state: 'taken',
            takenBy: 'Sam',
        });
        expect(
            run(taken, { type: 'dismiss', conversation: offer.conversation })
                .queue,
        ).toEqual([]);
        expect(
            run(EMPTY_INBOX, { type: 'taken', conversation: 'nope', by: 'X' }),
        ).toBe(EMPTY_INBOX);
    });

    it('expires only the offers whose deadline has passed', () => {
        const soon = makeOffer({
            expiresAt: fakeTime(30),
            ttlSeconds: undefined,
        });
        const later = makeOffer({
            expiresAt: fakeTime(90),
            ttlSeconds: undefined,
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer: soon, nowMs: NOW },
            { type: 'offered', offer: later, nowMs: NOW },
        );

        expect(nextExpiryMs(state)).toBe(Date.parse(fakeTime(30)));

        const expired = run(state, {
            type: 'expire',
            nowMs: Date.parse(fakeTime(30)),
        });

        expect(expired.queue.map((item) => item.state)).toEqual([
            'expired',
            'open',
        ]);
        expect(nextExpiryMs(expired)).toBe(Date.parse(fakeTime(90)));
        expect(run(expired, { type: 'expire', nowMs: NOW })).toBe(expired);
    });

    it('counts only open offers', () => {
        const a = makeOffer();
        const b = makeOffer();
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer: a, nowMs: NOW },
            { type: 'offered', offer: b, nowMs: NOW },
            { type: 'taken', conversation: a.conversation, by: 'Sam' },
        );

        expect(selectOpenQueueCount(state)).toBe(1);
    });
});

describe('conversationUpdated', () => {
    it('moves an accepted chat from the queue to my chats', () => {
        const offer = makeOffer();
        const active = makeActiveConversationStaff({
            ulid: offer.conversation,
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'conversationUpdated', conversation: active, viewer: me },
        );

        expect(state.queue).toEqual([]);
        expect(state.mine.map((c) => c.ulid)).toEqual([active.ulid]);
    });

    it('shows who won when a colleague accepted and the taken event is late', () => {
        const offer = makeOffer();
        const theirs = makeActiveConversationStaff({
            ulid: offer.conversation,
            assignedAgent: { id: 99, name: 'Sam' },
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'conversationUpdated', conversation: theirs, viewer: me },
        );

        expect(state.queue[0]).toMatchObject({
            state: 'taken',
            takenBy: 'Sam',
        });
        expect(state.mine).toEqual([]);
    });

    it('drops a missed or closed chat from the queue', () => {
        const offer = makeOffer();
        const missed = makeConversationStaff({
            ulid: offer.conversation,
            status: 'missed',
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'conversationUpdated', conversation: missed, viewer: me },
        );

        expect(state.queue).toEqual([]);
        expect(state.mine).toEqual([]);
    });

    it('removes a chat transferred away from me without putting it in my queue', () => {
        const mine = makeActiveConversationStaff({
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const away = makeConversationStaff({
            ...mine,
            status: 'queued',
            assignedAgent: null,
            agent: null,
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'hydrate', queue: [], mine: [mine] },
            { type: 'conversationUpdated', conversation: away, viewer: me },
        );

        expect(state.mine).toEqual([]);
        expect(state.queue).toEqual([]);
    });

    it('keeps an offered chat in the queue when it is updated, and shows a re-queued chat to an admin', () => {
        const offer = makeOffer();
        const queued = makeConversationStaff({
            ulid: offer.conversation,
            lastMessagePreview: 'Updated preview',
        });
        const offered = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'conversationUpdated', conversation: queued, viewer: me },
        );

        expect(offered.queue).toHaveLength(1);
        expect(offered.queue[0]).toMatchObject({
            preview: 'Updated preview',
            expiresAt: offer.expiresAt,
        });

        const requeued = makeConversationStaff({ status: 'queued' });

        expect(
            run(EMPTY_INBOX, {
                type: 'conversationUpdated',
                conversation: requeued,
                viewer: admin,
            }).queue.map((item) => item.conversation),
        ).toEqual([requeued.ulid]);
    });

    it("lets an admin see everyone's chats, but an agent only their own", () => {
        const others = makeActiveConversationStaff({
            assignedAgent: { id: 99, name: 'Sam' },
        });

        expect(
            run(EMPTY_INBOX, {
                type: 'conversationUpdated',
                conversation: others,
                viewer: admin,
            }).mine,
        ).toHaveLength(1);
        expect(
            run(EMPTY_INBOX, {
                type: 'conversationUpdated',
                conversation: others,
                viewer: me,
            }).mine,
        ).toHaveLength(0);
    });

    it('keeps ended and closed chats in the list (read-only)', () => {
        const ended = makeActiveConversationStaff({
            status: 'ended',
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const state = run(EMPTY_INBOX, {
            type: 'conversationUpdated',
            conversation: ended,
            viewer: me,
        });

        expect(state.mine[0].status).toBe('ended');
    });

    it('routes offline tickets to their own list while open, and out when closed', () => {
        const ticket = makeConversationStaff({ type: 'offline' });
        const claimed = {
            ...ticket,
            status: 'active' as const,
            assignedAgent: { id: me.id, name: 'Me' },
        };
        const closed = { ...claimed, status: 'closed' as const };
        const state = run(EMPTY_INBOX, {
            type: 'conversationUpdated',
            conversation: ticket,
            viewer: me,
        });

        expect(state.tickets.map((t) => t.ulid)).toEqual([ticket.ulid]);
        expect(state.queue).toEqual([]);
        expect(selectTicketCount(state)).toBe(1);

        const mineNow = run(state, {
            type: 'conversationUpdated',
            conversation: claimed,
            viewer: me,
        });

        expect(selectTicketCount(mineNow)).toBe(0);
        expect(mineNow.tickets).toHaveLength(1);
        expect(
            run(mineNow, {
                type: 'conversationUpdated',
                conversation: closed,
                viewer: me,
            }).tickets,
        ).toEqual([]);
    });

    it('does not show a ticket claimed by a colleague to an agent', () => {
        const theirs = makeConversationStaff({
            type: 'offline',
            status: 'active',
            assignedAgent: { id: 99, name: 'Sam' },
        });

        expect(
            run(EMPTY_INBOX, {
                type: 'conversationUpdated',
                conversation: theirs,
                viewer: me,
            }).tickets,
        ).toEqual([]);
    });

    it('ignores an update that describes an earlier life of the chat', () => {
        const ended = makeActiveConversationStaff({
            status: 'ended',
            lastSeq: 5,
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const stale = { ...ended, status: 'active' as const };
        const state = run(
            EMPTY_INBOX,
            { type: 'conversationUpdated', conversation: ended, viewer: me },
            { type: 'conversationUpdated', conversation: stale, viewer: me },
        );

        expect(state.mine[0].status).toBe('ended');
        expect(
            isStaleUpdate(
                { status: 'active', lastSeq: 9 },
                { status: 'active', lastSeq: 4 },
            ),
        ).toBe(true);
        expect(
            isStaleUpdate(
                { status: 'active', lastSeq: 9 },
                { status: 'queued', lastSeq: 9 },
            ),
        ).toBe(false);
    });
});

describe('unseen counters', () => {
    it('sets and clears the unseen count of one chat and sums them', () => {
        const a = makeActiveConversationStaff({ unseenByAgent: 1 });
        const b = makeActiveConversationStaff({ unseenByAgent: 0 });
        const seeded = run(EMPTY_INBOX, {
            type: 'hydrate',
            queue: [],
            mine: [a, b],
        });

        expect(selectUnseenTotal(seeded)).toBe(1);

        const raised = run(seeded, {
            type: 'unread',
            conversation: b.ulid,
            unseen: 4,
        });

        expect(selectUnseenTotal(raised)).toBe(5);
        expect(
            selectUnseenTotal(
                run(raised, { type: 'seen', conversation: b.ulid }),
            ),
        ).toBe(1);
    });

    it('returns the same state when nothing changes, so subscribers stay quiet', () => {
        const a = makeActiveConversationStaff({ unseenByAgent: 2 });
        const state = run(EMPTY_INBOX, {
            type: 'hydrate',
            queue: [],
            mine: [a],
        });

        expect(
            run(state, { type: 'unread', conversation: a.ulid, unseen: 2 }),
        ).toBe(state);
        expect(
            run(state, { type: 'unread', conversation: 'nope', unseen: 3 }),
        ).toBe(state);
        expect(run(state, { type: 'seen', conversation: 'nope' })).toBe(state);
    });

    it('attention = open offers + unread messages', () => {
        const a = makeActiveConversationStaff({ unseenByAgent: 3 });
        const state = run(
            EMPTY_INBOX,
            { type: 'hydrate', queue: [], mine: [a] },
            { type: 'offered', offer: makeOffer(), nowMs: NOW },
        );

        expect(selectAttentionCount(state)).toBe(4);
    });
});

describe('connection, presence and roster', () => {
    const member = (
        id: number,
        status: 'online' | 'away' | 'offline' = 'online',
    ) => ({
        id,
        name: `Agent ${id}`,
        avatarUrl: null,
        status,
    });

    it('tracks the connection and the own status without churn', () => {
        const state = run(
            EMPTY_INBOX,
            { type: 'connection', status: 'reconnecting' },
            { type: 'presence', status: 'away' },
        );

        expect(state.connection).toBe('reconnecting');
        expect(state.presence).toBe('away');
        expect(run(state, { type: 'connection', status: 'reconnecting' })).toBe(
            state,
        );
        expect(run(state, { type: 'presence', status: 'away' })).toBe(state);
    });

    it('keeps the roster: here, join, status change, leave', () => {
        const state = run(
            EMPTY_INBOX,
            { type: 'rosterHere', members: [member(1), member(2)] },
            { type: 'rosterJoin', member: member(3) },
            { type: 'rosterJoin', member: member(3, 'away') },
            { type: 'rosterStatus', id: 1, status: 'offline' },
            { type: 'rosterLeave', id: 2 },
        );

        expect(state.roster).toEqual([member(1, 'offline'), member(3, 'away')]);
        expect(run(state, { type: 'rosterLeave', id: 99 })).toBe(state);
        expect(
            run(state, { type: 'rosterStatus', id: 1, status: 'offline' }),
        ).toBe(state);
    });
});

describe('removed', () => {
    it('forgets a conversation everywhere', () => {
        const offer = makeOffer();
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const ticket = makeConversationStaff({ type: 'offline' });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'hydrate', mine: [chat], tickets: [ticket] },
            { type: 'removed', conversation: offer.conversation },
            { type: 'removed', conversation: chat.ulid },
            { type: 'removed', conversation: ticket.ulid },
        );

        expect([state.queue, state.mine, state.tickets]).toEqual([[], [], []]);
    });
});

describe('createInboxStore', () => {
    it('notifies subscribers only when the state changed, and stops after unsubscribe', () => {
        const store = createInboxStore();
        const listener = vi.fn();
        const stop = store.subscribe(listener);

        store.dispatch({ type: 'presence', status: 'online' });
        store.dispatch({ type: 'presence', status: 'online' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(store.getState().presence).toBe('online');

        stop();
        store.dispatch({ type: 'presence', status: 'away' });
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('starts from the given partial state', () => {
        expect(createInboxStore({ presence: 'away' }).getState()).toMatchObject(
            {
                presence: 'away',
                hydrated: false,
            },
        );
    });
});

describe('a snapshot that was in flight while events arrived', () => {
    it('lets the newer event win for the conversations it touched, and applies the rest', () => {
        const mine = makeActiveConversationStaff({
            assignedAgent: { id: me.id, name: 'Me' },
            status: 'active',
        });
        const waiting = makeOffer();
        const other = makeConversationStaff();
        const base = run(EMPTY_INBOX, {
            type: 'offered',
            offer: waiting,
            nowMs: NOW,
        });
        const since = base.clock;

        // While the REST request is out: somebody takes the waiting chat, and a chat of mine is updated.
        const during = run(
            base,
            { type: 'taken', conversation: waiting.conversation, by: 'Omar' },
            { type: 'conversationUpdated', conversation: mine, viewer: me },
        );
        // The snapshot describes the world before that: the chat still queued, my chat not yet listed.
        const applied = run(during, {
            type: 'hydrate',
            queue: [
                makeConversationStaff({ ulid: waiting.conversation }),
                other,
            ],
            mine: [],
            since,
        });

        expect(
            applied.queue.map((item) => [item.conversation, item.state]),
        ).toEqual(
            expect.arrayContaining([
                [waiting.conversation, 'taken'],
                [other.ulid, 'open'],
            ]),
        );
        expect(applied.mine.map((c) => c.ulid)).toEqual([mine.ulid]);
    });

    it('applies a snapshot in full when nothing changed since it was requested', () => {
        const chat = makeActiveConversationStaff({
            assignedAgent: { id: me.id, name: 'Me' },
        });
        const state = run(EMPTY_INBOX, {
            type: 'conversationUpdated',
            conversation: chat,
            viewer: me,
        });
        const applied = run(state, {
            type: 'hydrate',
            queue: [],
            mine: [],
            since: state.clock,
        });

        expect(applied.mine).toEqual([]);
        expect(applied.touched).toEqual({});
    });

    it('counts a change only when the state really changed', () => {
        const state = run(EMPTY_INBOX, {
            type: 'seen',
            conversation: 'unknown',
        });

        expect(state.clock).toBe(0);
    });
});

describe('offer deadlines and the agent clock', () => {
    it('with ttlSeconds the deadline counts from the moment the offer arrived here, whatever the two clocks say', () => {
        // the server's clock is ten minutes behind this browser's: expiresAt is already "in the past" locally
        const offer = {
            ...makeOffer({ expiresAt: fakeTime(-600 + 60) }),
            ttlSeconds: 60,
        };
        const state = run(EMPTY_INBOX, { type: 'offered', offer, nowMs: NOW });

        expect(state.queue[0].expiresAt).toBe(
            new Date(NOW + 60_000).toISOString(),
        );
        expect(state.queue[0].totalSeconds).toBe(60);
        expect(nextExpiryMs(state)).toBe(NOW + 60_000);

        // it is still open a second before the local deadline, and expires right at it
        expect(
            run(state, { type: 'expire', nowMs: NOW + 59_000 }).queue[0].state,
        ).toBe('open');
        expect(
            run(state, { type: 'expire', nowMs: NOW + 60_000 }).queue[0].state,
        ).toBe('expired');

        // and the other way round: a clock far ahead of the server does not make a fresh offer last longer
        const ahead = {
            ...makeOffer({ expiresAt: fakeTime(600 + 60) }),
            ttlSeconds: 60,
        };

        expect(
            run(EMPTY_INBOX, { type: 'offered', offer: ahead, nowMs: NOW })
                .queue[0].expiresAt,
        ).toBe(new Date(NOW + 60_000).toISOString());
    });

    it('without ttlSeconds (an older backend) the server deadline is used as sent', () => {
        const offer = makeOffer({
            expiresAt: fakeTime(45),
            ttlSeconds: undefined,
        });
        const state = run(EMPTY_INBOX, { type: 'offered', offer, nowMs: NOW });

        expect(state.queue[0].expiresAt).toBe(fakeTime(45));
        expect(state.queue[0].totalSeconds).toBeNull();
    });

    it('a snapshot row counts down to queueExpiresAt and lapses, with the wait length as the ring total', () => {
        const row = makeConversationStaff({
            createdAt: fakeTime(-30),
            queueExpiresAt: fakeTime(60),
        });
        const state = run(EMPTY_INBOX, {
            type: 'hydrate',
            queue: [row],
            mine: [],
        });

        expect(state.queue[0]).toMatchObject({
            expiresAt: fakeTime(60),
            totalSeconds: 90,
        });
        expect(nextExpiryMs(state)).toBe(NOW + 60_000);
        expect(
            run(state, { type: 'expire', nowMs: NOW + 61_000 }).queue[0].state,
        ).toBe('expired');
    });

    it('an offer keeps its own-clock deadline when a snapshot of the same chat arrives', () => {
        const offer = { ...makeOffer(), ttlSeconds: 30 };
        const snapshot = makeConversationStaff({
            ulid: offer.conversation,
            queueExpiresAt: fakeTime(500),
        });
        const state = run(
            EMPTY_INBOX,
            { type: 'offered', offer, nowMs: NOW },
            { type: 'hydrate', queue: [snapshot], mine: [] },
        );

        expect(state.queue[0].expiresAt).toBe(
            new Date(NOW + 30_000).toISOString(),
        );
    });
});
