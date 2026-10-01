import type { Dict } from './types';

export const isRecord = (v: unknown): v is Dict =>
    typeof v === 'object' && v !== null && !Array.isArray(v);

export const own = (o: Dict, k: string): boolean =>
    Object.prototype.hasOwnProperty.call(o, k);

export const clamp = (n: number, min: number, max: number): number =>
    Math.min(max, Math.max(min, n));

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/g;

/** Trimmed string without control characters, cut to `max`; `undefined` when empty or not a string. */
export function clean(v: unknown, max: number): string | undefined {
    if (typeof v !== 'string') {
        return undefined;
    }

    const s = v.replace(CONTROL, ' ').trim().slice(0, max);

    return s === '' ? undefined : s;
}

export function uuid(): string {
    const c = globalThis.crypto as Crypto | undefined;

    if (c !== undefined && typeof c.randomUUID === 'function') {
        return c.randomUUID();
    }

    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
        const r = Math.floor(Math.random() * 16);

        return (ch === 'x' ? r : (r % 4) + 8).toString(16);
    });
}

export function deepMerge<T extends object>(a: T, b: T): T {
    const out: Dict = { ...(a as Dict) };
    const src = b as Dict;

    for (const k of Object.keys(src)) {
        const x = out[k];
        const y = src[k];
        out[k] = isRecord(x) && isRecord(y) ? deepMerge(x, y) : y;
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
