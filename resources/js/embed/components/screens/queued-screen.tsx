import { useState } from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { MessageCircle } from '@/embed/components/icons';
import { NoticeBanner } from '@/embed/components/notice';
import { Button } from '@/embed/components/ui';
import { formatElapsed } from '@/embed/lib/format';
import { useElapsed } from '@/embed/hooks/use-elapsed';

/** `queued`: "Connecting you to an agent…", how long it has been, and a way out. The websocket is opening behind this screen. */
export function QueuedScreen() {
    const { state, t } = useSnapshot();
    const controller = useController();
    const [cancelling, setCancelling] = useState(false);
    const elapsed = useElapsed(state.queuedAt);

    const cancel = async (): Promise<void> => {
        setCancelling(true);

        try {
            await controller.cancelQueued();
        } finally {
            setCancelling(false);
        }
    };

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto p-6 text-center">
            <div
                className="relative mt-6 grid size-20 place-items-center"
                aria-hidden="true"
            >
                <span className="pne-ring bg-brand absolute inset-0 rounded-full" />
                <span className="pne-ring bg-brand absolute inset-0 rounded-full" />
                <span className="bg-brand text-on-brand relative grid size-14 place-items-center rounded-full">
                    <MessageCircle className="size-7" />
                </span>
            </div>
            <div className="flex flex-col gap-2">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[20px] leading-snug font-semibold outline-none"
                >
                    {state.transferred
                        ? t('embed.chat.queued.transferred')
                        : t('connecting')}
                </h2>
                <p
                    data-testid="queued-timer"
                    className="text-subtle text-[15px] tabular-nums"
                >
                    {t('embed.chat.queued.waiting', {
                        time: formatElapsed(elapsed),
                    })}
                </p>
                <p className="text-subtle mx-auto max-w-[28ch] text-[14px]">
                    {t('embed.chat.queued.hint')}
                </p>
            </div>
            <NoticeBanner />
            <Button
                variant="quiet"
                data-testid="queued-cancel"
                data-autofocus
                busy={cancelling}
                onClick={() => void cancel()}
            >
                {t('embed.chat.queued.cancel')}
            </Button>
        </section>
    );
}
