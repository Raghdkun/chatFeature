import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api-client';

export type ReportState<T> = {
    /** The last good answer: kept while a new one loads (the frame does not jump) and after a failed refetch. */
    data: T | null;
    /** A request is in flight. */
    loading: boolean;
    /** The last request failed (the old `data`, if any, is still shown beneath the error). */
    error: unknown;
    retry: () => void;
};

/**
 * Loads one report whenever `key` changes. Stale answers are dropped (a slow request that was overtaken never overwrites a newer
 * one), an overtaken request is aborted, and the previous data stays on screen while the next loads.
 */
export function useReport<T>(
    key: string,
    load: (signal: AbortSignal) => Promise<T>,
    enabled = true,
): ReportState<T> {
    const [state, setState] = useState<Omit<ReportState<T>, 'retry'>>({
        data: null,
        loading: enabled,
        error: null,
    });
    const [attempt, setAttempt] = useState(0);
    const loader = useRef(load);

    useEffect(() => {
        loader.current = load;
    });

    useEffect(() => {
        if (!enabled) {
            return;
        }

        const controller = new AbortController();

        // eslint-disable-next-line react-hooks/set-state-in-effect -- the request starts here: loading is its first state
        setState((previous) => ({ ...previous, loading: true, error: null }));

        loader
            .current(controller.signal)
            .then((data) => {
                if (!controller.signal.aborted) {
                    setState({ data, loading: false, error: null });
                }
            })
            .catch((error: unknown) => {
                if (
                    controller.signal.aborted ||
                    (error instanceof DOMException &&
                        error.name === 'AbortError')
                ) {
                    return;
                }

                setState((previous) => ({
                    data: previous.data,
                    loading: false,
                    error: isApiError(error) ? error : (error ?? new Error()),
                }));
            });

        return () => controller.abort();
    }, [key, enabled, attempt]);

    const retry = useCallback(() => setAttempt((value) => value + 1), []);

    return { ...state, retry };
}
