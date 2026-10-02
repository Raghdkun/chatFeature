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

/** What a hand-off answer says about its own lifetime: the server's countdown, and the moment it computed that from. */
export type HandoffTiming = { expiresAt: string; ttlSeconds?: number | null };

/**
 * When the code stops working, in milliseconds on THIS browser's clock, or `null` when that cannot be told.
 *
 * The server's countdown (`ttlSeconds`) is counted from the moment its answer ARRIVED here, so no clock of the server is compared with
 * the visitor's: a visitor whose clock is hours off still sees the true time left, and "Get a new code" cannot loop on codes that look
 * expired the moment they arrive. An older server sends only `expiresAt`; then it is compared with the visitor's clock, but a code
 * that is already past on arrival is a FRESH code seen on a skewed clock (a live ticket is never expired): it is shown with no expiry
 * rather than as expired.
 */
export function handoffDeadline(
    handoff: HandoffTiming,
    arrivedAt: number,
): number | null {
    const ttl = handoff.ttlSeconds;

    if (typeof ttl === 'number' && Number.isFinite(ttl) && ttl > 0) {
        return arrivedAt + ttl * 1000;
    }

    const at = Date.parse(handoff.expiresAt);

    return Number.isNaN(at) || at <= arrivedAt ? null : at;
}

/** Milliseconds until a deadline (never negative); `null` when there is none. */
export function remainingUntil(
    deadline: number | null,
    now: number,
): number | null {
    return deadline === null ? null : Math.max(0, deadline - now);
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
