import { describe, expect, it } from 'vite-plus/test';
import {
    addDays,
    filtersToSearch,
    intervalFor,
    matchPreset,
    MAX_RANGE_DAYS,
    parseDate,
    presetRange,
    rangeProblem,
    spanDays,
} from '@/lib/analytics/ranges';

describe('dates', () => {
    it('only accepts real calendar dates', () => {
        expect(parseDate('2026-02-28')).not.toBeNull();
        expect(parseDate('2026-02-30')).toBeNull();
        expect(parseDate('2026-13-01')).toBeNull();
        expect(parseDate('26-03-20')).toBeNull();
        expect(parseDate('')).toBeNull();
    });

    it('adds days across months, years and a leap day without DST drift', () => {
        expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
        expect(addDays('2024-03-01', -1)).toBe('2024-02-29');
        expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
        expect(addDays('2026-03-29', 1)).toBe('2026-03-30');
    });

    it('counts a range inclusively', () => {
        expect(spanDays('2026-03-20', '2026-03-20')).toBe(1);
        expect(spanDays('2026-03-01', '2026-03-31')).toBe(31);
        expect(spanDays('2026-03-31', '2026-03-01')).toBeLessThan(1);
        expect(spanDays('bad', '2026-03-01')).toBe(0);
    });
});

describe('presets', () => {
    const today = '2026-03-27';

    it("are built from the server's today, ending today", () => {
        expect(presetRange('today', today)).toEqual({
            from: '2026-03-27',
            to: '2026-03-27',
        });
        expect(presetRange('7d', today)).toEqual({
            from: '2026-03-21',
            to: '2026-03-27',
        });
        expect(presetRange('30d', today)).toEqual({
            from: '2026-02-26',
            to: '2026-03-27',
        });
        expect(presetRange('90d', today)).toEqual({
            from: '2025-12-28',
            to: '2026-03-27',
        });
    });

    it('are recognised from a range, and anything else is custom', () => {
        expect(matchPreset('2026-03-21', '2026-03-27', today)).toBe('7d');
        expect(matchPreset('2026-03-27', '2026-03-27', today)).toBe('today');
        expect(matchPreset('2026-03-20', '2026-03-27', today)).toBeNull();
        expect(matchPreset('2026-03-21', '2026-03-26', today)).toBeNull();
    });
});

describe('rangeProblem', () => {
    it('names what is wrong with a range', () => {
        expect(rangeProblem('2026-03-01', '2026-03-27')).toBeNull();
        expect(rangeProblem('', '2026-03-27')).toBe('invalid');
        expect(rangeProblem('2026-03-28', '2026-03-27')).toBe('order');
        expect(rangeProblem('2024-09-29', '2026-09-30')).toBe('long');
        expect(rangeProblem('2024-09-30', '2026-09-30')).toBeNull();
        expect(MAX_RANGE_DAYS).toBe(731);
    });
});

describe('intervalFor', () => {
    it('keeps a chart readable (the same thresholds as the server)', () => {
        expect(intervalFor(1)).toBe('day');
        expect(intervalFor(62)).toBe('day');
        expect(intervalFor(63)).toBe('week');
        expect(intervalFor(540)).toBe('week');
        expect(intervalFor(541)).toBe('month');
    });
});

describe('filtersToSearch', () => {
    const base = {
        from: '2026-03-01',
        to: '2026-03-27',
        widget: null,
        category: null,
        agent: null,
        compare: true,
    };

    it('writes the range and only what differs from the defaults', () => {
        expect(filtersToSearch(base)).toBe('from=2026-03-01&to=2026-03-27');
        expect(filtersToSearch({ ...base, compare: false })).toBe(
            'from=2026-03-01&to=2026-03-27&compare=0',
        );
        expect(filtersToSearch({ ...base, widget: 'W1' })).toBe(
            'from=2026-03-01&to=2026-03-27&widget=W1',
        );
        expect(filtersToSearch({ ...base, agent: 7 })).toBe(
            'from=2026-03-01&to=2026-03-27&agent=7',
        );
    });
});
