import { BadgeCheck, Check, Clock, Timer } from 'lucide-react';
import { useState } from 'react';
import {
    clockLabel,
    secondsSince,
    secondsUntil,
} from '@/components/inbox/format';
import { useNow } from '@/components/inbox/use-now';
import { VisitorAvatar } from '@/components/inbox/visitor-avatar';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { OFFER_EXIT_MS, type QueueItem } from '@/lib/realtime/staff/store';
import { cn } from '@/lib/utils';

const RING_RADIUS = 15;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

/** The time left on an offer as a ring with the seconds inside; hidden from assistive tech (it would chatter every second). */
function CountdownRing({ left, total }: { left: number; total: number }) {
    const fraction = total > 0 ? Math.min(1, left / total) : 0;
    const urgent = left <= 10;

    return (
        <div
            aria-hidden
            data-testid="offer-countdown"
            className={cn(
                'relative grid size-10 shrink-0 place-items-center text-[0.7rem] font-semibold tabular-nums',
                urgent ? 'text-destructive-foreground' : 'text-primary',
            )}
        >
            <svg viewBox="0 0 36 36" className="absolute inset-0 -rotate-90">
                <circle
                    cx="18"
                    cy="18"
                    r={RING_RADIUS}
                    fill="none"
                    strokeWidth="3"
                    className="stroke-border"
                />
                <circle
                    cx="18"
                    cy="18"
                    r={RING_RADIUS}
                    fill="none"
                    strokeWidth="3"
                    strokeLinecap="round"
                    stroke="currentColor"
                    strokeDasharray={RING_LENGTH}
                    strokeDashoffset={RING_LENGTH * (1 - fraction)}
                    className="transition-[stroke-dashoffset] duration-1000 ease-linear motion-reduce:transition-none"
                />
            </svg>
            <span className="relative">{clockLabel(left)}</span>
        </div>
    );
}

/**
 * One pending request: who, what about, a preview, the time left (or how long they have waited when the deadline is not known)
 * and the big Accept button. A lost race or a lapsed offer turns the card into a short message and lets it leave.
 */
export function OfferCard({
    item,
    canAccept,
    onAccept,
}: {
    item: QueueItem;
    /** Only agents can take chats; an admin who does not is monitoring. */
    canAccept: boolean;
    onAccept: (ulid: string) => Promise<void>;
}) {
    const { t } = useTrans();
    const now = useNow();
    const [accepting, setAccepting] = useState(false);
    const left = secondsUntil(item.expiresAt, now);
    const waited = secondsSince(item.waitingSince, now);
    const total =
        item.expiresAt === null
            ? 0
            : (item.totalSeconds ??
              Math.max(
                  1,
                  Math.round(
                      (Date.parse(item.expiresAt) -
                          Date.parse(item.waitingSince)) /
                          1000,
                  ),
              ));
    const open = item.state === 'open';
    const name = item.visitorName ?? t('inbox.visitor.anonymous');

    const accept = async (): Promise<void> => {
        setAccepting(true);

        try {
            await onAccept(item.conversation);
        } finally {
            setAccepting(false);
        }
    };

    return (
        <li
            data-testid={`offer-${item.conversation}`}
            data-state={item.state}
            style={
                open
                    ? undefined
                    : { animationDelay: `${OFFER_EXIT_MS - 350}ms` }
            }
            className={cn(
                'rounded-xl border bg-card p-3 shadow-xs',
                'animate-in duration-200 ease-out-quart fade-in-0 slide-in-from-top-2 motion-reduce:animate-none',
                open
                    ? 'border-primary/30'
                    : 'animate-out duration-300 fade-out-0 fill-mode-forwards motion-reduce:animate-none',
            )}
        >
            <div className="flex items-start gap-3">
                <VisitorAvatar name={item.visitorName} />
                <div className="min-w-0 flex-1">
                    <p className="flex items-center gap-1.5 text-sm font-semibold">
                        <span className="truncate">{name}</span>
                        {item.verified && (
                            <BadgeCheck
                                className="size-4 shrink-0 text-primary"
                                aria-label={t('inbox.visitor.verified')}
                            />
                        )}
                    </p>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
                        {item.category && (
                            <span
                                data-testid={`offer-category-${item.conversation}`}
                                className="rounded-full bg-secondary px-2 py-0.5 font-medium text-secondary-foreground"
                            >
                                {item.category.label}
                            </span>
                        )}
                        {item.widgetName && (
                            <span className="truncate">{item.widgetName}</span>
                        )}
                    </p>
                </div>
                {open && left !== null && (
                    <CountdownRing left={left} total={total} />
                )}
            </div>

            {item.preview && (
                <p
                    dir="auto"
                    className="mt-2.5 line-clamp-2 text-sm break-words text-foreground/90"
                >
                    {item.preview}
                </p>
            )}

            {open ? (
                <>
                    {left === null && (
                        <p
                            aria-hidden
                            className="mt-2 flex items-center gap-1 text-xs text-muted-foreground tabular-nums"
                        >
                            <Timer className="size-3.5" />
                            {t('inbox.offer.waiting', {
                                time: clockLabel(waited),
                            })}
                        </p>
                    )}
                    {canAccept ? (
                        <Button
                            size="lg"
                            data-testid={`offer-accept-${item.conversation}`}
                            className="mt-3 h-11 w-full text-base transition-transform duration-150 ease-out-quart active:scale-[0.98] motion-reduce:transition-none"
                            disabled={accepting}
                            aria-busy={accepting}
                            onClick={() => void accept()}
                        >
                            {accepting ? <Busy /> : <Check aria-hidden />}
                            {t('inbox.accept')}
                            <span className="sr-only">
                                {' '}
                                {t('inbox.accept_for', { name })}
                            </span>
                        </Button>
                    ) : (
                        <p className="mt-3 text-xs text-muted-foreground">
                            {t('inbox.offer.monitoring')}
                        </p>
                    )}
                </>
            ) : (
                <p
                    data-testid={`offer-outcome-${item.conversation}`}
                    role="status"
                    className="mt-3 flex items-center gap-1.5 rounded-md bg-muted px-2.5 py-2 text-sm text-muted-foreground"
                >
                    {item.state === 'taken' ? (
                        <>
                            <Check className="size-4" aria-hidden />
                            {item.takenBy
                                ? t('inbox.offer.taken_by', {
                                      name: item.takenBy,
                                  })
                                : t('inbox.offer.taken')}
                        </>
                    ) : (
                        <>
                            <Clock className="size-4" aria-hidden />
                            {t('inbox.offer.expired')}
                        </>
                    )}
                </p>
            )}
        </li>
    );
}
