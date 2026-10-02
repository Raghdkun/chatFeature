import { RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { useNow } from '@/components/inbox/use-now';
import { Button } from '@/components/ui/button';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Busy, Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { useWaRealtime, useWaState } from '@/lib/realtime/whatsapp/context';
import { useQrPoll } from '@/lib/realtime/whatsapp/use-qr-poll';
import { describeWaError } from '@/lib/whatsapp-api/client';
import type { WhatsAppSession } from '@/lib/whatsapp/types';
import { useReturnFocus } from '@/components/inbox/use-return-focus';

/** A QR code is valid for about 20 seconds and the server replaces it; a picture this old is probably dead (clock skew is tolerated). */
export const QR_STALE_AFTER_MS = 90_000;

/**
 * Links a number: shows the session's QR code, refreshed every 2.5 s, with the instructions for the phone, and closes by itself when
 * the session becomes `ready` (seen by the poll or by `wa.session.status`). The picture sits on a white tile whatever the theme (a
 * scanner needs the contrast) and is only ever a base64 PNG (the client refuses anything else).
 */
export function QrDialog({
    session,
    onClose,
    onConnected,
    onStart,
    starting,
}: {
    session: WhatsAppSession | null;
    onClose: () => void;
    onConnected: (session: WhatsAppSession) => void;
    /** Start the session again (it is not running, so there is no code to show). */
    onStart: (session: WhatsAppSession) => void;
    starting: boolean;
}) {
    const { t, locale } = useTrans();
    const { api } = useWaRealtime();
    const now = useNow();
    const open = session !== null;
    const returnFocus = useReturnFocus(open);
    const live = useWaState((state) =>
        session ? state.sessions[session.ulid] : undefined,
    );
    // Connected is announced once per dialog, whichever of the poll and the websocket event sees it first.
    const announced = useRef<string | null>(null);
    const connected = useRef(onConnected);

    useEffect(() => {
        connected.current = onConnected;
    });

    const announce = (ready: WhatsAppSession): void => {
        if (announced.current !== ready.ulid) {
            announced.current = ready.ulid;
            connected.current(ready);
        }
    };
    const { view, refresh } = useQrPoll({
        ulid: session?.ulid ?? null,
        open,
        api,
        onReady: () => {
            if (session) {
                announce(live ?? session);
            }
        },
    });
    const liveReady = live?.status === 'ready';

    useEffect(() => {
        if (open && live && liveReady && announced.current !== live.ulid) {
            announced.current = live.ulid;
            connected.current(live);
        }
    }, [open, live, liveReady]);

    useEffect(() => {
        if (!open) {
            announced.current = null;
        }
    }, [open]);

    const age =
        view.kind === 'qr' && view.updatedAt !== null
            ? now - Date.parse(view.updatedAt)
            : 0;
    const stale = Number.isFinite(age) && age > QR_STALE_AFTER_MS;

    return (
        <Dialog
            open={open}
            onOpenChange={(next) => {
                if (!next) {
                    onClose();
                }
            }}
        >
            <DialogContent
                data-testid="wa-qr-dialog"
                {...returnFocus}
                className="sm:max-w-md"
            >
                <DialogHeader>
                    <DialogTitle>
                        {t('whatsapp.qr.title', { name: session?.name ?? '' })}
                    </DialogTitle>
                    <DialogDescription>
                        {t('whatsapp.qr.description')}
                    </DialogDescription>
                </DialogHeader>

                <ol className="grid list-decimal gap-1 ps-5 text-sm text-muted-foreground">
                    <li>{t('whatsapp.qr.step_open')}</li>
                    <li>{t('whatsapp.qr.step_linked')}</li>
                    <li>{t('whatsapp.qr.step_scan')}</li>
                </ol>

                <div
                    className="mx-auto grid size-64 place-items-center rounded-xl border bg-white p-3 text-center text-sm text-neutral-600"
                    data-testid="wa-qr-tile"
                >
                    {view.kind === 'qr' ? (
                        <img
                            src={view.image}
                            alt={t('whatsapp.qr.alt')}
                            data-testid="wa-qr-image"
                            width={232}
                            height={232}
                            referrerPolicy="no-referrer"
                            className={
                                stale
                                    ? 'size-full object-contain opacity-30'
                                    : 'size-full object-contain'
                            }
                        />
                    ) : view.kind === 'stopped' ? (
                        <span
                            data-testid="wa-qr-stopped"
                            className="grid gap-2 px-2"
                        >
                            <TriangleAlert
                                className="mx-auto size-6 text-amber-600"
                                aria-hidden
                            />
                            {t('whatsapp.qr.stopped')}
                        </span>
                    ) : view.kind === 'ready' ? (
                        <span>{t('whatsapp.qr.connected')}</span>
                    ) : (
                        <span
                            data-testid="wa-qr-waiting"
                            role="status"
                            className="grid gap-2"
                        >
                            <Busy className="mx-auto size-6" />
                            {view.kind === 'waiting'
                                ? t('whatsapp.qr.starting')
                                : t('whatsapp.qr.loading')}
                        </span>
                    )}
                </div>

                {stale && (
                    <Notice tone="warning" data-testid="wa-qr-stale">
                        {t('whatsapp.qr.stale')}
                    </Notice>
                )}
                {view.kind === 'error' && (
                    <Notice tone="danger" data-testid="wa-qr-error">
                        {describeWaError(view.error, t, locale)}
                    </Notice>
                )}

                <DialogFooter className="gap-2 sm:justify-between">
                    {view.kind === 'stopped' && session ? (
                        <Button
                            type="button"
                            disabled={starting}
                            data-testid="wa-qr-restart"
                            onClick={() => onStart(session)}
                        >
                            {starting && <Busy />}
                            {t('whatsapp.session.start')}
                        </Button>
                    ) : (
                        <Button
                            type="button"
                            variant="outline"
                            data-testid="wa-qr-refresh"
                            onClick={refresh}
                        >
                            <RefreshCw aria-hidden />
                            {t('whatsapp.qr.refresh')}
                        </Button>
                    )}
                    <Button
                        type="button"
                        variant="ghost"
                        data-testid="wa-qr-close"
                        onClick={onClose}
                    >
                        {t('whatsapp.qr.close')}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
