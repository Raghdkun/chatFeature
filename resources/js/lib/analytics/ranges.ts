/**
 * Date-range maths of the analytics filter row. Days are calendar dates (`Y-m-d`) in the APPLICATION time zone; `today` comes from the
 * server (`AnalyticsPageData.today`), never from the browser's clock, so a viewer in another time zone sees the same presets. Pure
 * arithmetic on UTC dates, no DST.
 */
import type { Filters } from '@/lib/analytics/types';

export const PRESETS = ['today', '7d', '30d', '90d'] as const;
export type Preset = (typeof PRESETS)[number];

const DAY_MS = 86_400_000;

export function parseDate(value: string): Date | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

    if (!match) {
        return null;
    }

    const date = new Date(Date.UTC(+match[1], +match[2] - 1, +match[3]));

    return date.toISOString().slice(0, 10) === value ? date : null;
}

export function isoDate(date: Date): string {
    return date.toISOString().slice(0, 10);
}

export function addDays(value: string, days: number): string {
    const date = parseDate(value);

    return date ? isoDate(new Date(date.getTime() + days * DAY_MS)) : value;
}

/** Inclusive number of days from `from` to `to` (0 for an invalid pair). */
export function spanDays(from: string, to: string): number {
    const a = parseDate(from);
    const b = parseDate(to);

    return a && b ? Math.round((b.getTime() - a.getTime()) / DAY_MS) + 1 : 0;
}

export function presetRange(
    preset: Preset,
    today: string,
): { from: string; to: string } {
    const days = { today: 1, '7d': 7, '30d': 30, '90d': 90 }[preset];

    return { from: addDays(today, -(days - 1)), to: today };
}

/** The preset a range equals, or `null` for a custom one. */
export function matchPreset(
    from: string,
    to: string,
    today: string,
): Preset | null {
    return (
        PRESETS.find((preset) => {
            const range = presetRange(preset, today);

            return range.from === from && range.to === to;
        }) ?? null
    );
}

/** The longest range the API accepts (about two years). */
export const MAX_RANGE_DAYS = 731;

export type RangeProblem = 'invalid' | 'order' | 'long' | null;

export function rangeProblem(from: string, to: string): RangeProblem {
    if (!parseDate(from) || !parseDate(to)) {
        return 'invalid';
    }

    if (from > to) {
        return 'order';
    }

    return spanDays(from, to) > MAX_RANGE_DAYS ? 'long' : null;
}

/** The chart interval that keeps a series readable (the same thresholds as the server's default). */
export function intervalFor(days: number): 'day' | 'week' | 'month' {
    return days <= 62 ? 'day' : days <= 540 ? 'week' : 'month';
}

const KEYS = ['from', 'to', 'widget', 'category', 'agent', 'compare'] as const;

/** The query string of a filter state (`compare` is only written when it is off: on is the default). */
export function filtersToSearch(filters: Filters): string {
    const params = new URLSearchParams();

    params.set('from', filters.from);
    params.set('to', filters.to);

    if (filters.widget) {
        params.set('widget', filters.widget);
    }

    if (filters.category) {
        params.set('category', filters.category);
    }

    if (filters.agent !== null) {
        params.set('agent', String(filters.agent));
    }

    if (!filters.compare) {
        params.set('compare', '0');
    }

    return params.toString();
}

export const FILTER_KEYS = KEYS;
