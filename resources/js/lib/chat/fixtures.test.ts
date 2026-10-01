import { beforeEach, describe, expect, it } from 'vite-plus/test';
import {
    fakeTime,
    fakeUlid,
    makeActiveConversationStaff,
    makeAgentMessage,
    makeAttachment,
    makeConversationPublic,
    makeConversationStaff,
    makeLocalMessage,
    makeMessage,
    makeOffer,
    makePresence,
    makeRating,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { ConversationPublic, ConversationStaff } from '@/lib/chat/types';

const sorted = (value: object) => Object.keys(value).sort();

beforeEach(() => resetFixtures());

describe('fixture builders', () => {
    it('build messages with exactly the contract keys', () => {
        expect(sorted(makeMessage())).toEqual(
            [
                'ulid',
                'seq',
                'conversation',
                'sender',
                'type',
                'body',
                'attachments',
                'clientMsgId',
                'createdAt',
                'deliveredAt',
                'seenAt',
            ].sort(),
        );
        expect(sorted(makeMessage().sender)).toEqual([
            'avatarUrl',
            'name',
            'type',
        ]);
        expect(sorted(makeAttachment())).toEqual(
            [
                'ulid',
                'mime',
                'size',
                'width',
                'height',
                'url',
                'thumbUrl',
            ].sort(),
        );
    });

    it('build the conversation shapes with exactly the contract keys', () => {
        const publicKeys = [
            'ulid',
            'ticketNo',
            'status',
            'type',
            'category',
            'agent',
            'createdAt',
            'endedAt',
            'ratingRequested',
            'lastSeq',
        ];

        expect(sorted(makeConversationPublic())).toEqual(
            [...publicKeys].sort(),
        );
        expect(sorted(makeConversationStaff())).toEqual(
            [
                ...publicKeys,
                'visitor',
                'widget',
                'assignedAgent',
                'unseenByAgent',
                'claimedAt',
                'lastMessageAt',
                'lastMessagePreview',
                'queueExpiresAt',
                'pageUrl',
                'pageTitle',
            ].sort(),
        );
        expect(sorted(makeConversationStaff().visitor)).toEqual(
            ['ulid', 'name', 'email', 'phone', 'verified', 'meta'].sort(),
        );
    });

    it('build the offer, rating and presence payloads', () => {
        expect(sorted(makeOffer())).toEqual(
            [
                'v',
                'conversation',
                'category',
                'visitor',
                'preview',
                'widget',
                'wave',
                'expiresAt',
                'ttlSeconds',
            ].sort(),
        );
        expect(makeOffer().v).toBe(1);
        expect(sorted(makeRating())).toEqual(
            ['conversation', 'score', 'comment', 'createdAt'].sort(),
        );
        expect(sorted(makePresence())).toEqual(
            ['userId', 'status', 'isManual', 'lastSeenAt'].sort(),
        );
    });

    it('make a staff conversation that is also a valid public one', () => {
        const staff: ConversationStaff = makeConversationStaff({
            lastSeq: 4,
            status: 'ended',
        });
        const asPublic: ConversationPublic = staff;

        expect(asPublic.lastSeq).toBe(4);
        expect(asPublic.status).toBe('ended');
    });

    it('accept shallow overrides', () => {
        expect(makeMessage({ body: 'Hi', seq: 7 })).toMatchObject({
            body: 'Hi',
            seq: 7,
        });
        expect(makeAgentMessage().sender.type).toBe('agent');
        expect(makeSystemMessage()).toMatchObject({
            type: 'system',
            sender: { type: 'system' },
        });
        expect(makeActiveConversationStaff()).toMatchObject({
            status: 'active',
            agent: { name: 'Sam' },
            assignedAgent: { id: 7, name: 'Sam' },
        });
        expect(makeLocalMessage({ status: 'failed' }).status).toBe('failed');
        expect(makeLocalMessage().status).toBe('sent');
    });

    it('are deterministic after a reset and unique before it', () => {
        const first = [makeMessage(), makeMessage()];
        expect(first[0].ulid).not.toBe(first[1].ulid);
        expect(first[0].seq).not.toBe(first[1].seq);

        resetFixtures();
        const again = [makeMessage(), makeMessage()];

        expect(again).toEqual(first);
    });

    it('make ULID-shaped ids and ISO times', () => {
        expect(fakeUlid(5)).toMatch(/^[0-9A-Z]{26}$/);
        expect(fakeUlid(5)).not.toBe(fakeUlid(6));
        expect(fakeTime(0)).toBe('2026-11-20T10:00:00.000Z');
        expect(fakeTime(90)).toBe('2026-11-20T10:01:30.000Z');
        expect(makeOffer().expiresAt).toBe(fakeTime(90));
    });
});
