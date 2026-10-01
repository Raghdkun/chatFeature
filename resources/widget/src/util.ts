import type { Dict } from './types';

export const isRecord = (v: unknown): v is Dict =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

/** `{ [k]: v }`, or nothing when `v` is absent: optional fields stay out of messages instead of travelling as `undefined`. */
export const opt = (k: string, v: unknown): Dict =>
    v === undefined || v === null ? {} : { [k]: v };

export const own = (o: Dict, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);

export const clamp = (n: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, n));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;
/** Bidirectional overrides/isolates: they can visually reorder a text (spoofing), so they never get through. */
const BIDI = /[\u202a-\u202e\u2066-\u2069]/g;

/**
 * Trimmed string without control or bidi characters, cut to `max`; `undefined` when empty or not a string.
 * Newlines become spaces unless `multiline` (message bodies keep them).
 */
export function clean(
    v: unknown,
    max: number,
    multiline = false,
): string | undefined {
    if (typeof v !== 'string') {
        return undefined;
    }

    const s = v
        .replace(BIDI, '')
        .replace(/\r\n?/g, '\n')
        .replace(CONTROL, (c) => (multiline && c === '\n' ? c : ' '))
        .trim()
        .slice(0, max);

    return s === '' ? undefined : s;
}

/** Short non-cryptographic fingerprint: equality checks only, never a secret. */
export const fingerprint = (s: string): string =>
    Array.from(s)
        .reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7)
        .toString(36);

/** Request id for the handshake: unique enough, not a security token. */
export const uuid = (): string =>
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export function deepMerge<T extends object>(a: T, b: T): T {
    const out: Dict = { ...(a as Dict) };
    const src = b as Dict;

    for (const k of Object.keys(src)) {
        const x = out[k];
        const y = src[k];
        // `meta` (free-form visitor data) is replaced as a whole, so stale keys never survive an update.
        out[k] =
            k !== 'meta' && isRecord(x) && isRecord(y) ? deepMerge(x, y) : y;
    }

    return out as T;
}

export function warn(...args: unknown[]): void {
    try {
        // eslint-disable-next-line no-console
        console.warn('[chatfeature]', ...args);
    } catch {
        // ignore
    }
}
