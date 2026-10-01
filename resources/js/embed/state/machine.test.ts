import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
    createInitialState,
    DEFAULT_FLOW,
    firstStep,
    hostStatus,
    isLiveChat,
    PHASES,
    reduce,
    selectUnread,
    toHostState,
    TRANSITIONS,
    type Action,
    type Flow,
    type MachineState,
    type Phase,
} from '@/embed/state/machine';
import {
    fakeTime,
    makeAgentMessage,
    makeConversationPublic,
    makeLocalMessage,
    makeMessage,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { createPendingMessage, toLocalMessage } from '@/lib/chat/messages';

const NOW = 1_000_000;
const VALUES = {
    name: 'Vera',
    email: 'vera@x.test',
    phone: '',
    consent: false,
};

const flow = (patch: Partial<Flow> = {}): Flow => ({
    ...DEFAULT_FLOW,
    categoryCount: 1,
    ...patch,
});

function run(state: MachineState, ...actions: Action[]): MachineState {
    return actions.reduce(reduce, state);
}

function booted(patch: Partial<Flow> = {}): MachineState {
    return run(
        createInitialState(),
        { type: 'CONFIGURED', flow: flow(patch) },
        { type: 'BOOTED', conversation: null, messages: [], now: NOW },
    );
}

function queued(patch: Partial<Flow> = {}): MachineState {
    return run(
        booted(patch),
        { type: 'START' },
        {
            type: 'CREATE_OK',
            conversation: makeConversationPublic({ ulid: 'conv-1' }),
            now: NOW,
        },
    );
}

function active(patch: Partial<Flow> = {}): MachineState {
    return run(queued(patch), {
        type: 'CLAIMED',
        agent: { name: 'Sam', avatarUrl: null },
    });
}

beforeEach(() => resetFixtures());

describe('first step (config-driven skipping)', () => {
    it('waits in booting until BOOTED', () => {
        expect(createInitialState().phase).toBe('booting');
        expect(hostStatus(createInitialState().phase)).toBeNull();
    });

    it('lands on idle when nothing has to be asked', () => {
        expect(booted().phase).toBe('idle');
    });

    it('goes straight to the pre-chat form when it is on', () => {
        expect(booted({ preChat: true, categoryCount: 3 }).phase).toBe(
            'prechat',
        );
    });

    it('goes to the category picker when there are several and no form', () => {
        expect(booted({ categoryCount: 3 }).phase).toBe('category');
    });

    it('skips the picker for one category and for a preset one', () => {
        expect(booted({ categoryCount: 1 }).phase).toBe('idle');

        const preset = run(
            createInitialState(),
            { type: 'CONFIGURED', flow: flow({ categoryCount: 3 }) },
            { type: 'PRESET', category: 'billing' },
            { type: 'BOOTED', conversation: null, messages: [], now: NOW },
        );

        expect(preset.phase).toBe('idle');
        expect(firstStep(preset)).toBeNull();
    });

    it('lands on offline when availability says nobody can answer', () => {
        const state = booted({ offline: true, offlineReason: 'hours' });

        expect(state.phase).toBe('offline');
        expect(state.offline.reason).toBe('hours');
    });

    it('idle -> start with nothing to ask begins the chat (busy: starting)', () => {
        const state = run(booted(), { type: 'START' });

        expect(state.phase).toBe('idle');
        expect(state.busy).toBe('starting');
    });

    it('idle -> start moves to the first step that needs input', () => {
        const state = run(
            run(
                createInitialState(),
                { type: 'CONFIGURED', flow: flow() },
                { type: 'BOOTED', conversation: null, messages: [], now: NOW },
                { type: 'CONFIGURED', flow: flow({ preChat: true }) },
            ),
            { type: 'START' },
        );

        expect(state.phase).toBe('prechat');
    });
});

describe('the happy path', () => {
    it('prechat -> category -> queued -> active -> ended -> closed -> new chat', () => {
        let state = booted({ preChat: true, categoryCount: 2 });

        expect(state.phase).toBe('prechat');

        state = reduce(state, { type: 'PRECHAT_SUBMIT', values: VALUES });
        expect(state.phase).toBe('category');
        expect(state.form.name).toBe('Vera');

        state = reduce(state, { type: 'CATEGORY_PICK', slug: 'billing' });
        expect(state.busy).toBe('starting');
        expect(state.category).toBe('billing');

        state = reduce(state, {
            type: 'CREATE_OK',
            conversation: makeConversationPublic({ ulid: 'conv-1' }),
            now: NOW,
        });
        expect(state.phase).toBe('queued');
        expect(state.queuedAt).toBe(NOW);
        expect(state.busy).toBeNull();

        state = reduce(state, {
            type: 'CLAIMED',
            agent: { name: 'Sam', avatarUrl: null },
        });
        expect(state.phase).toBe('active');
        expect(state.conversation?.agent?.name).toBe('Sam');
        expect(state.conversation?.status).toBe('active');

        state = reduce(state, { type: 'ENDED', ratingRequested: true });
        expect(state.phase).toBe('ended');
        expect(state.conversation?.ratingRequested).toBe(true);

        state = reduce(state, { type: 'RATING_REQUESTED' });
        expect(state.busy).toBe('rating');
        state = reduce(state, { type: 'RATED' });
        expect(state.phase).toBe('closed');
        expect(state.closedReason).toBe('rated');
        expect(state.conversation).toBeNull();
        expect(state.messages).toEqual([]);

        state = reduce(state, { type: 'NEW_CHAT' });
        expect(state.phase).toBe('prechat');
        // what the visitor typed survives, the old ticket does not
        expect(state.form.name).toBe('Vera');
        expect(state.category).toBeNull();
    });

    it('a pre-chat form with one category starts the chat on submit', () => {
        const state = run(booted({ preChat: true, categoryCount: 1 }), {
            type: 'PRECHAT_SUBMIT',
            values: VALUES,
        });

        expect(state.phase).toBe('prechat');
        expect(state.busy).toBe('starting');
    });

    it('rating skipped closes the chat', () => {
        const state = run(
            active(),
            { type: 'ENDED', ratingRequested: true },
            { type: 'RATING_SKIPPED' },
        );

        expect(state.phase).toBe('closed');
        expect(state.closedReason).toBe('skipped');
    });

    it('goes straight to closed when rating is off or not requested', () => {
        expect(
            run(active({ rating: false }), {
                type: 'ENDED',
                ratingRequested: true,
            }).phase,
        ).toBe('closed');
        expect(
            run(active(), { type: 'ENDED', ratingRequested: false })
                .closedReason,
        ).toBe('ended');
    });

    it('cancelling a queued chat closes it', () => {
        const state = run(queued(), { type: 'CANCEL_OK' });

        expect(state.phase).toBe('closed');
        expect(state.closedReason).toBe('cancelled');
    });

    it('a transfer sends the visitor back to the queue and keeps the transcript', () => {
        const withMessage = run(active(), {
            type: 'MESSAGES',
            messages: [makeAgentMessage({ conversation: 'conv-1', seq: 1 })],
        });
        const state = run(withMessage, { type: 'TRANSFERRED', now: NOW + 5 });

        expect(state.phase).toBe('queued');
        expect(state.transferred).toBe(true);
        expect(state.queuedAt).toBe(NOW + 5);
        expect(state.messages).toHaveLength(1);
        expect(state.conversation?.agent).toBeNull();

        const again = reduce(state, {
            type: 'CLAIMED',
            agent: { name: 'Kim', avatarUrl: null },
        });

        expect(again.phase).toBe('active');
        expect(again.transferred).toBe(false);
    });
});

describe('offline paths', () => {
    it('409 no_agents moves to the offline form', () => {
        const state = run(
            booted({ preChat: true }),
            { type: 'PRECHAT_SUBMIT', values: VALUES },
            { type: 'CREATE_FAIL', failure: { kind: 'no_agents' } },
        );

        expect(state.phase).toBe('offline');
        expect(state.offline.reason).toBe('no_agents');
        expect(state.busy).toBeNull();
    });

    it('a missed queue becomes the offline form and remembers the missed chat', () => {
        const state = run(queued(), { type: 'MISSED' });

        expect(state.phase).toBe('offline');
        expect(state.offline).toMatchObject({
            reason: 'missed',
            missed: 'conv-1',
        });
        expect(state.conversation).toBeNull();
    });

    it('a missed queue without an offline form just closes', () => {
        const state = run(queued({ offlineForm: false }), { type: 'MISSED' });

        expect(state.phase).toBe('closed');
    });

    it('an offline category goes to the form with that category preselected', () => {
        const state = run(booted({ categoryCount: 2 }), {
            type: 'CATEGORY_OFFLINE',
            slug: 'sales',
        });

        expect(state.phase).toBe('offline');
        expect(state.category).toBe('sales');
        expect(state.offline.reason).toBe('category');
    });

    it('the ticket confirmation is the closed screen', () => {
        const ticket = makeConversationPublic({ type: 'offline' });
        const state = run(
            booted({ offline: true }),
            { type: 'OFFLINE_SUBMITTING' },
            { type: 'OFFLINE_SENT', ticket },
        );

        expect(state.phase).toBe('closed');
        expect(state.closedReason).toBe('ticket');
        expect(state.offline.ticket).toBe(ticket);
    });

    it('server field errors keep the offline form open', () => {
        const state = run(
            booted({ offline: true }),
            { type: 'OFFLINE_SUBMITTING' },
            {
                type: 'OFFLINE_FAILED',
                failure: { kind: 'validation', errors: { email: 'Invalid' } },
            },
        );

        expect(state.phase).toBe('offline');
        expect(state.busy).toBeNull();
        expect(state.fieldErrors.email).toBe('Invalid');
    });

    it('returns from offline to the first step when availability recovers (not after a missed chat)', () => {
        const offline = booted({ offline: true });
        const back = reduce(offline, {
            type: 'CONFIGURED',
            flow: flow({ offline: false, preChat: true }),
        });

        expect(back.phase).toBe('prechat');

        const missed = run(queued(), { type: 'MISSED' });

        expect(reduce(missed, { type: 'CONFIGURED', flow: flow() }).phase).toBe(
            'offline',
        );
    });

    it('closing hours push an unstarted chat to offline, never a running one', () => {
        expect(
            reduce(booted({ preChat: true }), {
                type: 'CONFIGURED',
                flow: flow({ offline: true, offlineReason: 'hours' }),
            }).phase,
        ).toBe('offline');

        const live = reduce(active(), {
            type: 'CONFIGURED',
            flow: flow({ offline: true }),
        });

        expect(live.phase).toBe('active');
    });
});

describe('failures while starting', () => {
    it('a validation error returns to the form with field messages', () => {
        const state = run(
            booted({ preChat: true, categoryCount: 1 }),
            { type: 'PRECHAT_SUBMIT', values: VALUES },
            {
                type: 'CREATE_FAIL',
                failure: { kind: 'validation', errors: { email: 'Bad email' } },
            },
        );

        expect(state.phase).toBe('prechat');
        expect(state.fieldErrors.email).toBe('Bad email');
        expect(state.busy).toBeNull();
    });

    it('a form error from a direct start (form skipped) opens the form', () => {
        const state = run(
            booted(),
            { type: 'START' },
            {
                type: 'CREATE_FAIL',
                failure: { kind: 'validation', errors: { name: 'Required' } },
            },
        );

        expect(state.phase).toBe('prechat');
        expect(state.fieldErrors.name).toBe('Required');
    });

    it('a rate limit or network error stays on the screen with a notice', () => {
        const state = run(
            booted(),
            { type: 'START' },
            {
                type: 'CREATE_FAIL',
                failure: {
                    kind: 'notice',
                    notice: { code: 'rate_limited', seconds: 12 },
                },
            },
        );

        expect(state.phase).toBe('idle');
        expect(state.busy).toBeNull();
        expect(state.notice).toEqual({ code: 'rate_limited', seconds: 12 });
    });

    it('ignores a failure nobody is waiting for', () => {
        const state = booted();

        expect(
            reduce(state, {
                type: 'CREATE_FAIL',
                failure: { kind: 'no_agents' },
            }),
        ).toBe(state);
    });

    it('409 conversation_exists resumes the queued or active chat', () => {
        const started = run(booted(), { type: 'START' });

        expect(
            reduce(started, {
                type: 'RESUMED',
                conversation: makeConversationPublic({ status: 'queued' }),
                now: NOW,
            }).phase,
        ).toBe('queued');
        expect(
            reduce(started, {
                type: 'RESUMED',
                conversation: makeConversationPublic({ status: 'active' }),
                now: NOW,
            }).phase,
        ).toBe('active');
    });
});

describe('resuming on boot', () => {
    const boot = (
        status: 'queued' | 'active' | 'ended' | 'closed' | 'missed',
        patch = {},
    ) =>
        run(
            createInitialState(),
            { type: 'CONFIGURED', flow: flow() },
            {
                type: 'BOOTED',
                conversation: makeConversationPublic({
                    ulid: 'conv-1',
                    status,
                    ratingRequested: status === 'ended',
                    lastSeq: 2,
                    ...patch,
                }),
                messages: [
                    makeMessage({ conversation: 'conv-1', seq: 1 }),
                    makeAgentMessage({ conversation: 'conv-1', seq: 2 }),
                ],
                now: NOW,
            },
        );

    it('resumes queued, active and ended (with rating) chats with their messages', () => {
        expect(boot('queued').phase).toBe('queued');
        expect(boot('active').phase).toBe('active');
        expect(boot('active').messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(boot('ended').phase).toBe('ended');
    });

    it('never shows history: closed and missed chats start fresh', () => {
        for (const status of ['closed', 'missed'] as const) {
            const state = boot(status);

            expect(state.phase).toBe('idle');
            expect(state.messages).toEqual([]);
            expect(state.conversation).toBeNull();
        }
    });

    it('BOOTED is only valid while booting', () => {
        const state = booted();

        expect(
            reduce(state, {
                type: 'BOOTED',
                conversation: makeConversationPublic({ status: 'active' }),
                messages: [],
                now: NOW,
            }),
        ).toBe(state);
    });

    it('a lost session ends a live chat as expired and a fresh one just clears', () => {
        const live = reduce(active(), { type: 'SESSION_LOST' });

        expect(live.phase).toBe('closed');
        expect(live.closedReason).toBe('expired');

        const idle = reduce(booted(), { type: 'SESSION_LOST' });

        expect(idle.phase).toBe('idle');
    });
});

describe('closing', () => {
    it.each(['idle', 'system', 'cancelled'] as const)(
        'CLOSED(%s) ends a live chat',
        (reason) => {
            const state = run(active(), { type: 'CLOSED', reason });

            expect(state.phase).toBe('closed');
            expect(state.closedReason).toBe(reason);
            expect(state.messages).toEqual([]);
        },
    );

    it('closes an unrated ended chat on timeout', () => {
        const state = run(
            active(),
            { type: 'ENDED', ratingRequested: true },
            {
                type: 'CLOSED',
                reason: 'timeout',
            },
        );

        expect(state.closedReason).toBe('timeout');
    });

    it('a failed rating keeps the screen and a failed end keeps the chat', () => {
        const rating = run(
            active(),
            { type: 'ENDED', ratingRequested: true },
            { type: 'RATING_REQUESTED' },
            { type: 'RATING_FAILED', notice: { code: 'network' } },
        );

        expect(rating.phase).toBe('ended');
        expect(rating.notice).toEqual({ code: 'network' });

        const end = run(
            active(),
            { type: 'END_REQUESTED' },
            { type: 'END_FAILED', notice: { code: 'generic' } },
        );

        expect(end.phase).toBe('active');
        expect(end.busy).toBeNull();
    });
});

describe('illegal transitions are ignored', () => {
    const phases: Record<Phase, () => MachineState> = {
        booting: () => createInitialState(),
        idle: () => booted(),
        prechat: () => booted({ preChat: true }),
        category: () => booted({ categoryCount: 3 }),
        queued: () => queued(),
        active: () => active(),
        ended: () => run(active(), { type: 'ENDED', ratingRequested: true }),
        offline: () => booted({ offline: true }),
        closed: () => run(queued(), { type: 'CANCEL_OK' }),
    };

    it('builds every phase', () => {
        for (const phase of PHASES) {
            expect(phases[phase]().phase).toBe(phase);
        }
    });

    it.each([
        ['idle', { type: 'CLAIMED', agent: { name: 'x', avatarUrl: null } }],
        ['idle', { type: 'ENDED', ratingRequested: true }],
        ['idle', { type: 'RATED' }],
        ['prechat', { type: 'CLAIMED', agent: { name: 'x', avatarUrl: null } }],
        ['category', { type: 'MISSED' }],
        ['queued', { type: 'RATED' }],
        ['queued', { type: 'RATING_SKIPPED' }],
        ['queued', { type: 'NEW_CHAT' }],
        ['active', { type: 'CANCEL_OK' }],
        ['active', { type: 'MISSED' }],
        ['active', { type: 'RATED' }],
        ['ended', { type: 'CLAIMED', agent: { name: 'x', avatarUrl: null } }],
        ['ended', { type: 'TRANSFERRED', now: 1 }],
        ['ended', { type: 'NEW_CHAT' }],
        ['offline', { type: 'ENDED', ratingRequested: true }],
        ['closed', { type: 'CLAIMED', agent: { name: 'x', avatarUrl: null } }],
        ['closed', { type: 'ENDED', ratingRequested: true }],
        ['closed', { type: 'MISSED' }],
        ['booting', { type: 'START' }],
        ['booting', { type: 'CLAIMED', agent: { name: 'x', avatarUrl: null } }],
    ] as [Phase, Action][])('%s ignores %o', (phase, action) => {
        const state = phases[phase]();

        expect(reduce(state, action)).toBe(state);
    });

    it('never breaks the transition table under a long random walk', () => {
        const actions = (): Action[] => [
            {
                type: 'CONFIGURED',
                flow: flow({ preChat: true, categoryCount: 2 }),
            },
            { type: 'CONFIGURED', flow: flow({ offline: true }) },
            { type: 'CONFIGURED', flow: flow() },
            { type: 'BOOTED', conversation: null, messages: [], now: NOW },
            { type: 'START' },
            { type: 'BACK' },
            { type: 'PRECHAT_SUBMIT', values: VALUES },
            { type: 'CATEGORY_PICK', slug: 'a' },
            { type: 'CATEGORY_OFFLINE', slug: 'a' },
            {
                type: 'CREATE_OK',
                conversation: makeConversationPublic({ ulid: 'c' }),
                now: NOW,
            },
            { type: 'CREATE_FAIL', failure: { kind: 'no_agents' } },
            { type: 'CLAIMED', agent: { name: 'Sam', avatarUrl: null } },
            { type: 'TRANSFERRED', now: NOW },
            { type: 'MISSED' },
            { type: 'CANCEL_OK' },
            { type: 'ENDED', ratingRequested: true },
            { type: 'ENDED', ratingRequested: false },
            { type: 'CLOSED', reason: 'idle' },
            { type: 'RATED' },
            { type: 'RATING_SKIPPED' },
            {
                type: 'OFFLINE_SENT',
                ticket: makeConversationPublic({ type: 'offline' }),
            },
            { type: 'NEW_CHAT' },
            { type: 'SESSION_LOST' },
            { type: 'HOST_OPEN' },
            { type: 'HOST_CLOSE' },
        ];
        let seed = 42;
        const random = (n: number): number => {
            seed = (seed * 1664525 + 1013904223) % 4294967296;

            return seed % n;
        };

        for (let run_ = 0; run_ < 40; run_++) {
            let state = createInitialState();

            for (let step = 0; step < 120; step++) {
                const pool = actions();
                const action = pool[random(pool.length)];
                const next = reduce(state, action);

                expect(
                    next.phase === state.phase ||
                        TRANSITIONS[state.phase].includes(next.phase),
                ).toBe(true);

                state = next;
            }
        }
    });
});

describe('messages in the reducer', () => {
    it('merges server messages, ordered by seq, and tracks lastSeq', () => {
        const state = run(active(), {
            type: 'MESSAGES',
            messages: [
                makeAgentMessage({ conversation: 'conv-1', seq: 2 }),
                makeMessage({ conversation: 'conv-1', seq: 1 }),
            ],
        });

        expect(state.messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(state.conversation?.lastSeq).toBe(2);
    });

    it('is idempotent: the same message twice changes nothing', () => {
        const message = makeAgentMessage({ conversation: 'conv-1', seq: 1 });
        const once = run(active(), { type: 'MESSAGES', messages: [message] });

        expect(reduce(once, { type: 'MESSAGES', messages: [message] })).toBe(
            once,
        );
    });

    it('optimistic send -> ack replaces the pending copy; failure -> retry -> ack', () => {
        const pending = createPendingMessage({
            clientMsgId: 'client-1',
            conversation: 'conv-1',
            sender: { type: 'visitor', name: 'Vera', avatarUrl: null },
            body: 'Hello',
            createdAt: fakeTime(1),
        });
        let state = run(active(), {
            type: 'MESSAGE_PENDING',
            message: pending,
        });

        expect(state.messages[0].status).toBe('sending');

        state = reduce(state, {
            type: 'MESSAGE_FAILED',
            clientMsgId: 'client-1',
        });
        expect(state.messages[0].status).toBe('failed');

        state = reduce(state, {
            type: 'MESSAGE_RETRY',
            clientMsgId: 'client-1',
        });
        expect(state.messages[0].status).toBe('sending');

        state = reduce(state, {
            type: 'MESSAGES',
            messages: [
                makeMessage({
                    conversation: 'conv-1',
                    seq: 1,
                    body: 'Hello',
                    clientMsgId: 'client-1',
                }),
            ],
        });
        expect(state.messages).toHaveLength(1);
        expect(state.messages[0]).toMatchObject({ seq: 1, status: 'sent' });
    });

    it('the broadcast can beat the REST ack: still one message', () => {
        const pending = createPendingMessage({
            clientMsgId: 'client-1',
            conversation: 'conv-1',
            sender: { type: 'visitor', name: null, avatarUrl: null },
            body: 'Hi',
            createdAt: fakeTime(1),
        });
        const server = makeMessage({
            conversation: 'conv-1',
            seq: 1,
            body: 'Hi',
            clientMsgId: 'client-1',
        });
        const state = run(
            active(),
            { type: 'MESSAGES', messages: [server] },
            { type: 'MESSAGE_PENDING', message: pending },
        );

        expect(state.messages).toHaveLength(1);
        expect(state.messages[0].seq).toBe(1);
    });

    it('removes a failed message the visitor discards, never a sent one', () => {
        const pending = createPendingMessage({
            clientMsgId: 'client-1',
            conversation: 'conv-1',
            sender: { type: 'visitor', name: null, avatarUrl: null },
            body: 'Hi',
            createdAt: fakeTime(1),
        });
        const state = run(active(), {
            type: 'MESSAGE_PENDING',
            message: pending,
        });

        expect(
            reduce(state, { type: 'MESSAGE_REMOVED', clientMsgId: 'client-1' })
                .messages,
        ).toEqual([]);

        const sent = run(active(), {
            type: 'MESSAGES',
            messages: [
                makeMessage({
                    conversation: 'conv-1',
                    seq: 1,
                    clientMsgId: 'client-1',
                }),
            ],
        });

        expect(
            reduce(sent, { type: 'MESSAGE_REMOVED', clientMsgId: 'client-1' }),
        ).toBe(sent);
    });

    it("applies the agent's seen receipt to the visitor's messages", () => {
        const state = run(
            active(),
            {
                type: 'MESSAGES',
                messages: [makeMessage({ conversation: 'conv-1', seq: 1 })],
            },
            { type: 'SEEN', upToSeq: 1, by: 'agent', at: fakeTime(9) },
        );

        expect(state.messages[0]).toMatchObject({
            status: 'seen',
            seenAt: fakeTime(9),
        });
    });

    it("applies the agent's delivery receipt: delivered, never over a seen message, and the same state when nothing changes", () => {
        const sent = run(active(), {
            type: 'MESSAGES',
            messages: [
                makeMessage({ conversation: 'conv-1', seq: 1 }),
                makeMessage({ conversation: 'conv-1', seq: 2 }),
            ],
        });
        const delivered = reduce(sent, {
            type: 'DELIVERED',
            upToSeq: 2,
            by: 'agent',
            at: fakeTime(8),
        });

        expect(delivered.messages.map((message) => message.status)).toEqual([
            'delivered',
            'delivered',
        ]);
        expect(delivered.messages[0].deliveredAt).toBe(fakeTime(8));
        expect(delivered.messages[0].seenAt).toBeNull();
        expect(
            reduce(delivered, {
                type: 'DELIVERED',
                upToSeq: 2,
                by: 'agent',
                at: fakeTime(9),
            }),
        ).toBe(delivered);

        const read = reduce(delivered, {
            type: 'SEEN',
            upToSeq: 1,
            by: 'agent',
            at: fakeTime(10),
        });
        const late = reduce(read, {
            type: 'DELIVERED',
            upToSeq: 2,
            by: 'agent',
            at: fakeTime(11),
        });

        expect(late).toBe(read);
        expect(late.messages.map((message) => message.status)).toEqual([
            'seen',
            'delivered',
        ]);
    });

    it('tracks typing and connection only when they change', () => {
        const state = active();

        expect(reduce(state, { type: 'TYPING', typing: false })).toBe(state);

        const typing = reduce(state, { type: 'TYPING', typing: true });

        expect(typing.typing).toBe(true);
        expect(reduce(typing, { type: 'TYPING', typing: true })).toBe(typing);
        expect(reduce(state, { type: 'CONNECTION', status: 'idle' })).toBe(
            state,
        );
        expect(
            reduce(state, { type: 'CONNECTION', status: 'reconnecting' })
                .connection,
        ).toBe('reconnecting');
    });
});

describe('unread and the host state', () => {
    const unreadState = (open: boolean): MachineState =>
        run(
            active(),
            {
                type: 'MESSAGES',
                messages: [
                    makeSystemMessage({ conversation: 'conv-1', seq: 1 }),
                    makeAgentMessage({ conversation: 'conv-1', seq: 2 }),
                    makeAgentMessage({ conversation: 'conv-1', seq: 3 }),
                    makeMessage({ conversation: 'conv-1', seq: 4 }),
                ],
            },
            { type: open ? 'HOST_OPEN' : 'HOST_CLOSE' },
        );

    it('counts unseen agent messages only while the panel is closed', () => {
        expect(selectUnread(unreadState(false))).toBe(2);
        expect(selectUnread(unreadState(true))).toBe(0);
    });

    it('seeing them clears the count', () => {
        const state = run(unreadState(false), {
            type: 'SEEN',
            upToSeq: 3,
            by: 'visitor',
            at: fakeTime(20),
        });

        expect(selectUnread(state)).toBe(0);
    });

    it('does not count its own messages or system lines', () => {
        const state = run(active(), {
            type: 'MESSAGES',
            messages: [
                makeMessage({ conversation: 'conv-1', seq: 1 }),
                makeSystemMessage({ conversation: 'conv-1', seq: 2 }),
            ],
        });

        expect(selectUnread(state)).toBe(0);
    });

    it('maps phases to the statuses the loader knows (category is reported as prechat, booting not at all)', () => {
        expect(hostStatus('booting')).toBeNull();
        expect(hostStatus('category')).toBe('prechat');

        for (const phase of PHASES.filter(
            (p) => p !== 'booting' && p !== 'category',
        )) {
            expect(hostStatus(phase)).toBe(phase);
        }
    });

    it('builds the state payload with the agent while the chat is active', () => {
        expect(toHostState(createInitialState())).toBeNull();
        expect(toHostState(booted())).toEqual({
            status: 'idle',
            open: false,
            unread: 0,
        });

        const state = run(active(), { type: 'HOST_OPEN' });

        expect(toHostState(state)).toEqual({
            status: 'active',
            open: true,
            unread: 0,
            agent: { name: 'Sam' },
        });
        expect(toHostState(run(queued(), { type: 'HOST_OPEN' }))).toEqual({
            status: 'queued',
            open: true,
            unread: 0,
        });
    });

    it('the agent avatar is passed when there is one', () => {
        const state = run(queued(), {
            type: 'CLAIMED',
            agent: { name: 'Sam', avatarUrl: 'https://cdn.test/sam.png' },
        });

        expect(toHostState(state)?.agent).toEqual({
            name: 'Sam',
            avatarUrl: 'https://cdn.test/sam.png',
        });
    });

    it('isLiveChat is queued or active only', () => {
        expect(isLiveChat(queued())).toBe(true);
        expect(isLiveChat(active())).toBe(true);
        expect(isLiveChat(booted())).toBe(false);
        expect(
            isLiveChat(run(active(), { type: 'ENDED', ratingRequested: true })),
        ).toBe(false);
    });
});

describe('presets, prefill and reset', () => {
    it('PRESET stores a category and an initial message once', () => {
        const state = reduce(booted(), {
            type: 'PRESET',
            category: 'billing',
            message: 'Hello',
        });

        expect(state.category).toBe('billing');
        expect(state.initialMessage).toBe('Hello');
        expect(
            reduce(state, {
                type: 'PRESET',
                category: 'billing',
                message: 'Hello',
            }),
        ).toBe(state);
    });

    it('PREFILL fills only what the visitor has not typed', () => {
        const typed = reduce(booted({ preChat: true }), {
            type: 'PRECHAT_SUBMIT',
            values: { ...VALUES, phone: '' },
        });
        const state = reduce(typed, {
            type: 'PREFILL',
            values: { name: 'Other', email: 'other@x.test', phone: '+1 555' },
        });

        expect(state.form.name).toBe('Vera');
        expect(state.form.email).toBe('vera@x.test');
        expect(state.form.phone).toBe('+1 555');
    });

    it('RESET clears the conversation and returns to the first step', () => {
        const state = reduce(active(), { type: 'RESET' });

        expect(state.phase).toBe('idle');
        expect(state.conversation).toBeNull();
        expect(state.messages).toEqual([]);
    });

    it('toLocalMessage helper stays in step with the reducer (sanity)', () => {
        expect(toLocalMessage(makeMessage()).status).toBe('sent');
        expect(makeLocalMessage().status).toBeDefined();
    });
});
