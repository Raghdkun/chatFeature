import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
    applyDelivered,
    applySeen,
    createPendingMessage,
    findGap,
    highestSeq,
    highestSeqFrom,
    isPending,
    mergeMessages,
    setPendingStatus,
    toLocalMessage,
} from '@/lib/chat/messages';
import {
    fakeTime,
    makeAgentMessage,
    makeMessage,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { LocalMessage, MessageData } from '@/lib/chat/types';

const CONVERSATION = '01JFAKE000000000000000ABCD';

function server(
    seq: number,
    overrides: Partial<MessageData> = {},
): MessageData {
    return makeMessage({
        seq,
        ulid: `01JFAKE0000000000000000${String(seq).padStart(3, '0')}`,
        conversation: CONVERSATION,
        body: `Message ${seq}`,
        createdAt: fakeTime(seq),
        ...overrides,
    });
}

function pending(clientMsgId: string, body = 'typing…'): LocalMessage {
    return createPendingMessage({
        clientMsgId,
        conversation: CONVERSATION,
        sender: { type: 'visitor', name: 'Vera Visitor', avatarUrl: null },
        body,
        createdAt: fakeTime(500),
    });
}

const seqs = (messages: readonly LocalMessage[]) =>
    messages.map((message) => message.seq);

beforeEach(() => resetFixtures());

describe('toLocalMessage', () => {
    it('derives the status from the receipts', () => {
        expect(toLocalMessage(server(1)).status).toBe('sent');
        expect(
            toLocalMessage(server(1, { deliveredAt: fakeTime(2) })).status,
        ).toBe('delivered');
        expect(
            toLocalMessage(
                server(1, { deliveredAt: fakeTime(2), seenAt: fakeTime(3) }),
            ).status,
        ).toBe('seen');
        expect(toLocalMessage(server(1, { seenAt: fakeTime(3) })).status).toBe(
            'seen',
        );
    });

    it('keeps every server field', () => {
        const message = server(4, { body: 'Hi' });

        expect(toLocalMessage(message)).toEqual({ ...message, status: 'sent' });
    });
});

describe('createPendingMessage', () => {
    it('is an unsent text message without ulid and seq', () => {
        const message = pending('01JCLIENT0000000000000000A');

        expect(message).toMatchObject({
            ulid: null,
            seq: null,
            status: 'sending',
            type: 'text',
            clientMsgId: '01JCLIENT0000000000000000A',
            deliveredAt: null,
            seenAt: null,
            attachments: [],
        });
        expect(isPending(message)).toBe(true);
    });

    it('is an image message when it carries attachments', () => {
        const message = createPendingMessage({
            clientMsgId: 'c1',
            conversation: CONVERSATION,
            sender: { type: 'visitor', name: null, avatarUrl: null },
            body: null,
            createdAt: fakeTime(1),
            attachments: [
                {
                    ulid: 'a1',
                    mime: 'image/png',
                    size: 1,
                    width: 1,
                    height: 1,
                    url: 'u',
                    thumbUrl: null,
                },
            ],
        });

        expect(message.type).toBe('image');
    });
});

describe('mergeMessages', () => {
    it('orders messages by seq whatever order they arrive in', () => {
        const merged = mergeMessages([], [server(3), server(1), server(2)]);

        expect(seqs(merged)).toEqual([1, 2, 3]);
        expect(merged.every((message) => message.status === 'sent')).toBe(true);
    });

    it('merges a later batch into the right place', () => {
        const first = mergeMessages([], [server(1), server(4)]);
        const second = mergeMessages(first, [server(3), server(2), server(5)]);

        expect(seqs(second)).toEqual([1, 2, 3, 4, 5]);
    });

    it('collapses duplicates inside one batch and across batches', () => {
        const once = mergeMessages([], [server(1), server(1), server(2)]);
        const twice = mergeMessages(once, [server(2), server(1)]);

        expect(seqs(once)).toEqual([1, 2]);
        expect(seqs(twice)).toEqual([1, 2]);
    });

    it('is idempotent and returns the same array when nothing changed', () => {
        const batch = [server(1), server(2), server(3)];
        const merged = mergeMessages([], batch);

        expect(mergeMessages(merged, batch)).toBe(merged);
        expect(mergeMessages(mergeMessages(merged, batch), batch)).toEqual(
            merged,
        );
        expect(mergeMessages(merged, [])).toBe(merged);
    });

    it('keeps untouched messages by reference when another one changes', () => {
        const merged = mergeMessages([], [server(1), server(2)]);
        const updated = mergeMessages(merged, [
            server(2, { deliveredAt: fakeTime(9) }),
        ]);

        expect(updated).not.toBe(merged);
        expect(updated[0]).toBe(merged[0]);
        expect(updated[1].status).toBe('delivered');
    });

    it('does not mutate its inputs', () => {
        const existing = Object.freeze([
            Object.freeze(toLocalMessage(server(2))),
        ]) as readonly LocalMessage[];
        const incoming = Object.freeze([Object.freeze(server(1))]);

        const merged = mergeMessages(existing, incoming);

        expect(seqs(existing)).toEqual([2]);
        expect(seqs(merged)).toEqual([1, 2]);
    });

    describe('optimistic sends', () => {
        const clientMsgId = '01JCLIENT0000000000000000A';

        it('replaces the optimistic copy by client_msg_id once the server acknowledges it', () => {
            const sending = mergeMessages(
                mergeMessages([], [server(1), server(2)]),
                [pending(clientMsgId, 'Hello')],
            );

            expect(seqs(sending)).toEqual([1, 2, null]);
            expect(sending[2].status).toBe('sending');

            const acknowledged = mergeMessages(sending, [
                server(3, { clientMsgId, body: 'Hello' }),
            ]);

            expect(acknowledged).toHaveLength(3);
            expect(acknowledged[2]).toMatchObject({
                seq: 3,
                ulid: expect.stringMatching(/^01JFAKE/),
                status: 'sent',
                body: 'Hello',
                clientMsgId,
            });
            expect(isPending(acknowledged[2])).toBe(false);
        });

        it('shows one message when the broadcast and the REST response both arrive', () => {
            const sending = mergeMessages([], [pending(clientMsgId)]);
            const ack = server(1, { clientMsgId });

            const viaRest = mergeMessages(sending, [ack]);
            const viaBroadcast = mergeMessages(viaRest, [ack]);

            expect(viaBroadcast).toHaveLength(1);
            expect(viaBroadcast).toBe(viaRest);
        });

        it('keeps the server copy when the broadcast beats the optimistic one', () => {
            const broadcast = mergeMessages([], [server(1, { clientMsgId })]);
            const late = mergeMessages(broadcast, [pending(clientMsgId)]);

            expect(late).toBe(broadcast);
            expect(late[0].seq).toBe(1);
            expect(late[0].status).toBe('sent');
        });

        it('puts sequenced messages before unsent ones and keeps unsent ones in creation order', () => {
            const list = mergeMessages([], [pending('a'), pending('b')]);
            const merged = mergeMessages(list, [server(2), server(1)]);

            expect(seqs(merged)).toEqual([1, 2, null, null]);
            expect(
                merged.slice(2).map((message) => message.clientMsgId),
            ).toEqual(['a', 'b']);
        });

        it('does not mistake unsent messages without a client id for one another', () => {
            const a = { ...pending('a'), clientMsgId: null };
            const b = { ...pending('b'), clientMsgId: null };

            expect(mergeMessages([], [a, b])).toHaveLength(2);
        });

        it('lets a failed message be retried and then acknowledged', () => {
            const failed = setPendingStatus(
                mergeMessages([], [pending(clientMsgId)]),
                clientMsgId,
                'failed',
            );

            expect(failed[0].status).toBe('failed');

            const retrying = setPendingStatus(failed, clientMsgId, 'sending');
            expect(retrying[0].status).toBe('sending');

            const done = mergeMessages(retrying, [server(1, { clientMsgId })]);
            expect(done).toHaveLength(1);
            expect(done[0].status).toBe('sent');
        });

        it('replaces a failed copy when the message turns out to have been stored', () => {
            const failed = setPendingStatus(
                mergeMessages([], [pending(clientMsgId)]),
                clientMsgId,
                'failed',
            );

            const done = mergeMessages(failed, [server(7, { clientMsgId })]);

            expect(done).toHaveLength(1);
            expect(done[0]).toMatchObject({ seq: 7, status: 'sent' });
        });
    });

    describe('identity', () => {
        it('matches the same message by ulid, seq or client id', () => {
            const base = mergeMessages([], [server(1, { clientMsgId: 'c1' })]);

            expect(
                mergeMessages(base, [
                    { ...server(9), ulid: base[0].ulid as string },
                ]),
            ).toHaveLength(1);
            expect(
                mergeMessages(base, [
                    { ...server(1), ulid: 'another', clientMsgId: null },
                ]),
            ).toHaveLength(1);
            expect(
                mergeMessages(base, [
                    { ...server(9), ulid: 'other', clientMsgId: 'c1' },
                ]),
            ).toHaveLength(1);
            expect(mergeMessages(base, [server(2)])).toHaveLength(2);
        });

        it('lets the server copy win on content', () => {
            const base = mergeMessages([], [pending('c1', 'draft text')]);
            const merged = mergeMessages(base, [
                server(1, { clientMsgId: 'c1', body: 'final text' }),
            ]);

            expect(merged[0].body).toBe('final text');
        });
    });

    describe('receipts only move forward', () => {
        it('never turns a seen message back into a delivered or sent one', () => {
            const seen = mergeMessages(
                [],
                [server(1, { deliveredAt: fakeTime(5), seenAt: fakeTime(6) })],
            );

            const stale = mergeMessages(seen, [server(1)]);
            const staler = mergeMessages(stale, [
                server(1, { deliveredAt: fakeTime(5) }),
            ]);

            expect(stale).toBe(seen);
            expect(staler[0]).toMatchObject({
                status: 'seen',
                seenAt: fakeTime(6),
                deliveredAt: fakeTime(5),
            });
        });

        it('upgrades sent to delivered to seen', () => {
            let list = mergeMessages([], [server(1)]);
            expect(list[0].status).toBe('sent');

            list = mergeMessages(list, [
                server(1, { deliveredAt: fakeTime(2) }),
            ]);
            expect(list[0].status).toBe('delivered');

            list = mergeMessages(list, [
                server(1, { deliveredAt: fakeTime(2), seenAt: fakeTime(3) }),
            ]);
            expect(list[0].status).toBe('seen');
        });

        it('keeps the latest delivered and seen times', () => {
            let list = mergeMessages(
                [],
                [server(1, { deliveredAt: fakeTime(2) })],
            );
            list = mergeMessages(list, [
                server(1, { deliveredAt: fakeTime(8), seenAt: fakeTime(9) }),
            ]);

            expect(list[0].deliveredAt).toBe(fakeTime(8));
            expect(list[0].seenAt).toBe(fakeTime(9));
        });
    });

    it('handles agent and system messages like any other', () => {
        const merged = mergeMessages(
            [],
            [
                makeSystemMessage({ seq: 2, ulid: 'S2' }),
                makeAgentMessage({ seq: 3, ulid: 'A3' }),
                server(1),
            ],
        );

        expect(merged.map((message) => message.sender.type)).toEqual([
            'visitor',
            'system',
            'agent',
        ]);
    });
});

describe('mergeMessages convergence', () => {
    // A tiny seeded generator keeps the shuffles reproducible.
    function rng(seed: number): () => number {
        let state = seed;

        return () => {
            state = (state * 1664525 + 1013904223) % 4294967296;

            return state / 4294967296;
        };
    }

    it('ends in the same list whatever the order, chunking and repetition of arrival', () => {
        const messages = Array.from({ length: 12 }, (_, index) =>
            server(index + 1, {
                clientMsgId: index % 3 === 0 ? `client-${index}` : null,
            }),
        );
        const expected = mergeMessages([], messages);

        for (let seed = 1; seed <= 25; seed++) {
            const random = rng(seed);
            const stream = [...messages, ...messages.slice(0, 5)];

            for (let i = stream.length - 1; i > 0; i--) {
                const j = Math.floor(random() * (i + 1));
                [stream[i], stream[j]] = [stream[j], stream[i]];
            }

            let list: LocalMessage[] = [];

            // Optimistic copies of the messages that carry a client id show up first.
            for (const message of messages) {
                if (message.clientMsgId !== null) {
                    list = mergeMessages(list, [pending(message.clientMsgId)]);
                }
            }

            for (let at = 0; at < stream.length;) {
                const size = 1 + Math.floor(random() * 4);
                list = mergeMessages(list, stream.slice(at, at + size));
                at += size;
            }

            expect(list, `seed ${seed}`).toEqual(expected);
        }
    });
});

describe('highestSeq / highestSeqFrom', () => {
    it('ignores unsent messages', () => {
        const list = mergeMessages([], [server(1), server(4), pending('x')]);

        expect(highestSeq(list)).toBe(4);
        expect(highestSeq([])).toBe(0);
        expect(highestSeq([pending('x')])).toBe(0);
    });

    it('finds the newest message of one side', () => {
        const list = mergeMessages(
            [],
            [
                server(1),
                makeAgentMessage({ seq: 2, ulid: 'A2' }),
                server(3),
                makeAgentMessage({ seq: 4, ulid: 'A4' }),
            ],
        );

        expect(highestSeqFrom(list, 'visitor')).toBe(3);
        expect(highestSeqFrom(list, 'agent')).toBe(4);
        expect(highestSeqFrom(list, 'system')).toBe(0);
    });
});

describe('findGap', () => {
    it('finds nothing when the list is complete or the conversation is empty', () => {
        expect(findGap([], 0)).toBeNull();
        expect(findGap([{ seq: 1 }, { seq: 2 }, { seq: 3 }], 3)).toBeNull();
        expect(findGap([], Number.NaN)).toBeNull();
        expect(findGap([{ seq: 1 }], -4)).toBeNull();
    });

    it('reports a hole in the middle with the after_seq to fetch from', () => {
        expect(findGap([{ seq: 1 }, { seq: 2 }, { seq: 5 }], 5)).toEqual({
            afterSeq: 2,
            ranges: [{ from: 3, to: 4 }],
            count: 2,
        });
    });

    it('reports messages missing at the end', () => {
        expect(findGap([{ seq: 1 }, { seq: 2 }], 4)).toEqual({
            afterSeq: 2,
            ranges: [{ from: 3, to: 4 }],
            count: 2,
        });
    });

    it('reports a list that has nothing yet', () => {
        expect(findGap([], 3)).toEqual({
            afterSeq: 0,
            ranges: [{ from: 1, to: 3 }],
            count: 3,
        });
    });

    it('reports several holes and starts after the first one', () => {
        expect(
            findGap([{ seq: 1 }, { seq: 3 }, { seq: 4 }, { seq: 7 }], 8),
        ).toEqual({
            afterSeq: 1,
            ranges: [
                { from: 2, to: 2 },
                { from: 5, to: 6 },
                { from: 8, to: 8 },
            ],
            count: 4,
        });
    });

    it('does not care about order, duplicates, unsent messages or seqs beyond lastSeq', () => {
        const list = mergeMessages(
            [],
            [server(3), server(1), pending('x'), server(9)],
        );

        expect(findGap([...list, ...list], 3)).toEqual({
            afterSeq: 1,
            ranges: [{ from: 2, to: 2 }],
            count: 1,
        });
        expect(findGap([{ seq: 1 }, { seq: 2 }, { seq: 9 }], 2)).toBeNull();
    });

    it('detects a gap when a message arrives out of order and heals once it is fetched', () => {
        const held = mergeMessages([], [server(1), server(2)]);
        const afterArrival = mergeMessages(held, [server(5)]);

        expect(findGap(afterArrival, highestSeq(afterArrival))).toEqual({
            afterSeq: 2,
            ranges: [{ from: 3, to: 4 }],
            count: 2,
        });

        const healed = mergeMessages(afterArrival, [server(3), server(4)]);
        expect(findGap(healed, highestSeq(healed))).toBeNull();
    });
});

describe('applySeen', () => {
    const conversation = () =>
        mergeMessages(
            [],
            [
                server(1),
                makeAgentMessage({
                    seq: 2,
                    ulid: 'A2',
                    conversation: CONVERSATION,
                }),
                makeSystemMessage({
                    seq: 3,
                    ulid: 'S3',
                    conversation: CONVERSATION,
                }),
                makeAgentMessage({
                    seq: 4,
                    ulid: 'A4',
                    conversation: CONVERSATION,
                }),
                server(5),
            ],
        );

    it('marks the other side’s messages up to the receipt as seen and delivered', () => {
        const next = applySeen(conversation(), {
            upToSeq: 2,
            by: 'visitor',
            at: fakeTime(30),
        });

        expect(next.map((message) => message.status)).toEqual([
            'sent',
            'seen',
            'sent',
            'sent',
            'sent',
        ]);
        expect(next[1].seenAt).toBe(fakeTime(30));
        expect(next[1].deliveredAt).toBe(fakeTime(30));
    });

    it('works the other way round for the agent’s receipt', () => {
        const next = applySeen(conversation(), {
            upToSeq: 5,
            by: 'agent',
            at: fakeTime(30),
        });

        expect(next.map((message) => message.status)).toEqual([
            'seen',
            'sent',
            'sent',
            'sent',
            'seen',
        ]);
    });

    it('never receipts system lines or unsent messages', () => {
        const withPending = mergeMessages(conversation(), [pending('p')]);
        const next = applySeen(withPending, {
            upToSeq: 99,
            by: 'agent',
            at: fakeTime(30),
        });

        expect(next[2].status).toBe('sent');
        expect(next[5].status).toBe('sending');
    });

    it('keeps an earlier delivered time and is idempotent', () => {
        const delivered = mergeMessages(conversation(), [
            makeAgentMessage({
                seq: 2,
                ulid: 'A2',
                conversation: CONVERSATION,
                deliveredAt: fakeTime(10),
            }),
        ]);
        const once = applySeen(delivered, {
            upToSeq: 2,
            by: 'visitor',
            at: fakeTime(30),
        });
        const twice = applySeen(once, {
            upToSeq: 2,
            by: 'visitor',
            at: fakeTime(60),
        });

        expect(once[1].deliveredAt).toBe(fakeTime(10));
        expect(twice).toBe(once);
        expect(twice[1].seenAt).toBe(fakeTime(30));
    });

    it('returns the same list when there is nothing to mark', () => {
        const list = conversation();

        expect(
            applySeen(list, { upToSeq: 0, by: 'visitor', at: fakeTime(1) }),
        ).toBe(list);
    });
});

describe('applyDelivered', () => {
    const conversation = () =>
        mergeMessages(
            [],
            [
                server(1),
                makeAgentMessage({
                    seq: 2,
                    ulid: 'A2',
                    conversation: CONVERSATION,
                }),
                makeSystemMessage({
                    seq: 3,
                    ulid: 'S3',
                    conversation: CONVERSATION,
                }),
                makeAgentMessage({
                    seq: 4,
                    ulid: 'A4',
                    conversation: CONVERSATION,
                }),
                server(5),
            ],
        );

    it('marks the other side’s messages up to the receipt as delivered, not seen', () => {
        const next = applyDelivered(conversation(), {
            upToSeq: 2,
            by: 'visitor',
            at: fakeTime(30),
        });

        expect(next.map((message) => message.status)).toEqual([
            'sent',
            'delivered',
            'sent',
            'sent',
            'sent',
        ]);
        expect(next[1].deliveredAt).toBe(fakeTime(30));
        expect(next[1].seenAt).toBeNull();
    });

    it('works the other way round for the agent’s client', () => {
        const next = applyDelivered(conversation(), {
            upToSeq: 5,
            by: 'agent',
            at: fakeTime(30),
        });

        expect(next.map((message) => message.status)).toEqual([
            'delivered',
            'sent',
            'sent',
            'sent',
            'delivered',
        ]);
    });

    it('never moves backwards: a seen message stays seen, an earlier delivered time stays', () => {
        const withReceipts = mergeMessages(conversation(), [
            makeAgentMessage({
                seq: 2,
                ulid: 'A2',
                conversation: CONVERSATION,
                deliveredAt: fakeTime(10),
                seenAt: fakeTime(20),
            }),
            makeAgentMessage({
                seq: 4,
                ulid: 'A4',
                conversation: CONVERSATION,
                deliveredAt: fakeTime(11),
            }),
        ]);
        const next = applyDelivered(withReceipts, {
            upToSeq: 9,
            by: 'visitor',
            at: fakeTime(60),
        });

        expect(next).toBe(withReceipts);
        expect(next[1]).toMatchObject({
            status: 'seen',
            deliveredAt: fakeTime(10),
            seenAt: fakeTime(20),
        });
        expect(next[3].deliveredAt).toBe(fakeTime(11));
    });

    it('is the same list when applied twice or after the seen receipt', () => {
        const once = applyDelivered(conversation(), {
            upToSeq: 4,
            by: 'visitor',
            at: fakeTime(30),
        });
        const twice = applyDelivered(once, {
            upToSeq: 4,
            by: 'visitor',
            at: fakeTime(31),
        });
        const seen = applySeen(once, {
            upToSeq: 4,
            by: 'visitor',
            at: fakeTime(40),
        });
        const lateDelivery = applyDelivered(seen, {
            upToSeq: 4,
            by: 'visitor',
            at: fakeTime(41),
        });

        expect(twice).toBe(once);
        expect(seen[1].status).toBe('seen');
        expect(lateDelivery).toBe(seen);
    });

    it('never receipts system lines, unsent messages or the sender’s own side', () => {
        const withPending = mergeMessages(conversation(), [pending('p')]);
        const next = applyDelivered(withPending, {
            upToSeq: 99,
            by: 'agent',
            at: fakeTime(30),
        });

        expect(next[1].status).toBe('sent');
        expect(next[2].status).toBe('sent');
        expect(next[5].status).toBe('sending');
        expect(next[5].deliveredAt).toBeNull();
    });

    it('returns the same list when there is nothing to mark', () => {
        const list = conversation();

        expect(
            applyDelivered(list, {
                upToSeq: 0,
                by: 'visitor',
                at: fakeTime(1),
            }),
        ).toBe(list);
        expect(
            applyDelivered(list, { upToSeq: 9, by: 'system', at: fakeTime(1) }),
        ).toBe(list);
    });
});

describe('setPendingStatus', () => {
    it('only touches the matching unsent message', () => {
        const list = mergeMessages(
            [],
            [server(1, { clientMsgId: 'c1' }), pending('c2')],
        );

        expect(setPendingStatus(list, 'c1', 'failed')).toBe(list);
        expect(setPendingStatus(list, 'nope', 'failed')).toBe(list);
        expect(setPendingStatus(list, 'c2', 'sending')).toBe(list);
        expect(setPendingStatus(list, 'c2', 'failed')[1].status).toBe('failed');
    });
});
