/**
 * Whether a widget's hours say "open" at an instant, and when they next open: a client-side mirror of the server's `OpeningHours` for
 * the builder's "open right now?" line (the server stays the authority: this only tells an administrator what to expect). Wall-clock
 * semantics in the widget's time zone: a range is `[start, end)`, never wraps past midnight, `24:00` is the end of the day.
 */
import type { Holiday, HoursRange, OfflineMode } from '@/types/widgets';

export type HoursStatus =
    | { state: 'always_online' }
    | { state: 'always_offline' }
    | { state: 'open' }
    | {
          state: 'closed';
          /** The next opening within two weeks: `day` is the weekday number (0 = Sunday), `daysAhead` 0 = later today. */
          next: { day: number; start: string; daysAhead: number } | null;
      };

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

function minutesOf(clock: string): number {
    const [hour, minute] = clock.split(':').map((part) => Number(part));

    return (hour ?? 0) * 60 + (minute ?? 0);
}

/** The local weekday (0 = Sunday), `YYYY-MM-DD` and minutes since midnight of `at` in `timeZone` (UTC when the zone is unknown). */
function localParts(
    at: Date,
    timeZone: string,
): { day: number; date: string; minutes: number } {
    let parts: Intl.DateTimeFormatPart[];

    try {
        parts = new Intl.DateTimeFormat('en-US', {
            timeZone,
            weekday: 'short',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(at);
    } catch {
        return localParts(at, 'UTC');
    }

    const get = (type: string): string =>
        parts.find((part) => part.type === type)?.value ?? '';

    return {
        day: Math.max(0, WEEKDAYS.indexOf(get('weekday') as never)),
        date: `${get('year')}-${get('month')}-${get('day')}`,
        minutes: Number(get('hour')) * 60 + Number(get('minute')),
    };
}

function addDays(date: string, days: number): string {
    const [year, month, day] = date.split('-').map((part) => Number(part));

    return new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
        .toISOString()
        .slice(0, 10);
}

export function hoursStatus(
    mode: OfflineMode,
    timeZone: string,
    schedule: readonly HoursRange[],
    holidays: readonly Holiday[],
    now: Date = new Date(),
): HoursStatus {
    if (mode === 'always_online') {
        return { state: 'always_online' };
    }

    if (mode === 'always_offline') {
        return { state: 'always_offline' };
    }

    const local = localParts(now, timeZone);
    const closedDays = new Set(holidays.map((holiday) => holiday.date));
    const rangesOf = (day: number): HoursRange[] =>
        schedule
            .filter((range) => range.day === day)
            .sort((a, b) => minutesOf(a.start) - minutesOf(b.start));

    if (
        !closedDays.has(local.date) &&
        rangesOf(local.day).some(
            (range) =>
                local.minutes >= minutesOf(range.start) &&
                local.minutes < minutesOf(range.end),
        )
    ) {
        return { state: 'open' };
    }

    for (let ahead = 0; ahead <= 14; ahead++) {
        if (closedDays.has(addDays(local.date, ahead))) {
            continue;
        }

        const day = (local.day + ahead) % 7;
        const opening = rangesOf(day).find(
            (range) =>
                (ahead > 0 || minutesOf(range.start) > local.minutes) &&
                minutesOf(range.start) < minutesOf(range.end),
        );

        if (opening) {
            return {
                state: 'closed',
                next: { day, start: opening.start, daysAhead: ahead },
            };
        }
    }

    return { state: 'closed', next: null };
}
