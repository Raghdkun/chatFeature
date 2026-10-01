import { Composer } from '@/embed/components/composer';
import { useOverlay, useSnapshot } from '@/embed/components/context';
import { MessageList } from '@/embed/components/message-list';
import { NoticeBanner } from '@/embed/components/notice';
import { RatingCard } from '@/embed/components/rating-card';

/** `active` and `ended`: the conversation, then the composer (active) or the rating card (ended, transcript still readable). */
export function ChatScreen() {
    const { state, t } = useSnapshot();
    const { openImage } = useOverlay();

    return (
        <div className="flex min-h-0 flex-1 flex-col">
            {state.connection === 'reconnecting' ? (
                <div
                    role="status"
                    data-testid="connection-status"
                    className="text-subtle flex flex-none items-center justify-center gap-2 bg-muted px-3 py-1.5 text-[12px]"
                >
                    <span className="pne-spinner !size-3" aria-hidden="true" />
                    {t('embed.chat.status.reconnecting')}
                </div>
            ) : null}
            {state.notice !== null ? (
                <div className="flex-none px-4 pt-3">
                    <NoticeBanner />
                </div>
            ) : null}
            <MessageList
                onOpenImage={(attachment, alt) =>
                    openImage(attachment.url, alt)
                }
            />
            {state.phase === 'active' ? <Composer /> : <RatingCard />}
        </div>
    );
}
