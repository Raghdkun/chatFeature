import { useEffect, useId, useRef, type KeyboardEvent } from 'react';
import {
    useController,
    useOverlay,
    useSnapshot,
} from '@/embed/components/context';
import { X } from '@/embed/components/icons';
import { Button } from '@/embed/components/ui';

/** Full-size image over the panel. Escape closes the lightbox only (the panel's own Escape handler never sees it). */
export function Lightbox({
    url,
    alt,
    ulid,
}: {
    url: string;
    alt: string;
    ulid?: string;
}) {
    const { t, state } = useSnapshot();
    const controller = useController();
    const { close } = useOverlay();
    // The signed URL may have expired since the picture was opened or while it was open: follow the refreshed one.
    const current =
        ulid === undefined
            ? url
            : (state.messages
                  .flatMap((message) => message.attachments)
                  .find((attachment) => attachment.ulid === ulid)?.url ?? url);
    const closeButton = useRef<HTMLButtonElement>(null);

    useEffect(() => closeButton.current?.focus(), []);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab') {
            event.preventDefault();
            closeButton.current?.focus();
        }
    };

    return (
        <div
            role="dialog"
            aria-modal="true"
            aria-label={alt}
            data-testid="lightbox"
            onKeyDown={onKeyDown}
            className="pne-sheet fixed inset-0 z-30 flex flex-col bg-black/85"
        >
            <div className="flex justify-end p-2">
                <button
                    ref={closeButton}
                    type="button"
                    data-testid="lightbox-close"
                    aria-label={t('embed.chat.lightbox.close')}
                    onClick={close}
                    className="pne-press pne-focus grid size-11 place-items-center rounded-full bg-white/15 text-white"
                >
                    <X aria-hidden="true" className="size-5" />
                </button>
            </div>
            <button
                type="button"
                tabIndex={-1}
                aria-hidden="true"
                onClick={close}
                className="flex min-h-0 flex-1 cursor-zoom-out items-center justify-center p-3 pt-0"
            >
                <img
                    src={current}
                    alt={alt}
                    onError={() => void controller.refreshAttachmentUrls()}
                    referrerPolicy="no-referrer"
                    className="max-h-full max-w-full rounded-md object-contain"
                />
            </button>
        </div>
    );
}

/** "End this chat?" with the safe answer focused. */
export function EndChatDialog({ onConfirm }: { onConfirm: () => void }) {
    const { t, state } = useSnapshot();
    const { close } = useOverlay();
    const titleId = useId();
    const bodyId = useId();
    const keep = useRef<HTMLButtonElement>(null);
    const confirm = useRef<HTMLButtonElement>(null);

    useEffect(() => keep.current?.focus(), []);

    const onKeyDown = (event: KeyboardEvent): void => {
        if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close();
        } else if (event.key === 'Tab') {
            // In document order: the confirm button comes first (the primary action reads first), "Keep chatting" last.
            const first = confirm.current;
            const last = keep.current;

            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first?.focus();
            }
        }
    };

    return (
        <div
            className="fixed inset-0 z-30 flex items-end justify-center bg-black/45 p-3"
            onKeyDown={onKeyDown}
        >
            <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby={titleId}
                aria-describedby={bodyId}
                data-testid="end-chat-dialog"
                className="pne-sheet bg-surface text-ink flex w-full max-w-sm flex-col gap-3 rounded-lg p-5 shadow-xl"
            >
                <h2 id={titleId} className="text-[17px] font-semibold">
                    {t('embed.chat.end.title')}
                </h2>
                <p id={bodyId} className="text-subtle text-[14px]">
                    {t('embed.chat.end.body')}
                </p>
                <div className="flex flex-col gap-2 sm:flex-row-reverse">
                    <Button
                        ref={confirm}
                        data-testid="end-chat-confirm"
                        busy={state.busy === 'ending'}
                        onClick={onConfirm}
                        className="flex-1"
                    >
                        {t('endChat')}
                    </Button>
                    <Button
                        ref={keep}
                        variant="quiet"
                        data-testid="end-chat-keep"
                        onClick={close}
                        className="flex-1"
                    >
                        {t('embed.chat.end.keep')}
                    </Button>
                </div>
            </div>
        </div>
    );
}
