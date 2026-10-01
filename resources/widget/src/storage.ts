export interface Store {
    get(key: string): string | null;
    set(key: string, value: string): void;
    remove(key: string): void;
}

/**
 * localStorage/sessionStorage with a memory fallback: reading the property itself can throw (blocked
 * storage, sandboxed frames) and so can `setItem` (quota, Safari private mode).
 */
export function makeStore(win: Window, kind: 'local' | 'session'): Store {
    const mem = new Map<string, string>();
    const backend = (): Storage | null => {
        try {
            return kind === 'local' ? win.localStorage : win.sessionStorage;
        } catch {
            return null;
        }
    };

    return {
        get(key) {
            try {
                const v = backend()?.getItem(key);

                if (v !== null && v !== undefined) {
                    return v;
                }
            } catch {
                // fall through to memory
            }

            return mem.get(key) ?? null;
        },
        set(key, value) {
            try {
                const b = backend();

                if (b !== null) {
                    b.setItem(key, value);
                    mem.delete(key);

                    return;
                }
            } catch {
                // fall through to memory
            }

            mem.set(key, value);
        },
        remove(key) {
            mem.delete(key);

            try {
                backend()?.removeItem(key);
            } catch {
                // ignore
            }
        },
    };
}
