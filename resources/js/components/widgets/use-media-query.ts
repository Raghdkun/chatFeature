import { useSyncExternalStore } from 'react';

/**
 * `matchMedia` as a hook. Without `matchMedia` (jsdom, very old engines) it answers `fallback`,
 * which is `true` so tests and server renders get the wide layout.
 */
export function useMediaQuery(query: string, fallback = true): boolean {
    return useSyncExternalStore(
        (notify) => {
            if (typeof window.matchMedia !== 'function') {
                return () => undefined;
            }

            const list = window.matchMedia(query);

            list.addEventListener('change', notify);

            return () => list.removeEventListener('change', notify);
        },
        () =>
            typeof window.matchMedia === 'function'
                ? window.matchMedia(query).matches
                : fallback,
        () => fallback,
    );
}
