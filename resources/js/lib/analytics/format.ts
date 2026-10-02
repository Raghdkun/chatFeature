/**
 * Number, duration, percentage and date formatting of the analytics screens: everything locale-aware goes through `Intl`, and calendar
 * dates (`Y-m-d`, already counted in the application time zone) are formatted in UTC so the viewer's own zone never shifts them.
 */
import { parseDate } from '@/lib/analytics/ranges';
import type { SeriesUnit } from '@/lib/analytics/types';

const EMPTY = '–';

export function formatCount(value: number | null, locale: string): string {
    if (value === null) {
        return EMPTY;
    }

    try {
        return new Intl.NumberFormat(locale, {
            notation: Math.abs(value) >= 100_000 ? 'compact' : 'standard',
            maximumFractionDigits: Math.abs(value) >= 100_000 ? 1 : 0,
        }).format(value);
    } catch {
        return String(Math.round(value));
    }
}

export function formatDecimal(
    value: number | null,
    locale: string,
    digits = 1,
): string {
    if (value === null) {
        return EMPTY;
    }

    try {
        return new Intl.NumberFormat(locale, {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits,
        }).format(value);
    } catch {
        return value.toFixed(digits);
    }
}

/** `0.873` -> "87%". */
export function formatPercent(ratio: number | null, locale: string): string {
    if (ratio === null) {
        return EMPTY;
    }

    try {
        return new Intl.NumberFormat(locale, {
            style: 'percent',
            maximumFractionDigits: 0,
        }).format(ratio);
    } catch {
        return `${Math.round(ratio * 100)}%`;
    }
}

function unit(
    locale: string,
    value: number,
    name: 'hour' | 'minute' | 'second',
): string {
    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit: name,
            unitDisplay: 'narrow',
            maximumFractionDigits: 0,
        }).format(value);
    } catch {
        return `${value}${name[0]}`;
    }
}

/**
 * "45s", "4m 12s", "1h 5m": the two largest units, rounded to the second. Under a minute the seconds stand alone; a fraction rounds,
 * so 59.6 s reads "1m" and never "60s".
 */
export function formatDuration(seconds: number | null, locale: string): string {
    if (seconds === null) {
        return EMPTY;
    }

    const total = Math.max(0, Math.round(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const rest = total % 60;

    if (hours > 0) {
        return minutes > 0
            ? `${unit(locale, hours, 'hour')} ${unit(locale, minutes, 'minute')}`
            : unit(locale, hours, 'hour');
    }

    if (minutes > 0) {
        return rest > 0
            ? `${unit(locale, minutes, 'minute')} ${unit(locale, rest, 'second')}`
            : unit(locale, minutes, 'minute');
    }

    return unit(locale, rest, 'second');
}

export function formatValue(
    value: number | null,
    kind: SeriesUnit,
    locale: string,
): string {
    switch (kind) {
        case 'seconds':
            return formatDuration(value, locale);
        case 'score':
            return formatDecimal(value, locale, 2);
        case 'ratio':
            return formatPercent(value, locale);
        default:
            return Number.isInteger(value ?? 0)
                ? formatCount(value, locale)
                : formatDecimal(value, locale, 1);
    }
}

export function formatDay(
    value: string,
    locale: string,
    style: 'short' | 'long' = 'short',
): string {
    const date = parseDate(value);

    if (!date) {
        return value;
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            day: 'numeric',
            month: 'short',
            ...(style === 'long' ? { year: 'numeric' } : {}),
        }).format(date);
    } catch {
        return value;
    }
}

export function formatMonth(value: string, locale: string): string {
    const date = parseDate(value);

    if (!date) {
        return value;
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            month: 'short',
            year: 'numeric',
        }).format(date);
    } catch {
        return value;
    }
}

/** The label of a series bucket (its first day) for the chosen interval. */
export function formatBucket(
    value: string,
    interval: 'day' | 'week' | 'month',
    locale: string,
): string {
    return interval === 'month'
        ? formatMonth(value, locale)
        : formatDay(value, locale);
}

/** A weekday name for the heatmap: 0 = Monday ... 6 = Sunday. */
export function weekdayName(
    index: number,
    locale: string,
    width: 'long' | 'short' = 'long',
): string {
    // 2024-01-01 was a Monday.
    const date = new Date(Date.UTC(2024, 0, 1 + index));

    try {
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            weekday: width,
        }).format(date);
    } catch {
        return String(index);
    }
}

/** "14:00" in the locale's clock style. */
export function hourLabel(hour: number, locale: string): string {
    try {
        return new Intl.DateTimeFormat(locale, {
            timeZone: 'UTC',
            hour: 'numeric',
            minute: '2-digit',
        }).format(new Date(Date.UTC(2024, 0, 1, hour)));
    } catch {
        return `${hour}:00`;
    }
}

export type Delta =
    | { kind: 'none' }
    | { kind: 'flat' }
    | { kind: 'up' | 'down'; ratio: number | null; difference: number };

/**
 * How a value moved against the previous period. `ratio` is the relative change (`null` when the previous value was 0: a percentage of
 * nothing is meaningless, the UI then says "new" rather than inventing one).
 */
export function deltaOf(
    current: number | null,
    previous: number | null,
): Delta {
    if (current === null || previous === null) {
        return { kind: 'none' };
    }

    if (current === previous) {
        return { kind: 'flat' };
    }

    return {
        kind: current > previous ? 'up' : 'down',
        ratio:
            previous === 0
                ? null
                : Math.abs(current - previous) / Math.abs(previous),
        difference: current - previous,
    };
}
