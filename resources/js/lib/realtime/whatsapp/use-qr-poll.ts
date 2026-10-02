/**
 * Polls `GET /whatsapp/sessions/{ulid}/qr` every 2.5 s while the QR dialog is open, until the session is connected. The answer is a
 * picture while the session waits for a scan, and otherwise the session's status (`409 qr_not_available` becomes `{status, image: null}`
 * in the client): `starting` means the engine is still warming up, `ready` means the scan happened (the dialog closes), and
 * `created` / `disconnected` / `failed` mean the session is not running at all (polling stops: only starting it again helps).
 * A failed read (OpenWA unreachable) is shown and the poll goes on: it is not the end of the dialog. A `429` (`wa-qr` limiter, or OpenWA's
 * own throttle with no code stored yet) is only "try again shortly": the picture on screen stays and the next read waits `Retry-After`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { isApiError } from '@/lib/api-client';
import { classifyWaError, type WaApi } from '@/lib/whatsapp-api/client';
import type { SessionStatus } from '@/lib/whatsapp/types';

export const QR_POLL_MS = 2_500;

export type QrView =
    | { kind: 'loading' }
    | { kind: 'qr'; image: string; updatedAt: string | null }
    /** The engine is starting: no code yet. */
    | { kind: 'waiting'; status: SessionStatus }
    | { kind: 'ready' }
    /** The session is not running: a QR will not appear until it is started again. */
    | { kind: 'stopped'; status: SessionStatus }
    | { kind: 'error'; error: unknown };

export function useQrPoll({
    ulid,
    open,
    api,
    onReady,
}: {
    ulid: string | null;
    open: boolean;
    api: WaApi;
    onReady: () => void;
}): { view: QrView; refresh: () => void } {
    const [view, setView] = useState<QrView>({ kind: 'loading' });
    const [nudge, setNudge] = useState(0);
    const ready = useRef(onReady);

    useEffect(() => {
        ready.current = onReady;
    });

    useEffect(() => {
        if (!open || ulid === null) {
            return;
        }

        let cancelled = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const controller = new AbortController();

        // eslint-disable-next-line react-hooks/set-state-in-effect -- a fresh dialog (or a manual refresh) starts from "loading"
        setView((held) => (held.kind === 'qr' ? held : { kind: 'loading' }));

        let wait = QR_POLL_MS;

        const tick = async (): Promise<void> => {
            wait = QR_POLL_MS;

            try {
                const result = await api.qr(ulid, controller.signal);

                if (cancelled) {
                    return;
                }

                if (result.status === 'ready') {
                    setView({ kind: 'ready' });
                    ready.current();

                    return;
                }

                if (result.image !== null) {
                    setView({
                        kind: 'qr',
                        image: result.image,
                        updatedAt: result.updatedAt,
                    });
                } else if (
                    result.status === 'created' ||
                    result.status === 'disconnected' ||
                    result.status === 'failed'
                ) {
                    setView({ kind: 'stopped', status: result.status });

                    return;
                } else {
                    setView({ kind: 'waiting', status: result.status });
                }
            } catch (error) {
                if (cancelled || controller.signal.aborted) {
                    return;
                }

                if (classifyWaError(error) === 'rate_limited') {
                    // OpenWA's throttle (`429`, nothing stored yet): not a failure. Keep what is on screen and try again shortly.
                    wait = Math.min(
                        15_000,
                        Math.max(
                            QR_POLL_MS,
                            isApiError(error) && error.retryAfter !== null
                                ? error.retryAfter * 1000
                                : 0,
                        ),
                    );
                    setView((held) =>
                        held.kind === 'qr' || held.kind === 'waiting'
                            ? held
                            : { kind: 'waiting', status: 'starting' },
                    );
                } else {
                    setView({ kind: 'error', error });
                }
            }

            timer = setTimeout(() => void tick(), wait);
        };

        void tick();

        return () => {
            cancelled = true;
            controller.abort();
            clearTimeout(timer);
        };
    }, [open, ulid, api, nudge]);

    return { view, refresh: useCallback(() => setNudge((n) => n + 1), []) };
}
