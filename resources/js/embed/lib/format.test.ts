import { describe, expect, it } from 'vite-plus/test';
import {
    dayKey,
    formatBytes,
    formatDay,
    formatElapsed,
    formatNextOpen,
    formatTime,
} from '@/embed/lib/format';

describe('format', () => {
    it('formats the queue timer', () => {
        expect(formatElapsed(0)).toBe('0:00');
        expect(formatElapsed(9_000)).toBe('0:09');
        expect(formatElapsed(75_000)).toBe('1:15');
        expect(formatElapsed(3_725_000)).toBe('1:02:05');
        expect(formatElapsed(-5000)).toBe('0:00');
    });

    it('formats byte sizes', () => {
        expect(formatBytes(5 * 1024 * 1024)).toBe('5 MB');
        expect(formatBytes(1.5 * 1024 * 1024)).toBe('1.5 MB');
        expect(formatBytes(2048)).toBe('2 KB');
        expect(formatBytes(10)).toBe('1 KB');
    });

    it('labels days as Today / Yesterday / a short date, in the locale', () => {
        const now = new Date(2026, 10, 20, 15, 0).getTime();
        const at = (y: number, m: number, d: number, h = 9) =>
            new Date(y, m, d, h).toISOString();

        expect(formatDay(at(2026, 10, 20), 'en', now)).toBe('Today');
        expect(formatDay(at(2026, 10, 19, 23), 'en', now)).toBe('Yesterday');
        expect(formatDay(at(2026, 10, 12), 'en', now)).toMatch(/Nov/);
        expect(formatDay(at(2025, 10, 12), 'en', now)).toMatch(/2025/);
        expect(formatDay('nonsense', 'en', now)).toBe('');
        // Arabic uses its own words
        expect(formatDay(at(2026, 10, 20), 'ar', now)).not.toBe('Today');
    });

    it('formats times and tolerates garbage', () => {
        expect(
            formatTime(new Date(2026, 10, 20, 14, 5).toISOString(), 'en-US'),
        ).toMatch(/2:05\s?PM/);
        expect(formatTime('nope', 'en')).toBe('');
    });

    it("groups by the visitor's calendar day", () => {
        expect(dayKey(new Date(2026, 0, 5, 23, 59).toISOString())).toBe(
            '2026-01-05',
        );
        expect(dayKey('nope')).toBe('');
    });

    it('describes when the widget reopens', () => {
        const now = new Date(2026, 10, 20, 15, 0).getTime();

        expect(
            formatNextOpen(
                new Date(2026, 10, 20, 17, 30).toISOString(),
                'en-US',
                now,
            ),
        ).toMatch(/5:30\s?PM/);
        expect(
            formatNextOpen(
                new Date(2026, 10, 23, 9, 0).toISOString(),
                'en-US',
                now,
            ),
        ).toMatch(/Monday/);
    });
});
