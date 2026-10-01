import {
    useLayoutEffect,
    useRef,
    useState,
    type ClipboardEvent,
    type KeyboardEvent,
} from 'react';
import { useController, useSnapshot } from '@/embed/components/context';
import { ArrowUp, Paperclip, X } from '@/embed/components/icons';
import { IconButton } from '@/embed/components/ui';
import { useAttachments } from '@/embed/hooks/use-attachments';
import {
    ALLOWED_IMAGE_TYPES,
    MAX_ATTACHMENT_BYTES,
} from '@/embed/lib/attachments';
import { formatBytes } from '@/embed/lib/format';
import { MAX_MESSAGE } from '@/embed/session/flow';
import { MAX_ATTACHMENTS } from '@/embed/session/controller';

const MAX_HEIGHT = 120;

/** The message box: auto-growing, Enter sends, Shift+Enter breaks the line, images can be attached, pasted and removed before sending. */
export function Composer() {
    const { state, config, t } = useSnapshot();
    const controller = useController();
    const attachments = useAttachments(controller);
    const [text, setText] = useState('');
    const area = useRef<HTMLTextAreaElement>(null);
    const picker = useRef<HTMLInputElement>(null);
    const canAttach = config?.features.attachments === true;
    const sendable =
        (text.trim() !== '' || attachments.readyCount > 0) &&
        !attachments.uploading &&
        state.busy !== 'ending';

    useLayoutEffect(() => {
        const element = area.current;

        if (element !== null) {
            element.style.height = 'auto';
            element.style.height = `${Math.min(element.scrollHeight, MAX_HEIGHT)}px`;
        }
    }, [text]);

    const submit = (): void => {
        if (!sendable) {
            return;
        }

        controller.send({ body: text, attachments: attachments.take() });
        setText('');
        area.current?.focus();
    };

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
        if (
            event.key === 'Enter' &&
            !event.shiftKey &&
            !event.nativeEvent.isComposing
        ) {
            event.preventDefault();
            submit();
        }
    };

    const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
        const files = Array.from(event.clipboardData.files).filter((file) =>
            file.type.startsWith('image/'),
        );

        if (canAttach && files.length > 0) {
            event.preventDefault();
            attachments.add(files);
        }
    };

    const problemText = {
        type: t('embed.chat.composer.bad_type'),
        size: t('embed.chat.composer.too_big', {
            size: formatBytes(MAX_ATTACHMENT_BYTES),
        }),
        count: t('embed.chat.composer.too_many', { count: MAX_ATTACHMENTS }),
        upload: t('embed.chat.composer.upload_failed'),
    };

    return (
        <div className="border-line bg-surface flex flex-none flex-col gap-2 border-t px-3 pt-2.5 pb-[calc(0.625rem+var(--pne-safe-b,0px))]">
            {attachments.items.length > 0 ? (
                <ul className="m-0 flex list-none flex-wrap gap-2 p-0">
                    {attachments.items.map((item) => (
                        <li
                            key={item.id}
                            data-testid="composer-attachment"
                            data-status={item.status}
                            className="relative size-16 overflow-hidden rounded-md bg-muted"
                        >
                            <img
                                src={item.previewUrl}
                                alt={item.name}
                                className="size-full object-cover"
                            />
                            {item.status === 'uploading' ? (
                                <span
                                    role="progressbar"
                                    aria-label={t(
                                        'embed.chat.composer.uploading',
                                    )}
                                    aria-valuemin={0}
                                    aria-valuemax={100}
                                    aria-valuenow={Math.round(
                                        item.progress * 100,
                                    )}
                                    className="absolute inset-x-0 bottom-0 h-1.5 bg-black/30"
                                >
                                    <span
                                        className="bg-brand block h-full transition-[inline-size] duration-150"
                                        style={{
                                            inlineSize: `${item.progress * 100}%`,
                                        }}
                                    />
                                </span>
                            ) : null}
                            {item.status === 'error' ? (
                                <span
                                    className="bg-danger/70 absolute inset-0"
                                    aria-hidden="true"
                                />
                            ) : null}
                            <button
                                type="button"
                                aria-label={t(
                                    'embed.chat.composer.remove_attachment',
                                )}
                                data-testid="composer-attachment-remove"
                                onClick={() => attachments.remove(item.id)}
                                className="pne-press pne-focus absolute end-0.5 top-0.5 grid size-6 place-items-center rounded-full bg-black/60 text-white"
                            >
                                <X aria-hidden="true" className="size-3.5" />
                            </button>
                        </li>
                    ))}
                </ul>
            ) : null}
            {attachments.problem !== null ? (
                <p role="alert" className="text-danger text-[13px]">
                    {problemText[attachments.problem]}
                </p>
            ) : null}
            <div className="flex items-end gap-2">
                {canAttach ? (
                    <>
                        <IconButton
                            label={t('attach')}
                            data-testid="composer-attach"
                            onClick={() => picker.current?.click()}
                            className="text-subtle"
                        >
                            <Paperclip aria-hidden="true" className="size-5" />
                        </IconButton>
                        <input
                            ref={picker}
                            type="file"
                            data-testid="composer-file"
                            accept={ALLOWED_IMAGE_TYPES.join(',')}
                            multiple
                            tabIndex={-1}
                            aria-hidden="true"
                            className="hidden"
                            onChange={(event) => {
                                attachments.add(
                                    Array.from(event.target.files ?? []),
                                );
                                event.target.value = '';
                            }}
                        />
                    </>
                ) : null}
                <textarea
                    ref={area}
                    data-testid="composer-input"
                    data-autofocus
                    rows={1}
                    value={text}
                    maxLength={MAX_MESSAGE}
                    enterKeyHint="send"
                    aria-label={t('embed.chat.composer.label')}
                    placeholder={t('placeholder')}
                    onChange={(event) => {
                        setText(event.target.value);
                        controller.typingChanged(
                            event.target.value.trim() !== '',
                        );
                    }}
                    onBlur={() => controller.typingChanged(false)}
                    onKeyDown={onKeyDown}
                    onPaste={onPaste}
                    className="pne-focus bg-surface text-ink border-line placeholder:text-subtle focus-visible:border-brand focus-visible:ring-brand/30 block max-h-[120px] min-h-11 min-w-0 flex-1 resize-none rounded-lg border px-3.5 py-2.5 text-[15px] leading-snug focus-visible:ring-2 focus-visible:outline-none"
                />
                <button
                    type="button"
                    data-testid="composer-send"
                    aria-label={t('send')}
                    title={t('send')}
                    disabled={!sendable}
                    onClick={submit}
                    className="pne-press pne-focus bg-brand text-on-brand pne-hover-fill grid size-11 shrink-0 place-items-center rounded-full disabled:cursor-not-allowed disabled:opacity-40"
                >
                    <ArrowUp aria-hidden="true" className="size-5" />
                </button>
            </div>
        </div>
    );
}
