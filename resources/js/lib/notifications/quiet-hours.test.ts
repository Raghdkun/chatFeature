import { describe, expect, it } from 'vite-plus/test';
import { isQuietNow, minutesInZone } from '@/lib/notifications/quiet-hours';

const hours = (
    start: string,
    end: string,
    timezone: string,
    enabled = true,
) => ({
    enabled,
    start,
    end,
    timezone,
});

/** The same matrix as tests/Unit/Notifications/QuietHoursTest.php: the page and the server must agree on every minute. */
const MATRIX: [string, string, string, string, boolean][] = [
    ['09:00', '17:00', 'UTC', '2026-11-20T12:00:00Z', true],
    ['09:00', '17:00', 'UTC', '2026-11-20T09:00:00Z', true],
    ['09:00', '17:00', 'UTC', '2026-11-20T17:00:00Z', false],
    ['09:00', '17:00', 'UTC', '2026-11-20T08:59:00Z', false],
    ['22:00', '07:00', 'UTC', '2026-11-20T23:30:00Z', true],
    ['22:00', '07:00', 'UTC', '2026-11-21T03:00:00Z', true],
    ['22:00', '07:00', 'UTC', '2026-11-21T06:59:00Z', true],
    ['22:00', '07:00', 'UTC', '2026-11-21T07:00:00Z', false],
    ['22:00', '07:00', 'UTC', '2026-11-20T15:00:00Z', false],
    ['22:00', '07:00', 'Asia/Riyadh', '2026-11-20T20:30:00Z', true],
    ['22:00', '07:00', 'UTC', '2026-11-20T20:30:00Z', false],
    ['22:00', '07:00', 'America/New_York', '2026-11-21T03:00:00Z', true],
    ['22:00', '07:00', 'Europe/Berlin', '2026-07-01T20:30:00Z', true],
];

describe('isQuietNow', () => {
    it.each(MATRIX)(
        '%s - %s in %s at %s is quiet: %s',
        (start, end, timezone, at, expected) => {
            expect(isQuietNow(hours(start, end, timezone), new Date(at))).toBe(
                expected,
            );
        },
    );

    it('is never quiet when switched off, missing or empty', () => {
        const at = new Date('2026-11-20T12:00:00Z');

        expect(isQuietNow(hours('00:00', '23:59', 'UTC', false), at)).toBe(
            false,
        );
        expect(isQuietNow(null, at)).toBe(false);
        expect(isQuietNow(undefined, at)).toBe(false);
        expect(
            isQuietNow(
                hours('08:00', '08:00', 'UTC'),
                new Date('2026-11-20T08:00:00Z'),
            ),
        ).toBe(false);
    });

    it('falls back to UTC for a zone the browser does not know instead of throwing', () => {
        expect(
            isQuietNow(
                hours('22:00', '07:00', 'Mars/Olympus'),
                new Date('2026-11-20T23:00:00Z'),
            ),
        ).toBe(true);
        expect(
            minutesInZone(new Date('2026-11-20T01:30:00Z'), 'Nowhere/Land'),
        ).toBe(90);
    });

    it('reads malformed times as no window', () => {
        expect(isQuietNow(hours('25:00', 'late', 'UTC'), new Date())).toBe(
            false,
        );
    });
});
