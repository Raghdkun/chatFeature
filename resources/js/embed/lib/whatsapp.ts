/**
 * Pure helpers of the WhatsApp hand-off screen: which links may be opened, and how long a code still works. No React, no clock (the
 * caller passes `now`), so they are tested exactly.
 */

const HOSTS = new Set(['wa.me', 'api.whatsapp.com', 'web.whatsapp.com']);

/**
 * The hand-off link comes from our server, but it is only ever used as an `href` when it is an https link to WhatsApp itself: anything
 * else (a `javascript:` URL, another host, plain http) is refused and the screen keeps showing the code.
 */
export function whatsAppHref(value: string): string | null {
    try {
        const url = new URL(value);

        return url.protocol === 'https:' &&
            HOSTS.has(url.hostname) &&
            url.username === '' &&
            url.password === ''
            ? url.toString()
            : null;
    } catch {
        return null;
    }
}

/** Milliseconds a code still works (never negative); `null` when the time is not a time. */
export function remainingMs(expiresAt: string, now: number): number | null {
    const at = Date.parse(expiresAt);

    return Number.isNaN(at) ? null : Math.max(0, at - now);
}

/**
 * "23 hours", "45 minutes", "1 minute" in the visitor's language: hours while there are two or more, else minutes (never "0 minutes": a
 * code with seconds left still has a minute). `Intl` writes the unit, so no plural table is needed.
 */
export function formatRemaining(ms: number, locale: string): string {
    const minutes = Math.max(1, Math.ceil(ms / 60_000));
    const [value, unit] =
        minutes >= 120
            ? ([Math.floor(minutes / 60), 'hour'] as const)
            : ([minutes, 'minute'] as const);

    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit,
            unitDisplay: 'long',
        }).format(value);
    } catch {
        return `${value} ${unit}${value === 1 ? '' : 's'}`;
    }
}

/** The code with a thin gap in the middle so it is read and typed in two halves ("K7M2 QX4P"). */
export function spacedCode(code: string): string {
    return code.length === 8 ? `${code.slice(0, 4)} ${code.slice(4)}` : code;
}
