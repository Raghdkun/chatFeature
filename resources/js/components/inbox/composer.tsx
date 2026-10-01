import { ImagePlus, MessageSquareText, SendHorizontal, X } from 'lucide-react';
import {
    useEffect,
    useId,
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type DragEvent,
    type KeyboardEvent,
} from 'react';
import {
    useAttachments,
    type PendingAttachment,
} from '@/components/inbox/use-attachments';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import {
    ATTACHMENT_MAX_BYTES,
    ATTACHMENT_MIME_TYPES,
} from '@/lib/chat-api/staff';
import type { AttachmentData } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

/** The textarea grows with its content up to this height (about eight lines), then scrolls. */
const MAX_HEIGHT_PX = 176;

/**
 * Where canned replies will plug in (a later phase). It renders a quiet, disabled control so the layout and the keyboard order are
 * settled now; `onPick` is the contract for whoever fills it.
 */
export function CannedRepliesSlot({
    disabled,
}: {
    onPick?: (text: string) => void;
    disabled?: boolean;
}) {
    const { t } = useTrans();

    return (
        <Button
            type="button"
            variant="ghost"
            size="icon"
            data-testid="composer-canned"
            data-slot="canned-replies"
            aria-label={t('inbox.composer.canned')}
            title={t('inbox.composer.canned_soon')}
            disabled
            aria-disabled
            className={cn(disabled && 'hidden')}
        >
            <MessageSquareText aria-hidden />
        </Button>
    );
}

function AttachmentChip({
    item,
    onRemove,
}: {
    item: PendingAttachment;
    onRemove: (id: string) => void;
}) {
    const { t } = useTrans();
    const failed = item.status === 'error';
    const reason =
        item.error === 'type'
            ? t('inbox.composer.error_type')
            : item.error === 'size'
              ? t('inbox.composer.error_size', {
                    size: Math.round(ATTACHMENT_MAX_BYTES / (1024 * 1024)),
                })
              : (item.message ?? t('inbox.composer.error_upload'));

    return (
        <li
            data-testid={`composer-attachment-${item.id}`}
            data-status={item.status}
            className={cn(
                'relative flex items-center gap-2 rounded-lg border bg-background p-1.5 pe-8',
                failed && 'border-destructive/60',
            )}
        >
            <span className="relative grid size-12 shrink-0 place-items-center overflow-hidden rounded-md bg-muted">
                {item.previewUrl !== '' ? (
                    <img
                        src={item.previewUrl}
                        alt=""
                        className={cn(
                            'size-full object-cover',
                            item.status === 'uploading' && 'opacity-60',
                        )}
                    />
                ) : (
                    <ImagePlus
                        className="size-5 text-muted-foreground"
                        aria-hidden
                    />
                )}
                {item.status === 'uploading' && (
                    <span
                        className="absolute inset-x-0 bottom-0 h-1 bg-border"
                        aria-hidden
                    >
                        <span
                            className="block h-full bg-primary transition-[width] duration-150 ease-linear motion-reduce:transition-none"
                            style={{
                                width: `${Math.round(item.progress * 100)}%`,
                            }}
                        />
                    </span>
                )}
            </span>
            <span className="grid max-w-40 min-w-0 text-xs">
                <span className="truncate font-medium">{item.name}</span>
                <span
                    role={failed ? 'alert' : undefined}
                    className={cn(
                        failed
                            ? 'text-destructive-foreground'
                            : 'text-muted-foreground',
                    )}
                >
                    {failed
                        ? reason
                        : item.status === 'uploading'
                          ? t('inbox.composer.uploading', {
                                percent: Math.round(item.progress * 100),
                            })
                          : t('inbox.composer.attached')}
                </span>
            </span>
            <button
                type="button"
                data-testid={`composer-attachment-remove-${item.id}`}
                aria-label={t('inbox.composer.remove', { name: item.name })}
                onClick={() => onRemove(item.id)}
                className="absolute end-1 top-1 grid size-6 place-items-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:ring-[3px] focus-visible:ring-ring/50"
            >
                <X className="size-3.5" aria-hidden />
            </button>
        </li>
    );
}

/**
 * The message box: an auto-growing textarea (Enter sends, Shift+Enter breaks the line, an IME composition is left alone), image
 * attachments by button, paste or drop, a typing signal for the visitor, and a quiet reason in place of the box when the chat can no
 * longer be written to.
 */
export function Composer({
    conversation,
    disabledReason,
    emailNotice,
    onSend,
    onTyping,
}: {
    conversation: string;
    /** Why nothing can be sent (the chat ended, was transferred, ...); `null` = the agent can write. */
    disabledReason: string | null;
    /** Offline tickets: the address the reply is also e-mailed to. */
    emailNotice: string | null;
    onSend: (input: {
        body: string;
        attachments: AttachmentData[];
    }) => Promise<void>;
    onTyping: (typing: boolean) => void;
}) {
    const { t } = useTrans();
    const inputId = useId();
    const [value, setValue] = useState('');
    const [dragging, setDragging] = useState(false);
    const area = useRef<HTMLTextAreaElement>(null);
    const files = useRef<HTMLInputElement>(null);
    const attachments = useAttachments(conversation);
    const blocked = disabledReason !== null;
    const canSend =
        !blocked &&
        !attachments.uploading &&
        (value.trim() !== '' || attachments.ready.length > 0);

    // A pointer-and-keyboard device lands in the box when a chat opens; a phone does not (it would raise the keyboard over the chat).
    useEffect(() => {
        if (!blocked && window.matchMedia?.('(pointer: fine)').matches) {
            area.current?.focus();
        }
        // Only when the chat opens (or becomes writable), not on every keystroke.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [blocked, conversation]);

    useLayoutEffect(() => {
        const element = area.current;

        if (element) {
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT_PX)}px`;
        }
    }, [value]);

    const submit = async (): Promise<void> => {
        if (!canSend) {
            return;
        }

        const body = value;
        const ready = attachments.ready;

        setValue('');
        attachments.clear();
        onTyping(false);
        area.current?.focus();
        await onSend({ body, attachments: ready });
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
        ) {
            event.preventDefault();
            void submit();
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const pasted = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
        );

        if (pasted.length > 0 && !blocked) {
            event.preventDefault();
            attachments.add(pasted);
        }
    };

    const onDrop = (event: DragEvent<HTMLDivElement>): void => {
        event.preventDefault();
        setDragging(false);

        if (!blocked) {
            attachments.add(Array.from(event.dataTransfer.files));
        }
    };

    return (
        <div
            data-testid="composer"
            data-dragging={dragging ? 'true' : undefined}
            onDragOver={(event) => {
                if (!blocked && event.dataTransfer.types.includes('Files')) {
                    event.preventDefault();
                    setDragging(true);
                }
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
                'border-t bg-background px-3 pt-2 pb-[max(0.75rem,env(safe-area-inset-bottom))] sm:px-5',
                dragging && 'bg-accent/50',
            )}
        >
            {blocked ? (
                <p
                    data-testid="composer-disabled"
                    role="status"
                    className="rounded-lg bg-muted px-3 py-3 text-center text-sm text-muted-foreground"
                >
                    {disabledReason}
                </p>
            ) : (
                <>
                    {emailNotice && (
                        <p
                            data-testid="composer-email-notice"
                            className="mb-2 text-xs text-muted-foreground"
                        >
                            {emailNotice}
                        </p>
                    )}

                    {attachments.items.length > 0 && (
                        <ul
                            data-testid="composer-attachments"
                            aria-label={t('inbox.composer.attachments')}
                            className="mb-2 flex flex-wrap gap-2"
                        >
                            {attachments.items.map((item) => (
                                <AttachmentChip
                                    key={item.id}
                                    item={item}
                                    onRemove={attachments.remove}
                                />
                            ))}
                        </ul>
                    )}

                    <div className="flex items-end gap-1.5 rounded-2xl border bg-background p-1.5 shadow-xs transition-[box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/40">
                        <input
                            ref={files}
                            type="file"
                            multiple
                            hidden
                            data-testid="composer-file"
                            accept={ATTACHMENT_MIME_TYPES.join(',')}
                            onChange={(event) => {
                                attachments.add(
                                    Array.from(event.target.files ?? []),
                                );
                                event.target.value = '';
                            }}
                        />
                        <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            data-testid="composer-attach"
                            aria-label={t('inbox.composer.attach')}
                            title={t('inbox.composer.attach')}
                            onClick={() => files.current?.click()}
                        >
                            <ImagePlus aria-hidden />
                        </Button>
                        <CannedRepliesSlot />

                        <label htmlFor={inputId} className="sr-only">
                            {t('inbox.composer.label')}
                        </label>
                        <textarea
                            id={inputId}
                            ref={area}
                            rows={1}
                            value={value}
                            data-testid="composer-input"
                            placeholder={t('inbox.composer.placeholder')}
                            enterKeyHint="send"
                            onChange={(event) => {
                                setValue(event.target.value);
                                onTyping(event.target.value.trim() !== '');
                            }}
                            onBlur={() => onTyping(false)}
                            onKeyDown={onKeyDown}
                            onPaste={onPaste}
                            className="max-h-44 min-h-9 min-w-0 flex-1 resize-none bg-transparent px-2 py-2 text-base outline-none placeholder:text-muted-foreground md:text-sm"
                        />
                        <Button
                            type="button"
                            size="icon"
                            data-testid="composer-send"
                            aria-label={t('inbox.composer.send')}
                            title={t('inbox.composer.send')}
                            disabled={!canSend}
                            onClick={() => void submit()}
                            className="rounded-xl transition-transform duration-150 ease-out-quart active:scale-95 motion-reduce:transition-none"
                        >
                            {attachments.uploading ? (
                                <Busy />
                            ) : (
                                <SendHorizontal
                                    className="rtl:-scale-x-100"
                                    aria-hidden
                                />
                            )}
                        </Button>
                    </div>
                    <p className="mt-1.5 hidden px-2 text-xs text-muted-foreground sm:block [@media(pointer:coarse)]:hidden">
                        {t('inbox.composer.hint')}
                    </p>
                </>
            )}
        </div>
    );
}
