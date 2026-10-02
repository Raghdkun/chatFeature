import { useEffect, useState } from 'react';

/** The current time (ms), refreshed every `intervalMs` while mounted: for countdowns that do not need second precision. */
export function useClock(
    intervalMs = 15_000,
    now: () => number = Date.now,
): number {
    const [tick, setTick] = useState(() => now());

    useEffect(() => {
        const timer = setInterval(() => setTick(now()), intervalMs);

        return () => clearInterval(timer);
    }, [intervalMs, now]);

    return tick;
}
