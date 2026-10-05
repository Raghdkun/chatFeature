import { describe, expect, it } from 'vite-plus/test';
import {
    WA_STATUS_TRANSITIONS,
    advanceWaStatus,
    canAdvanceWaStatus,
    mergeWaMessages,
} from '@/lib/whatsapp/messages';
import type { WaMessage, WaMessageStatus } from '@/lib/whatsapp/types';
import phpEnum from '../../../../app/Domain/WhatsApp/Enums/WaMessageStatus.php?raw';

const message = (overrides: Partial<WaMessage> = {}): WaMessage => ({
    ulid: '01JABC00000000000000000001',
    chat: '01JCHAT0000000000000000001',
    direction: 'out',
    type: 'text',
    body: 'Hello',
    media: null,
    status: 'sent',
    error: null,
    sentBy: { id: 1, name: 'Ada' },
    waTimestamp: '2026-11-25T10:00:00.000Z',
    createdAt: '2026-11-25T10:00:00.000Z',
    ...overrides,
});

describe('WhatsApp message status', () => {
    it('is the table of the PHP enum (a change there must be followed here)', () => {
        const arms = new Map<string, string[]>();
        const table = /self::(\w+)((?:, self::\w+)*) => \[([^\]]*)\]/g;

        for (const match of phpEnum.matchAll(table)) {
            const targets = [...match[3].matchAll(/self::(\w+)/g)].map((m) =>
                m[1].toLowerCase(),
            );

            for (const from of [
                match[1],
                ...[...match[2].matchAll(/self::(\w+)/g)].map((m) => m[1]),
            ]) {
                arms.set(from.toLowerCase(), targets);
            }
        }

        expect(Object.fromEntries(arms)).toEqual(WA_STATUS_TRANSITIONS);
    });

    it('moves forward only', () => {
        expect(advanceWaStatus('sent', 'delivered')).toBe('delivered');
        expect(advanceWaStatus('sent', 'read')).toBe('read');
        expect(advanceWaStatus('read', 'delivered')).toBe('read');
        expect(advanceWaStatus('delivered', 'failed')).toBe('delivered');
        expect(advanceWaStatus('pending', 'failed')).toBe('failed');
        expect(advanceWaStatus('failed', 'sent')).toBe('failed');
        expect(advanceWaStatus('received', 'read')).toBe('received');
    });

    it('never advances a status to itself', () => {
        for (const status of Object.keys(
            WA_STATUS_TRANSITIONS,
        ) as WaMessageStatus[]) {
            expect(canAdvanceWaStatus(status, status)).toBe(false);
        }
    });
});

describe('mergeWaMessages', () => {
    it('adds new messages oldest first', () => {
        const later = message({
            ulid: '01JABC00000000000000000002',
            createdAt: '2026-11-25T10:05:00.000Z',
        });
        const earlier = message({
            ulid: '01JABC00000000000000000001',
            createdAt: '2026-11-25T10:00:00.000Z',
        });

        expect(mergeWaMessages([later], [earlier]).map((m) => m.ulid)).toEqual([
            earlier.ulid,
            later.ulid,
        ]);
    });

    it('is idempotent and hands back the same array when nothing changed', () => {
        const existing = [message()];

        expect(mergeWaMessages(existing, [message()])).toBe(existing);
        expect(mergeWaMessages(existing, [])).toBe(existing);
    });

    it('lets a late ack never move a message backwards', () => {
        const existing = [message({ status: 'read' })];

        expect(
            mergeWaMessages(existing, [message({ status: 'delivered' })]),
        ).toBe(existing);
    });

    it('takes the status step forward and the rest of the newer copy', () => {
        const merged = mergeWaMessages(
            [message({ status: 'sent' })],
            [message({ status: 'delivered', error: null, body: 'Hello' })],
        );

        expect(merged).toHaveLength(1);
        expect(merged[0].status).toBe('delivered');
    });

    it('shows a failure on a message that was still pending', () => {
        const merged = mergeWaMessages(
            [message({ status: 'pending' })],
            [message({ status: 'failed', error: 'Not on WhatsApp' })],
        );

        expect(merged[0].status).toBe('failed');
        expect(merged[0].error).toBe('Not on WhatsApp');
    });

    it('orders messages created in the same instant by ulid', () => {
        const a = message({ ulid: '01JABC00000000000000000001' });
        const b = message({ ulid: '01JABC00000000000000000002' });

        expect(mergeWaMessages([b], [a]).map((m) => m.ulid)).toEqual([
            a.ulid,
            b.ulid,
        ]);
    });

    it("orders by WhatsApp's own time, not by when this app recorded the message", () => {
        const recordedFirstButSentLater = message({
            ulid: '01JABC00000000000000000001',
            waTimestamp: '2026-11-25T10:00:00.000Z',
            createdAt: '2026-11-25T09:00:00.000Z',
        });
        const recordedLaterButSentEarlier = message({
            ulid: '01JABC00000000000000000002',
            waTimestamp: '2026-11-22T10:00:00.000Z',
            createdAt: '2026-11-25T09:30:00.000Z',
        });

        expect(
            mergeWaMessages(
                [recordedFirstButSentLater],
                [recordedLaterButSentEarlier],
            ).map((m) => m.ulid),
        ).toEqual([
            recordedLaterButSentEarlier.ulid,
            recordedFirstButSentLater.ulid,
        ]);
    });
});
