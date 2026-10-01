import { useSyncExternalStore } from 'react';

function subscribeTo(query: string): (notify: () => void) => () => void {
    return (notify) => {
        if (typeof window === 'undefined' || !window.matchMedia) {
            return () => undefined;
        }

        const list = window.matchMedia(query);

        list.addEventListener('change', notify);

        return () => list.removeEventListener('change', notify);
    };
}

/** A media query as live state (`prefers-color-scheme`, `prefers-reduced-motion`, `pointer: coarse`). */
export function useMedia(query: string, fallback = false): boolean {
    return useSyncExternalStore(
        (notify) => subscribeTo(query)(notify),
        () =>
            typeof window !== 'undefined' && window.matchMedia
                ? window.matchMedia(query).matches
                : fallback,
        () => fallback,
    );
}

export const useReducedMotion = (): boolean =>
    useMedia('(prefers-reduced-motion: reduce)');

export const usePrefersDark = (): boolean =>
    useMedia('(prefers-color-scheme: dark)');

export const useCoarsePointer = (): boolean => useMedia('(pointer: coarse)');

function subscribeVisibility(notify: () => void): () => void {
    document.addEventListener('visibilitychange', notify);

    return () => document.removeEventListener('visibilitychange', notify);
}

/** The iframe's document is on screen (the tab is foreground). */
export function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        subscribeVisibility,
        () => document.visibilityState !== 'hidden',
        () => true,
    );
}
