/**
 * Quiet hours on the client: the same rule as `App\Domain\Notifications\Support\QuietHours` (PHP), so the page's own notifications stay
 * silent exactly when the server's pushes do. Wall-clock `HH:MM` times in an IANA timezone; `start` after `end` is an overnight window,
 * equal times are no window, the end is exclusive.
 */
import type { QuietHoursSetting } from '@/lib/notifications/types';

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(time: string): number | null {
    const match = TIME.exec(time);

    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

/** The minutes since midnight at `at` in `timezone`; falls back to UTC for a name the browser does not know. */
export function minutesInZone(at: Date, timezone: string): number {
    const read = (zone: string): number => {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone: zone,
            hour: '2-digit',
            minute: '2-digit',
            hourCycle: 'h23',
        }).formatToParts(at);
        const part = (type: string): number =>
            Number(parts.find((entry) => entry.type === type)?.value ?? '0');

        return part('hour') * 60 + part('minute');
    };

    try {
        return read(timezone);
    } catch {
        return read('UTC');
    }
}

export function isQuietNow(
    hours: QuietHoursSetting | null | undefined,
    at: Date = new Date(),
): boolean {
    if (!hours || !hours.enabled) {
        return false;
    }

    const start = minutesOf(hours.start);
    const end = minutesOf(hours.end);

    if (start === null || end === null || start === end) {
        return false;
    }

    const now = minutesInZone(at, hours.timezone);

    return start < end ? now >= start && now < end : now >= start || now < end;
}
