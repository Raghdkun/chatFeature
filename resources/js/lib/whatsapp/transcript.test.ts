import { beforeEach, describe, expect, it } from 'vite-plus/test';
import { ApiError } from '@/lib/api-client';
import { fakeTime, fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import {
    makeWaMessage,
    makeWaReply,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import {
    displayMessages,
    highestUlid,
    isFinalSendFailure,
    isUncertainSendFailure,
    outboxReducer,
    pendingOutbox,
    sendFailureOf,
    syncCursor,
    type OutboxEntry,
} from '@/lib/whatsapp/transcript';

const ME = { id: 1, name: 'Ada' };

function entry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
    return {
        clientMsgId: fakeUlid(900),
        body: 'On my way',
        createdAt: fakeTime(100),
        state: 'sending',
        failure: null,
        retryAfter: null,
        after: null,
        serverUlid: null,
        ...overrides,
    };
}

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

describe('the outbox reducer', () => {
    it('queues a reply once and keeps the order they were typed in', () => {
        const a = entry({ clientMsgId: 'a' });
        const b = entry({ clientMsgId: 'b' });
        const state = outboxReducer(
            outboxReducer([], { type: 'queued', entry: a }),
            { type: 'queued', entry: b },
        );

        expect(state.map((e) => e.clientMsgId)).toEqual(['a', 'b']);
        expect(outboxReducer(state, { type: 'queued', entry: a })).toBe(state);
    });

    it('remembers the id the POST answer gave the stored reply', () => {
        const state = outboxReducer([entry({ clientMsgId: 'a' })], {
            type: 'acked',
            clientMsgId: 'a',
            ulid: 'srv-1',
        });

        expect(state[0].serverUlid).toBe('srv-1');
    });

    it('fails a sending reply with its reason and the wait the server asked for, and lets a retry put it back', () => {
        const failed = outboxReducer([entry({ clientMsgId: 'a' })], {
            type: 'failed',
            clientMsgId: 'a',
            failure: 'pacing',
            retryAfter: 90,
        });

        expect(failed[0]).toMatchObject({
            state: 'failed',
            failure: 'pacing',
            retryAfter: 90,
        });

        const again = outboxReducer(failed, {
            type: 'retrying',
            clientMsgId: 'a',
        });

        expect(again[0]).toMatchObject({
            state: 'sending',
            failure: null,
            retryAfter: null,
        });
    });

    it('does not fail a reply twice, retry one that is not failed, or touch strangers', () => {
        const sending = [entry({ clientMsgId: 'a' })];

        expect(
            outboxReducer(sending, { type: 'retrying', clientMsgId: 'a' }),
        ).toBe(sending);

        const failed = outboxReducer(sending, {
            type: 'failed',
            clientMsgId: 'a',
            failure: 'network',
        });

        expect(
            outboxReducer(failed, {
                type: 'failed',
                clientMsgId: 'a',
                failure: 'unknown',
            })[0].failure,
        ).toBe('network');
        expect(
            outboxReducer(sending, { type: 'removed', clientMsgId: 'nope' }),
        ).toHaveLength(1);
        expect(
            outboxReducer(sending, { type: 'removed', clientMsgId: 'a' }),
        ).toEqual([]);
    });
});

describe('pendingOutbox', () => {
    it('drops an entry once the server copy named by the POST answer is in the transcript', () => {
        const stored = makeWaReply({ body: 'On my way' });
        const open = pendingOutbox(
            [stored],
            [entry({ serverUlid: stored.ulid, body: 'different text' })],
            ME.id,
        );

        expect(open).toEqual([]);
    });

    it('recognises the server copy of a reply by what it is when the answer never came: same text, same sender, newer than what was known', () => {
        const known = makeWaMessage();
        const stored = makeWaReply({ body: '  On my way  ' });
        const open = pendingOutbox(
            [known, stored],
            [entry({ after: known.ulid })],
            ME.id,
        );

        expect(open).toEqual([]);
    });

    it('never mistakes an older message, another administrator or the customer for the reply', () => {
        const old = makeWaReply({ body: 'On my way' });
        const colleague = makeWaReply({
            body: 'On my way',
            sentBy: { id: 2, name: 'Bo' },
        });
        const customer = makeWaMessage({ body: 'On my way' });
        const mine = entry({ after: highestUlid([old]) });

        expect(pendingOutbox([old], [mine], ME.id)).toHaveLength(1);

        const later = makeWaReply({ body: 'On my way' });

        // `colleague` and `customer` were created after `old`, so they are newer than the reply's baseline too: still not it.
        expect(
            pendingOutbox([old, colleague, customer], [mine], ME.id),
        ).toHaveLength(1);
        expect(
            pendingOutbox([old, colleague, customer, later], [mine], ME.id),
        ).toEqual([]);
    });

    it('lets one server message answer one entry: two identical replies stay two bubbles until both are stored', () => {
        const first = entry({ clientMsgId: 'a' });
        const second = entry({ clientMsgId: 'b' });
        const one = makeWaReply({ body: 'On my way' });
        const two = makeWaReply({ body: 'On my way' });

        expect(
            pendingOutbox([one], [first, second], ME.id).map(
                (e) => e.clientMsgId,
            ),
        ).toEqual(['b']);
        expect(pendingOutbox([one, two], [first, second], ME.id)).toEqual([]);
    });

    it('keeps a failed entry when nothing matches (the server never stored it)', () => {
        const failed = entry({ state: 'failed', failure: 'session_not_ready' });

        expect(pendingOutbox([], [failed], ME.id)).toEqual([failed]);
    });
});

describe('displayMessages', () => {
    it('lists the server messages first and the waiting replies after them, dressed as messages with a local marker', () => {
        const stored = makeWaMessage();
        const shown = displayMessages(
            [stored],
            [
                entry({ clientMsgId: 'a' }),
                entry({
                    clientMsgId: 'b',
                    state: 'failed',
                    failure: 'daily_cap',
                    body: 'Second',
                }),
            ],
            'chat-1',
            ME,
        );

        expect(shown.map((m) => m.ulid)).toEqual([stored.ulid, 'a', 'b']);
        expect(shown[1]).toMatchObject({
            direction: 'out',
            status: 'pending',
            chat: 'chat-1',
            sentBy: ME,
            local: { clientMsgId: 'a', failure: null },
        });
        expect(shown[2]).toMatchObject({
            status: 'failed',
            local: { failure: 'daily_cap' },
        });
        expect(shown[0].local).toBeUndefined();
    });
});

describe('syncCursor', () => {
    it('starts right after the newest message when every reply of ours is settled', () => {
        const a = makeWaMessage();
        const b = makeWaReply({ status: 'read' });
        const c = makeWaMessage({ direction: 'in' });

        expect(syncCursor([a, b, c])).toBe(c.ulid);
        expect(syncCursor([])).toBeNull();
    });

    it('starts before the oldest reply that has not reached its final status (an ack changes a row without adding one)', () => {
        const a = makeWaMessage();
        const b = makeWaReply({ status: 'read' });
        const c = makeWaReply({ status: 'sent' });
        const d = makeWaMessage();

        expect(syncCursor([a, b, c, d])).toBe(b.ulid);
        // The unsettled one is the first the browser holds: read the latest page.
        expect(syncCursor([c, d])).toBeNull();
        // Only the recent window is looked at.
        const old = makeWaReply({ status: 'sent' });
        const recent = Array.from({ length: 5 }, () => makeWaMessage());

        expect(syncCursor([old, ...recent], 5)).toBe(recent.at(-1)?.ulid);
    });
});

describe('send failures', () => {
    const error = (code: string, status: number, details = {}) =>
        new ApiError({ status, code, message: 'x', details });

    it('maps what the API said to a failure the bubble can explain', () => {
        expect(sendFailureOf(error('session_not_ready', 409))).toBe(
            'session_not_ready',
        );
        expect(sendFailureOf(error('daily_cap_reached', 429))).toBe(
            'daily_cap',
        );
        expect(sendFailureOf(error('SEND_PACING_LIMITED', 429))).toBe('pacing');
        expect(sendFailureOf(error('whatever', 429))).toBe('rate_limited');
        expect(sendFailureOf(error('reply_only_to_inbound', 409))).toBe(
            'not_inbound',
        );
        expect(sendFailureOf(error('forbidden', 403))).toBe('forbidden');
        expect(
            sendFailureOf(error('validation_failed', 422, { body: ['x'] })),
        ).toBe('too_long');
        expect(
            sendFailureOf(error('validation_failed', 422, { x: ['y'] })),
        ).toBe('rejected');
        expect(sendFailureOf(error('network', 0))).toBe('network');
        expect(sendFailureOf(error('server_error', 500))).toBe('unknown');
        expect(sendFailureOf(new Error('boom'))).toBe('unknown');
    });

    it('says which failures are final and which leave the reply possibly stored', () => {
        expect(isFinalSendFailure('not_inbound')).toBe(true);
        expect(isFinalSendFailure('too_long')).toBe(true);
        expect(isFinalSendFailure('session_not_ready')).toBe(false);
        expect(isFinalSendFailure('pacing')).toBe(false);
        expect(isFinalSendFailure(null)).toBe(false);
        expect(isUncertainSendFailure('network')).toBe(true);
        expect(isUncertainSendFailure('unknown')).toBe(true);
        expect(isUncertainSendFailure('daily_cap')).toBe(false);
    });
});
