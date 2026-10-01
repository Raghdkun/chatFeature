import { WifiOff } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTrans } from '@/hooks/use-trans';
import { POLL_INTERVAL_MS } from '@/lib/realtime/staff/controller';
import type { ConnectionState } from '@/lib/realtime/staff/store';
import { cn } from '@/lib/utils';

/** Only report a drop that lasts: a reconnect that takes a second is not worth a flashing banner. */
const GRACE_MS = 2_000;

/**
 * The "reconnecting" indicator. While the websocket is down the page keeps working (REST polling every 15 s), and says so.
 * Echo reports `connecting` on the first connection and on every retry, so only a state that lasts is worth a banner;
 * `unavailable` (no websocket in this build) is not a fault of the moment, so it is stated right away.
 *
 * It sits in the list column (`list`). Below `md` the list and an open conversation are separate screens, so the conversation shows the
 * same notice in a compact `conversation` variant of its own (`md:hidden`: beside the list on a wide screen it would say it twice).
 */
export function ConnectionBanner({
    status,
    variant = 'list',
}: {
    status: ConnectionState;
    variant?: 'list' | 'conversation';
}) {
    const { t } = useTrans();
    const down = status !== 'connected';
    const [settled, setSettled] = useState(false);

    useEffect(() => {
        if (!down) {
            // eslint-disable-next-line react-hooks/set-state-in-effect -- a timer-driven flag that must reset when the link is back
            setSettled(false);

            return;
        }

        if (status === 'unavailable') {
            setSettled(true);

            return;
        }

        const timer = setTimeout(() => setSettled(true), GRACE_MS);

        return () => clearTimeout(timer);
    }, [down, status]);

    if (!down || !settled) {
        return null;
    }

    return (
        <p
            role="status"
            data-testid={
                variant === 'list'
                    ? 'connection-banner'
                    : 'connection-banner-conversation'
            }
            data-status={status}
            className={cn(
                'flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-50 text-amber-950 dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100',
                variant === 'list'
                    ? 'mx-3 mt-3 px-3 py-2 text-sm'
                    : 'mx-2 mt-2 px-2.5 py-1.5 text-xs md:hidden',
            )}
        >
            <WifiOff className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
                <span className="font-medium">
                    {status === 'unavailable'
                        ? t('inbox.connection.unavailable')
                        : status === 'connecting'
                          ? t('inbox.connection.connecting')
                          : t('inbox.connection.reconnecting')}
                </span>{' '}
                {t('inbox.connection.polling', {
                    seconds: POLL_INTERVAL_MS / 1000,
                })}
            </span>
        </p>
    );
}
