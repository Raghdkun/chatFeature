/**
 * Where a visitor session lives when there is no loader to keep it: the hosted page (`/c/{key}`) and the plain inline iframe use
 * their own `localStorage`. Launcher mode never touches this (the loader keeps the token in the host page's storage).
 * Storage can be blocked or partitioned (private windows, Safari ITP): every access is guarded and falls back to memory.
 */
import type { StoredSession } from '@/embed/session/controller';

const memory = new Map<string, string>();
const keyOf = (widgetKey: string): string => `chatfeature:${widgetKey}:session`;

export function loadStoredSession(
    widgetKey: string,
    now: number = Date.now(),
): StoredSession | null {
    let raw: string | null = memory.get(keyOf(widgetKey)) ?? null;

    try {
        raw = window.localStorage.getItem(keyOf(widgetKey)) ?? raw;
    } catch {
        // blocked: memory only
    }

    if (raw === null) {
        return null;
    }

    try {
        const value: unknown = JSON.parse(raw);

        if (
            typeof value === 'object' &&
            value !== null &&
            typeof (value as StoredSession).token === 'string' &&
            typeof (value as StoredSession).expiresAt === 'string' &&
            (value as StoredSession).token !== '' &&
            Date.parse((value as StoredSession).expiresAt) > now
        ) {
            return {
                token: (value as StoredSession).token,
                expiresAt: (value as StoredSession).expiresAt,
            };
        }
    } catch {
        // corrupt entry: dropped below
    }

    saveStoredSession(widgetKey, null);

    return null;
}

export function saveStoredSession(
    widgetKey: string,
    session: StoredSession | null,
): void {
    const key = keyOf(widgetKey);

    if (session === null) {
        memory.delete(key);
    } else {
        memory.set(key, JSON.stringify(session));
    }

    try {
        if (session === null) {
            window.localStorage.removeItem(key);
        } else {
            window.localStorage.setItem(key, JSON.stringify(session));
        }
    } catch {
        // blocked: memory only
    }
}
