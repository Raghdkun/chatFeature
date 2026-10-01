import { BellRing } from 'lucide-react';
import { OfferCard } from '@/components/inbox/offer-card';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import type { QueueItem } from '@/lib/realtime/staff/store';

/**
 * The Queue column: requests waiting for an agent, oldest first. The count below is a polite live region, so a screen reader hears
 * "2 chats waiting" when a request arrives without the countdowns chattering.
 */
export function QueueSection({
    items,
    canAccept,
    onAccept,
}: {
    items: QueueItem[];
    canAccept: boolean;
    onAccept: (ulid: string) => Promise<void>;
}) {
    const { t } = useTrans();
    const plural = usePlural();
    const open = items.filter((item) => item.state === 'open').length;

    return (
        <section
            data-testid="inbox-queue"
            aria-labelledby="inbox-queue-title"
            className="grid grid-cols-1 gap-2 px-3 pt-3"
        >
            <header className="flex items-center justify-between gap-2 px-1">
                <h2
                    id="inbox-queue-title"
                    className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                    <BellRing className="size-3.5" aria-hidden />
                    {t('inbox.queue.title')}
                </h2>
                {open > 0 && (
                    <span
                        data-testid="inbox-queue-count"
                        className="rounded-full bg-primary px-2 py-0.5 text-xs font-semibold text-primary-foreground tabular-nums"
                    >
                        {open}
                    </span>
                )}
            </header>

            <p role="status" className="sr-only">
                {plural('inbox.queue.waiting', open)}
            </p>

            {items.length === 0 ? (
                <p
                    data-testid="inbox-queue-empty"
                    className="rounded-lg border border-dashed px-3 py-3 text-center text-sm text-muted-foreground"
                >
                    {t('inbox.queue.empty')}
                </p>
            ) : (
                <ul className="grid min-w-0 grid-cols-1 gap-2">
                    {items.map((item) => (
                        <OfferCard
                            key={item.conversation}
                            item={item}
                            canAccept={canAccept}
                            onAccept={onAccept}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}
