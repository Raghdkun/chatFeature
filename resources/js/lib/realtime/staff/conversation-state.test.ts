import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
    fakeTime,
    makeActiveConversationStaff,
    makeAgentMessage,
    makeMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { findGap } from '@/lib/chat/messages';
import type { MessageData } from '@/lib/chat/types';
import {
    canSend,
    conversationReducer,
    createConversationState,
    type ConversationViewAction,
    type ConversationViewState,
} from '@/lib/realtime/staff/conversation-state';

const CONVERSATION = '01JFAKE000000000000000ABCD';
const CLIENT_ID = '01JFAKECLIENT00000000000001';

function msg(seq: number, overrides: Partial<MessageData> = {}): MessageData {
    return makeMessage({
        seq,
        ulid: `01JFAKE0000000000000000${String(seq).padStart(3, '0')}`,
        conversation: CONVERSATION,
        createdAt: fakeTime(seq),
        body: `Message ${seq}`,
        ...overrides,
    });
}

const agent = (seq: number, overrides: Partial<MessageData> = {}) =>
    makeAgentMessage({
        seq,
        ulid: `01JFAKE0000000000000000${String(seq).padStart(3, '0')}`,
        conversation: CONVERSATION,
        createdAt: fakeTime(seq),
        sender: { type: 'agent', name: 'Sam', avatarUrl: null, id: 7 },
        body: `Message ${seq}`,
        ...overrides,
    });

const run = (
    state: ConversationViewState,
    ...actions: ConversationViewAction[]
) => actions.reduce(conversationReducer, state);

const pendingInput = (body = 'On it') => ({
    clientMsgId: CLIENT_ID,
    conversation: CONVERSATION,
    sender: { type: 'agent' as const, name: 'Sam', avatarUrl: null, id: 7 },
    body,
    createdAt: fakeTime(100),
});

let initial: ConversationViewState;

beforeEach(() => {
    resetFixtures();
    initial = createConversationState(
        makeActiveConversationStaff({ ulid: CONVERSATION, lastSeq: 2 }),
        [msg(2), msg(1)],
    );
});

describe('the message list', () => {
    it('starts ordered by seq and derives the status of each message from its receipts', () => {
        expect(initial.messages.map((m) => m.seq)).toEqual([1, 2]);
        expect(initial.messages.map((m) => m.status)).toEqual(['sent', 'sent']);
    });

    it('merges a broadcast, the REST copy and a catch-up fetch into one list (idempotent)', () => {
        const three = msg(3);
        const state = run(
            initial,
            { type: 'received', messages: [three] },
            { type: 'received', messages: [three] },
            { type: 'received', messages: [msg(2), three, msg(4)] },
        );

        expect(state.messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
        expect(state.conversation.lastSeq).toBe(4);
    });

    it('returns the same state when nothing new arrived', () => {
        expect(run(initial, { type: 'received', messages: [msg(1)] })).toBe(
            initial,
        );
    });

    it('exposes a hole in seq to the gap check', () => {
        const state = run(initial, { type: 'received', messages: [msg(5)] });

        expect(
            findGap(state.messages, state.conversation.lastSeq),
        ).toMatchObject({
            afterSeq: 2,
            count: 2,
        });
    });
});

describe('sending', () => {
    it('shows the optimistic copy last, as "sending", before the server numbers it', () => {
        const state = run(initial, { type: 'pending', input: pendingInput() });
        const last = state.messages.at(-1);

        expect(last).toMatchObject({
            seq: null,
            ulid: null,
            body: 'On it',
            status: 'sending',
            clientMsgId: CLIENT_ID,
        });
    });

    it('replaces it with the server copy when the send is acknowledged', () => {
        const ack = agent(3, { clientMsgId: CLIENT_ID, body: 'On it' });
        const state = run(
            initial,
            { type: 'pending', input: pendingInput() },
            { type: 'acked', message: ack },
        );

        expect(state.messages).toHaveLength(3);
        expect(state.messages.at(-1)).toMatchObject({ seq: 3, status: 'sent' });
        expect(state.conversation.lastSeq).toBe(3);
    });

    it('does not duplicate it when the broadcast beats the response', () => {
        const echoed = agent(3, { clientMsgId: CLIENT_ID, body: 'On it' });
        const state = run(
            initial,
            { type: 'pending', input: pendingInput() },
            { type: 'received', messages: [echoed] },
            { type: 'acked', message: echoed },
        );

        expect(state.messages.filter((m) => m.body === 'On it')).toHaveLength(
            1,
        );
    });

    it('marks a failed send, retries it as "sending" and discards it on request', () => {
        const failed = run(
            initial,
            { type: 'pending', input: pendingInput() },
            { type: 'failed', clientMsgId: CLIENT_ID },
        );

        expect(failed.messages.at(-1)?.status).toBe('failed');

        const retrying = run(failed, {
            type: 'retrying',
            clientMsgId: CLIENT_ID,
        });

        expect(retrying.messages.at(-1)?.status).toBe('sending');

        const gone = run(failed, { type: 'discard', clientMsgId: CLIENT_ID });

        expect(gone.messages).toHaveLength(2);
        expect(run(gone, { type: 'discard', clientMsgId: CLIENT_ID })).toBe(
            gone,
        );
    });

    it('a retry that succeeds leaves exactly one message (same client id)', () => {
        const state = run(
            initial,
            { type: 'pending', input: pendingInput() },
            { type: 'failed', clientMsgId: CLIENT_ID },
            { type: 'retrying', clientMsgId: CLIENT_ID },
            {
                type: 'acked',
                message: agent(3, { clientMsgId: CLIENT_ID, body: 'On it' }),
            },
        );

        expect(
            state.messages.filter((m) => m.clientMsgId === CLIENT_ID),
        ).toHaveLength(1);
        expect(state.messages.at(-1)?.status).toBe('sent');
    });

    it('never lets a discard remove a message the server already numbered', () => {
        const state = run(
            initial,
            {
                type: 'received',
                messages: [agent(3, { clientMsgId: CLIENT_ID })],
            },
            { type: 'discard', clientMsgId: CLIENT_ID },
        );

        expect(state.messages).toHaveLength(3);
    });
});

describe('receipts', () => {
    it('ticks my messages "seen" up to the receipt, and never moves backwards', () => {
        const mine = createConversationState(
            makeActiveConversationStaff({ ulid: CONVERSATION, lastSeq: 3 }),
            [msg(1), agent(2), agent(3)],
        );
        const seen = run(mine, {
            type: 'seen',
            upToSeq: 2,
            by: 'visitor',
            at: fakeTime(200),
        });

        expect(seen.messages.map((m) => m.status)).toEqual([
            'sent',
            'seen',
            'sent',
        ]);

        const stale = run(
            seen,
            { type: 'received', messages: [agent(2)] },
            { type: 'seen', upToSeq: 1, by: 'visitor', at: fakeTime(300) },
        );

        expect(stale.messages[1].status).toBe('seen');
    });

    it("marks the visitor's messages seen once the agent has read them", () => {
        const state = run(initial, {
            type: 'seen',
            upToSeq: 2,
            by: 'agent',
            at: fakeTime(200),
        });

        expect(state.messages.map((m) => m.status)).toEqual(['seen', 'seen']);
    });
});

describe('the conversation record', () => {
    it('follows status changes from the lists', () => {
        const state = run(initial, {
            type: 'conversation',
            conversation: {
                ...initial.conversation,
                status: 'ended',
                ratingRequested: true,
            },
        });

        expect(state.conversation.status).toBe('ended');
        expect(canSend(state.conversation)).toBe(false);
        expect(canSend(initial.conversation)).toBe(true);
    });

    it('ignores a stale snapshot that would reopen an ended chat', () => {
        const ended = run(initial, {
            type: 'ended',
            ratingRequested: true,
            at: fakeTime(300),
        });
        const state = run(ended, {
            type: 'conversation',
            conversation: { ...initial.conversation },
        });

        expect(state.conversation.status).toBe('ended');
    });

    it('applies the ended and closed events once, in order', () => {
        const ended = run(initial, {
            type: 'ended',
            ratingRequested: true,
            at: fakeTime(300),
        });

        expect(ended.conversation).toMatchObject({
            status: 'ended',
            ratingRequested: true,
            endedAt: fakeTime(300),
        });
        expect(
            run(ended, {
                type: 'ended',
                ratingRequested: true,
                at: fakeTime(400),
            }),
        ).toBe(ended);

        const closed = run(ended, { type: 'closed', at: fakeTime(500) });

        expect(closed.conversation.status).toBe('closed');
        expect(closed.conversation.endedAt).toBe(fakeTime(300));
        expect(run(closed, { type: 'closed', at: fakeTime(600) })).toBe(closed);
        expect(
            run(closed, {
                type: 'ended',
                ratingRequested: true,
                at: fakeTime(700),
            }),
        ).toBe(closed);
    });

    it('keeps lastSeq at least as high as the highest message it holds', () => {
        const state = run(initial, { type: 'received', messages: [msg(9)] });
        const refreshed = run(state, {
            type: 'conversation',
            conversation: { ...state.conversation, lastSeq: 2 },
        });

        expect(refreshed.conversation.lastSeq).toBe(9);
    });
});
