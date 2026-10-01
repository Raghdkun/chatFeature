import { useEffect, useState } from 'react';

/** Milliseconds since `since`, re-rendered once a second (0 when `since` is null). */
export function useElapsed(
    since: number | null,
    now: () => number = Date.now,
): number {
    const [tick, setTick] = useState(() => now());

    useEffect(() => {
        if (since === null) {
            return;
        }

        const timer = setInterval(() => setTick(now()), 1000);

        return () => clearInterval(timer);
    }, [since, now]);

    return since === null ? 0 : Math.max(0, tick - since);
}
