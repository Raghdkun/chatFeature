import { Fragment } from 'react';
import {
    AlertCircle,
    Check,
    CheckCheck,
    Clock,
    RotateCcw,
} from '@/embed/components/icons';
import { Avatar } from '@/embed/components/ui';
import { formatTime } from '@/embed/lib/format';
import { messageTestId } from '@/embed/lib/group';
import { linkify } from '@/lib/chat/linkify';
import type { Translate } from '@/embed/i18n';
import {
    isFinalFailure,
    type AttachmentData,
    type LocalMessage,
    type MessageFailure,
    type MessageStatus,
} from '@/lib/chat/types';

/** Plain text with URLs turned into links (`rel="noopener noreferrer nofollow"`); never HTML. */
export function MessageText({ body }: { body: string }) {
    return (
        <>
            {linkify(body).map((segment, index) =>
                segment.type === 'link' ? (
                    <a
                        key={index}
                        href={segment.href}
                        target="_blank"
                        rel="noopener noreferrer nofollow"
                        className="pne-focus rounded-sm [overflow-wrap:anywhere] underline underline-offset-2"
                    >
                        {segment.text}
                    </a>
                ) : (
                    <Fragment key={index}>{segment.text}</Fragment>
                ),
            )}
        </>
    );
}

const STATUS_KEY = {
    sending: 'embed.chat.message.sending',
    sent: 'embed.chat.message.sent',
    delivered: 'embed.chat.message.delivered',
    seen: 'embed.chat.message.seen',
    failed: 'embed.chat.message.failed',
} as const satisfies Record<MessageStatus, string>;

const FAILURE_KEY = {
    too_long: 'embed.chat.message.failed_too_long',
    rejected: 'embed.chat.message.failed_rejected',
    forbidden: 'embed.chat.message.failed_rejected',
    closed: 'embed.chat.message.failed_closed',
    rate_limited: 'embed.chat.message.failed_rate_limited',
    network: 'embed.chat.message.failed',
    unknown: 'embed.chat.message.failed',
} as const satisfies Record<MessageFailure, string>;

/** Delivered / seen ticks. The status is also written out for screen readers (and for the newest message, for everyone). */
export function Receipt({
    status,
    t,
    showText,
}: {
    status: MessageStatus;
    t: Translate;
    showText: boolean;
}) {
    const label = t(STATUS_KEY[status]);
    const Icon =
        status === 'sending'
            ? Clock
            : status === 'sent'
              ? Check
              : status === 'failed'
                ? AlertCircle
                : CheckCheck;

    return (
        <span
            data-testid="message-receipt"
            className={`inline-flex items-center gap-1 ${status === 'seen' ? 'text-brand' : ''}`}
        >
            <Icon aria-hidden="true" className="size-3.5" />
            <span className={showText ? '' : 'sr-only'}>{label}</span>
        </span>
    );
}

type Props = {
    message: LocalMessage;
    t: Translate;
    locale: string;
    groupStart: boolean;
    groupEnd: boolean;
    isNew: boolean;
    /** The visitor's newest message: its status is spelled out. */
    showStatusText: boolean;
    onRetry: (clientMsgId: string) => void;
    onDiscard: (clientMsgId: string) => void;
    onOpenImage: (attachment: AttachmentData, alt: string) => void;
    /** An attached picture finished loading (the list got taller). */
    onImageLoad?: () => void;
    /** An attached picture failed to load (its signed URL may have expired): the caller refreshes the URLs. */
    onImageError?: () => void;
};

export function MessageBubble({
    message,
    t,
    locale,
    groupStart,
    groupEnd,
    isNew,
    showStatusText,
    onRetry,
    onDiscard,
    onOpenImage,
    onImageLoad,
    onImageError,
}: Props) {
    const mine = message.sender.type === 'visitor';
    const failed = message.status === 'failed';
    const author = mine ? t('embed.chat.message.you') : message.sender.name;
    const imageOnly = message.attachments.length > 0 && !message.body;

    return (
        <div
            data-testid={messageTestId(message)}
            data-status={message.status}
            data-sender={message.sender.type}
            className={`flex w-full gap-2 ${mine ? 'justify-end' : 'justify-start'} ${groupStart ? 'mt-3' : 'mt-1'} ${isNew ? 'pne-msg-new' : ''}`}
        >
            {mine ? null : (
                <span className="w-8 shrink-0">
                    {groupStart ? (
                        <Avatar
                            name={message.sender.name}
                            url={message.sender.avatarUrl}
                            size={32}
                        />
                    ) : null}
                </span>
            )}
            <div
                className={`flex max-w-[82%] min-w-0 flex-col ${mine ? 'items-end' : 'items-start'}`}
            >
                {!mine && groupStart && message.sender.name ? (
                    <span className="text-subtle mb-0.5 ps-1 text-[12px]">
                        {message.sender.name}
                    </span>
                ) : null}
                <div
                    className={`min-w-0 text-[15px] leading-snug [overflow-wrap:anywhere] whitespace-pre-wrap ${
                        imageOnly ? 'p-1' : 'px-3.5 py-2'
                    } rounded-lg ${
                        mine
                            ? `bg-brand text-on-brand ${groupEnd ? 'rounded-ee-sm' : ''}`
                            : `text-ink bg-muted ${groupEnd ? 'rounded-es-sm' : ''}`
                    } ${failed ? 'ring-danger ring-2' : ''} ${message.status === 'sending' ? 'opacity-80' : ''}`}
                >
                    {message.attachments.length > 0 ? (
                        <div
                            className={`flex flex-wrap gap-1.5 ${message.body ? 'mb-2' : ''}`}
                        >
                            {message.attachments.map((attachment) => {
                                const alt = t('embed.chat.message.image_alt', {
                                    name: author ?? '',
                                });

                                return (
                                    <button
                                        key={attachment.ulid}
                                        type="button"
                                        data-testid="message-image"
                                        onClick={() =>
                                            onOpenImage(attachment, alt)
                                        }
                                        className="pne-press pne-focus block overflow-hidden rounded-md"
                                    >
                                        <img
                                            src={
                                                attachment.thumbUrl ??
                                                attachment.url
                                            }
                                            alt={alt}
                                            loading="lazy"
                                            width={
                                                attachment.width ?? undefined
                                            }
                                            height={
                                                attachment.height ?? undefined
                                            }
                                            referrerPolicy="no-referrer"
                                            onLoad={onImageLoad}
                                            onError={onImageError}
                                            className="block h-auto max-h-48 w-auto max-w-full object-cover"
                                            style={{ maxInlineSize: '220px' }}
                                        />
                                    </button>
                                );
                            })}
                        </div>
                    ) : null}
                    {message.body ? <MessageText body={message.body} /> : null}
                </div>
                {failed && message.clientMsgId !== null ? (
                    <div className="text-danger mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 px-1 text-[12px]">
                        <span className="inline-flex items-center gap-1">
                            <AlertCircle
                                aria-hidden="true"
                                className="size-3.5"
                            />
                            {t(FAILURE_KEY[message.failure ?? 'unknown'])}
                        </span>
                        {isFinalFailure(message.failure) ? null : (
                            <button
                                type="button"
                                data-testid="message-retry"
                                onClick={() =>
                                    onRetry(message.clientMsgId ?? '')
                                }
                                className="pne-focus inline-flex items-center gap-1 rounded-sm font-semibold underline underline-offset-2"
                            >
                                <RotateCcw
                                    aria-hidden="true"
                                    className="size-3.5"
                                />
                                {t('embed.chat.message.retry')}
                            </button>
                        )}
                        <button
                            type="button"
                            onClick={() => onDiscard(message.clientMsgId ?? '')}
                            className="pne-focus rounded-sm underline underline-offset-2"
                        >
                            {t('embed.chat.message.discard')}
                        </button>
                    </div>
                ) : groupEnd || message.status === 'sending' ? (
                    // The time and the receipts are read in browse mode, but never announced as the log changes.
                    <div
                        aria-live="off"
                        className="text-subtle mt-1 flex items-center gap-2 px-1 text-[11px]"
                    >
                        <time dateTime={message.createdAt}>
                            {formatTime(message.createdAt, locale)}
                        </time>
                        {mine ? (
                            <Receipt
                                status={message.status}
                                t={t}
                                showText={showStatusText}
                            />
                        ) : null}
                    </div>
                ) : null}
            </div>
        </div>
    );
}
