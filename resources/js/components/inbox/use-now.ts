import { useSyncExternalStore } from 'react';

/**
 * One shared clock for every countdown, waiting timer and "5m" label on the page: a single interval that runs only while a component
 * is subscribed (so a page with twenty offer cards still has one timer) and stops with the last one.
 */
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;

/** Whole seconds, so two reads inside one render agree and React never sees a "changing" snapshot. */
function currentSecond(): number {
    return Math.floor(Date.now() / 1000) * 1000;
}

function subscribe(listener: () => void): () => void {
    listeners.add(listener);

    if (timer === null) {
        timer = setInterval(
            () => listeners.forEach((notify) => notify()),
            1000,
        );
    }

    return () => {
        listeners.delete(listener);

        if (listeners.size === 0 && timer !== null) {
            clearInterval(timer);
            timer = null;
        }
    };
}

/** The current time in ms (second precision), refreshed once a second while mounted. */
export function useNow(): number {
    return useSyncExternalStore(subscribe, currentSecond, currentSecond);
}
