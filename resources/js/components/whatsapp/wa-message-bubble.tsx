import {
    FileText,
    MapPin,
    Mic,
    Paperclip,
    RotateCw,
    Smile,
    Trash2,
    UserRound,
    Video,
    type LucideIcon,
} from 'lucide-react';
import { clockTime, fullDateTime } from '@/components/inbox/format';
import { MessageBody } from '@/components/inbox/message-body';
import { formatBytes, type WaListEntry } from '@/components/whatsapp/format';
import { StatusTicks } from '@/components/whatsapp/status-ticks';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { waitLabel } from '@/lib/whatsapp-api/client';
import {
    isFinalSendFailure,
    type DisplayMessage,
    type WaSendFailure,
} from '@/lib/whatsapp/transcript';
import type { WaMessageType } from '@/lib/whatsapp/types';
import { cn } from '@/lib/utils';

type MessageEntry = Extract<WaListEntry, { kind: 'message' }>;

const FAILURE_KEY = {
    session_not_ready: 'whatsapp.message.failed.session_not_ready',
    daily_cap: 'whatsapp.message.failed.daily_cap',
    pacing: 'whatsapp.message.failed.pacing',
    rate_limited: 'whatsapp.message.failed.rate_limited',
    not_inbound: 'whatsapp.message.failed.not_inbound',
    too_long: 'whatsapp.message.failed.too_long',
    rejected: 'whatsapp.message.failed.rejected',
    forbidden: 'whatsapp.message.failed.forbidden',
    not_found: 'whatsapp.message.failed.not_found',
    network: 'whatsapp.message.failed.network',
    unknown: 'whatsapp.message.failed.unknown',
} as const satisfies Record<WaSendFailure, string>;

const TYPE_ICON: Partial<Record<WaMessageType, LucideIcon>> = {
    video: Video,
    audio: Mic,
    voice: Mic,
    document: FileText,
    sticker: Smile,
    location: MapPin,
    contact: UserRound,
};

/**
 * A message that has no file in this app (P6-D7: only images are stored): what it was, its name and size, and the plain statement that
 * the attachment is not stored. Never a download link, never a guess at the content.
 */
function UnstoredMedia({ message }: { message: DisplayMessage }) {
    const { t, locale } = useTrans();
    const Icon = TYPE_ICON[message.type] ?? Paperclip;
    const size = formatBytes(message.media?.size, locale);
    const detail = [message.media?.filename, size]
        .filter((part): part is string => Boolean(part))
        .join(' · ');

    return (
        <div
            data-testid={`wa-message-media-${message.ulid}`}
            className="flex min-w-0 items-center gap-2.5 rounded-lg border border-dashed border-current/25 px-2.5 py-2"
        >
            <Icon className="size-5 shrink-0 opacity-80" aria-hidden />
            <span className="grid min-w-0 text-xs">
                <span className="font-medium">
                    {t(`whatsapp.message.type.${message.type}`)} ·{' '}
                    {t('whatsapp.message.not_stored')}
                </span>
                {detail !== '' && (
                    <span dir="auto" className="truncate opacity-80">
                        {detail}
                    </span>
                )}
            </span>
        </div>
    );
}

function StoredImage({
    message,
    onOpen,
    onLoad,
    onError,
}: {
    message: DisplayMessage;
    onOpen: (message: DisplayMessage) => void;
    onLoad: () => void;
    onError?: () => void;
}) {
    const { t } = useTrans();
    const url = message.media?.url ?? null;

    if (url === null || message.media?.available !== true) {
        return <UnstoredMedia message={message} />;
    }

    return (
        <button
            type="button"
            data-testid={`wa-message-image-${message.ulid}`}
            onClick={() => onOpen(message)}
            aria-label={t('whatsapp.message.open_image')}
            className="block overflow-hidden rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
        >
            <img
                src={url}
                alt={t('whatsapp.message.image_alt')}
                loading="lazy"
                onLoad={onLoad}
                onError={onError}
                className="max-h-60 min-h-16 w-auto max-w-full rounded-lg bg-muted object-cover"
            />
        </button>
    );
}

/**
 * One row of the transcript: a bubble (customer at the start, administrator at the end) with its time and ticks. Text goes through the
 * safe linkifier (never HTML); an image through its signed URL (a failed load asks the owner for fresh ones); everything else is a typed
 * "attachment not stored" card. A reply that did not go out says why under the bubble, with Retry where a retry can help.
 */
export function WaMessageBubble({
    entry,
    onRetry,
    onDiscard,
    onOpenImage,
    onImageLoad,
    onImageError,
}: {
    entry: MessageEntry;
    onRetry: (clientMsgId: string) => void;
    onDiscard: (clientMsgId: string) => void;
    onOpenImage: (message: DisplayMessage) => void;
    onImageLoad: () => void;
    onImageError?: () => void;
}) {
    const { t, locale } = useTrans();
    const { message, startsGroup, endsGroup } = entry;
    const mine = message.direction === 'out';
    const local = message.local;
    const failed = message.status === 'failed';
    const sender = mine ? (message.sentBy?.name ?? null) : null;
    const hasText = message.body !== null && message.body !== '';

    return (
        <li
            data-testid={`wa-message-${message.ulid}`}
            data-status={message.status}
            data-direction={message.direction}
            className={cn(
                'flex flex-col',
                mine ? 'items-end' : 'items-start',
                startsGroup ? 'mt-3 first:mt-0' : 'mt-0.5',
            )}
        >
            {startsGroup && sender && (
                <span className="mb-1 max-w-full truncate px-1 text-xs text-muted-foreground">
                    {sender}
                </span>
            )}
            <div
                className={cn(
                    'grid max-w-[85%] min-w-0 gap-1.5 rounded-2xl px-3 py-2 sm:max-w-[75%]',
                    mine
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground',
                    endsGroup && (mine ? 'rounded-ee-md' : 'rounded-es-md'),
                    failed &&
                        'border border-destructive/60 bg-destructive/10 text-foreground',
                    message.status === 'pending' && 'opacity-80',
                )}
            >
                {message.type === 'image' ? (
                    <StoredImage
                        message={message}
                        onOpen={onOpenImage}
                        onLoad={onImageLoad}
                        onError={onImageError}
                    />
                ) : message.type !== 'text' || message.media !== null ? (
                    <UnstoredMedia message={message} />
                ) : null}
                {hasText && <MessageBody text={message.body as string} />}
                {!hasText && message.type === 'text' && (
                    <p className="text-sm italic opacity-80">
                        {t('whatsapp.message.empty')}
                    </p>
                )}
            </div>

            {failed && (
                <div
                    role="alert"
                    className="mt-1 flex flex-wrap items-center gap-1 text-xs text-destructive-foreground"
                >
                    <span data-testid={`wa-message-failure-${message.ulid}`}>
                        {local
                            ? t(FAILURE_KEY[local.failure ?? 'unknown'])
                            : message.error
                              ? t('whatsapp.message.not_delivered_reason', {
                                    reason: message.error,
                                })
                              : t('whatsapp.message.not_delivered')}
                        {local?.retryAfter
                            ? ` ${t('whatsapp.message.retry_in', {
                                  wait: waitLabel(local.retryAfter, locale),
                              })}`
                            : ''}
                    </span>
                    {local && !isFinalSendFailure(local.failure) && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            data-testid={`wa-message-retry-${local.clientMsgId}`}
                            onClick={() => onRetry(local.clientMsgId)}
                        >
                            <RotateCw aria-hidden />
                            {t('whatsapp.message.retry')}
                        </Button>
                    )}
                    {local && (
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="h-7 px-2 text-xs"
                            data-testid={`wa-message-discard-${local.clientMsgId}`}
                            onClick={() => onDiscard(local.clientMsgId)}
                        >
                            <Trash2 aria-hidden />
                            {t('whatsapp.message.discard')}
                        </Button>
                    )}
                </div>
            )}

            {endsGroup && !(failed && local) && (
                <span className="mt-1 flex items-center gap-1 px-1 text-xs text-muted-foreground">
                    <time
                        dateTime={message.createdAt}
                        title={
                            fullDateTime(message.createdAt, locale) ?? undefined
                        }
                        className="tabular-nums"
                    >
                        {clockTime(message.createdAt, locale)}
                    </time>
                    {mine && (
                        <StatusTicks
                            status={message.status}
                            testId={`wa-message-status-${message.ulid}`}
                        />
                    )}
                </span>
            )}
        </li>
    );
}
