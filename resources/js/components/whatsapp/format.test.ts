import { describe, expect, it } from 'vite-plus/test';
import { buildWaEntries } from '@/components/whatsapp/format';
import { makeWaMessage } from '@/lib/whatsapp/fixtures';

describe('buildWaEntries', () => {
    it("dates a message by WhatsApp's own time, not by when it was recorded", () => {
        const delayed = makeWaMessage({
            waTimestamp: '2026-11-20T10:00:00.000Z',
            createdAt: '2026-11-25T10:00:00.000Z',
        });

        const entries = buildWaEntries([delayed]);

        expect(entries[0]).toMatchObject({
            kind: 'day',
            iso: '2026-11-20T10:00:00.000Z',
        });
    });

    it("starts a new day divider when WhatsApp's days differ, even if both were recorded at once", () => {
        const a = makeWaMessage({
            waTimestamp: '2026-11-20T10:00:00.000Z',
            createdAt: '2026-11-25T10:00:00.000Z',
        });
        const b = makeWaMessage({
            waTimestamp: '2026-11-23T10:00:00.000Z',
            createdAt: '2026-11-25T10:00:01.000Z',
        });

        expect(
            buildWaEntries([a, b]).filter((entry) => entry.kind === 'day'),
        ).toHaveLength(2);
    });
});
