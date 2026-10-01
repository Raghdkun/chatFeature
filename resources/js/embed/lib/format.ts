/** Locale-aware time and date labels for the message list, and the queue timer. */

export function formatTime(iso: string, locale: string): string {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    try {
        return new Intl.DateTimeFormat(locale, {
            hour: 'numeric',
            minute: '2-digit',
        }).format(date);
    } catch {
        return date.toLocaleTimeString();
    }
}

/** `YYYY-MM-DD` of the visitor's own calendar day (messages are grouped by local day). */
export function dayKey(iso: string): string {
    const date = new Date(iso);

    return Number.isNaN(date.getTime())
        ? ''
        : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

const DAY_MS = 86_400_000;

/** "Today", "Yesterday", or a short date, in the given locale. */
export function formatDay(iso: string, locale: string, now: number): string {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const startOf = (value: number): number => {
        const d = new Date(value);

        return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    };
    const diff = Math.round((startOf(now) - startOf(date.getTime())) / DAY_MS);

    try {
        if (diff === 0 || diff === 1) {
            const label = new Intl.RelativeTimeFormat(locale, {
                numeric: 'auto',
            }).format(-diff, 'day');

            return label.charAt(0).toLocaleUpperCase(locale) + label.slice(1);
        }

        return new Intl.DateTimeFormat(locale, {
            weekday: 'short',
            month: 'short',
            day: 'numeric',
            ...(date.getFullYear() === new Date(now).getFullYear()
                ? {}
                : { year: 'numeric' }),
        }).format(date);
    } catch {
        return date.toDateString();
    }
}

/** "when we are back" for the offline screen: day and time in the visitor's zone. */
export function formatNextOpen(
    iso: string,
    locale: string,
    now: number,
): string {
    const date = new Date(iso);

    if (Number.isNaN(date.getTime())) {
        return '';
    }

    const sameDay = dayKey(iso) === dayKey(new Date(now).toISOString());

    try {
        return new Intl.DateTimeFormat(locale, {
            ...(sameDay ? {} : { weekday: 'long' }),
            hour: 'numeric',
            minute: '2-digit',
        }).format(date);
    } catch {
        return date.toLocaleString();
    }
}

/** `m:ss` (or `h:mm:ss`) for the queue timer. */
export function formatElapsed(ms: number): string {
    const total = Math.max(0, Math.floor(ms / 1000));
    const seconds = total % 60;
    const minutes = Math.floor(total / 60) % 60;
    const hours = Math.floor(total / 3600);
    const pad = (n: number): string => String(n).padStart(2, '0');

    return hours > 0
        ? `${hours}:${pad(minutes)}:${pad(seconds)}`
        : `${minutes}:${pad(seconds)}`;
}

export function formatBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) {
        const mb = bytes / (1024 * 1024);

        return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
    }

    return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
