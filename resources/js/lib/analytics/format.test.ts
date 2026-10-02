import { describe, expect, it } from 'vite-plus/test';
import {
    deltaOf,
    formatBucket,
    formatCount,
    formatDay,
    formatDecimal,
    formatDuration,
    formatPercent,
    formatValue,
    hourLabel,
    weekdayName,
} from '@/lib/analytics/format';

describe('formatDuration', () => {
    it('shows the two largest units and rounds to the second', () => {
        expect(formatDuration(0, 'en')).toBe('0s');
        expect(formatDuration(45, 'en')).toBe('45s');
        expect(formatDuration(42.5, 'en')).toBe('43s');
        expect(formatDuration(60, 'en')).toBe('1m');
        expect(formatDuration(252, 'en')).toBe('4m 12s');
        expect(formatDuration(3600, 'en')).toBe('1h');
        expect(formatDuration(3900, 'en')).toBe('1h 5m');
        expect(formatDuration(90061, 'en')).toBe('25h 1m');
    });

    it('never prints 60 seconds', () => {
        expect(formatDuration(59.6, 'en')).toBe('1m');
    });

    it('has a placeholder for "nothing to average" and clamps nonsense', () => {
        expect(formatDuration(null, 'en')).toBe('–');
        expect(formatDuration(-5, 'en')).toBe('0s');
    });

    it('follows the locale', () => {
        expect(formatDuration(252, 'de')).toMatch(/4\s?Min\.?|4\s?m/);
        expect(formatDuration(252, 'ar')).not.toBe(formatDuration(252, 'en'));
    });
});

describe('numbers', () => {
    it('groups thousands, compacts only large counts and marks "none"', () => {
        expect(formatCount(1234, 'en')).toBe('1,234');
        expect(formatCount(1234, 'de')).toBe('1.234');
        expect(formatCount(250_000, 'en')).toBe('250K');
        expect(formatCount(null, 'en')).toBe('–');
    });

    it('formats decimals, percentages and scores', () => {
        expect(formatDecimal(4.4, 'en', 2)).toBe('4.40');
        expect(formatDecimal(4.4, 'de', 1)).toBe('4,4');
        expect(formatPercent(0.873, 'en')).toBe('87%');
        expect(formatPercent(null, 'en')).toBe('–');
        expect(formatValue(4.375, 'score', 'en')).toBe('4.38');
        expect(formatValue(0.5, 'ratio', 'en')).toBe('50%');
        expect(formatValue(61, 'seconds', 'en')).toBe('1m 1s');
        expect(formatValue(12, 'count', 'en')).toBe('12');
        expect(formatValue(12.5, 'count', 'en')).toBe('12.5');
    });
});

describe('dates', () => {
    it('formats a calendar date the same wherever the viewer is (UTC date arithmetic)', () => {
        expect(formatDay('2026-03-20', 'en')).toBe('Mar 20');
        expect(formatDay('2026-03-20', 'en', 'long')).toBe('Mar 20, 2026');
        expect(formatDay('2026-03-01', 'de')).toMatch(/1\.\s?März|1\.\s?Mär/);
        expect(formatBucket('2026-03-01', 'month', 'en')).toBe('Mar 2026');
        expect(formatBucket('2026-03-16', 'week', 'en')).toBe('Mar 16');
        expect(formatDay('nonsense', 'en')).toBe('nonsense');
    });

    it('names weekdays from Monday and hours in the locale clock', () => {
        expect(weekdayName(0, 'en')).toBe('Monday');
        expect(weekdayName(6, 'en')).toBe('Sunday');
        expect(weekdayName(2, 'en', 'short')).toBe('Wed');
        expect(hourLabel(14, 'en')).toBe('2:00 PM');
        expect(hourLabel(14, 'de')).toBe('14:00');
    });
});

describe('deltaOf', () => {
    it('says which way a number moved and by how much', () => {
        expect(deltaOf(120, 100)).toEqual({
            kind: 'up',
            ratio: 0.2,
            difference: 20,
        });
        expect(deltaOf(75, 100)).toEqual({
            kind: 'down',
            ratio: 0.25,
            difference: -25,
        });
        expect(deltaOf(100, 100)).toEqual({ kind: 'flat' });
    });

    it('does not invent a percentage of nothing', () => {
        expect(deltaOf(5, 0)).toEqual({
            kind: 'up',
            ratio: null,
            difference: 5,
        });
        expect(deltaOf(0, 5)).toEqual({
            kind: 'down',
            ratio: 1,
            difference: -5,
        });
    });

    it('has nothing to compare when either side is missing', () => {
        expect(deltaOf(null, 5)).toEqual({ kind: 'none' });
        expect(deltaOf(5, null)).toEqual({ kind: 'none' });
    });
});
