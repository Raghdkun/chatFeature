import {
    AlertCircle,
    Check,
    CheckCheck,
    Clock,
    RotateCw,
    Trash2,
} from 'lucide-react';
import {
    clockTime,
    fullDateTime,
    type ListEntry,
} from '@/components/inbox/format';
import { MessageBody } from '@/components/inbox/message-body';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import type { AttachmentData, LocalMessage } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

type MessageEntry = Extract<ListEntry, { kind: 'message' }>;

/** "Sent" / "Delivered" / "Seen" as ticks (and words for assistive tech). Visitors' messages carry no ticks: they are the agent's receipts. */
function Ticks({ message }: { message: LocalMessage }) {
    const { t } = useTrans();
    const label = t(`inbox.message.status.${message.status}`);

    return (
        <span
            data-testid={`message-status-${message.ulid ?? message.clientMsgId}`}
            className={cn(
                'inline-flex items-center',
                message.status === 'seen' && 'text-primary',
                message.status === 'failed' && 'text-destructive-foreground',
            )}
        >
            {message.status === 'sending' ? (
                <Clock className="size-3.5" aria-hidden />
            ) : message.status === 'failed' ? (
                <AlertCircle className="size-3.5" aria-hidden />
            ) : message.status === 'sent' ? (
                <Check className="size-3.5" aria-hidden />
            ) : (
                <CheckCheck className="size-3.5" aria-hidden />
            )}
            <span className="sr-only">{label}</span>
        </span>
    );
}

function Attachments({
    attachments,
    onOpen,
    onLoad,
}: {
    attachments: AttachmentData[];
    onOpen: (attachment: AttachmentData) => void;
    onLoad: () => void;
}) {
    const { t } = useTrans();

    return (
        <div className="grid gap-1.5">
            {attachments.map((attachment) => (
                <button
                    key={attachment.ulid}
                    type="button"
                    data-testid={`attachment-${attachment.ulid}`}
                    onClick={() => onOpen(attachment)}
                    aria-label={t('inbox.message.open_image')}
                    className="block overflow-hidden rounded-lg outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                    <img
                        src={attachment.thumbUrl ?? attachment.url}
                        alt={t('inbox.message.image_alt')}
                        width={attachment.width ?? undefined}
                        height={attachment.height ?? undefined}
                        loading="lazy"
                        onLoad={onLoad}
                        style={
                            attachment.width && attachment.height
                                ? {
                                      aspectRatio: `${attachment.width} / ${attachment.height}`,
                                  }
                                : undefined
                        }
                        className="max-h-60 w-auto max-w-full rounded-lg bg-muted object-cover"
                    />
                </button>
            ))}
        </div>
    );
}

/** One row of the message list: a system line, or a bubble (visitor at the start, agent at the end) with its time and ticks. */
export function MessageBubble({
    entry,
    onRetry,
    onDiscard,
    onOpenImage,
    onImageLoad,
}: {
    entry: MessageEntry;
    onRetry: (clientMsgId: string) => void;
    onDiscard: (clientMsgId: string) => void;
    onOpenImage: (attachment: AttachmentData) => void;
    onImageLoad: () => void;
}) {
    const { t, locale } = useTrans();
    const { message, startsGroup, endsGroup } = entry;
    const id = message.ulid ?? message.clientMsgId ?? `seq-${message.seq}`;

    if (message.sender.type === 'system') {
        return (
            <li
                data-testid={`message-${id}`}
                data-status={message.status}
                className="flex justify-center py-1"
            >
                <span className="rounded-full bg-muted px-3 py-1 text-center text-xs text-muted-foreground">
                    {message.body}
                </span>
            </li>
        );
    }

    const mine = message.sender.type === 'agent';
    const failed = message.status === 'failed';

    return (
        <li
            data-testid={`message-${id}`}
            data-status={message.status}
            data-sender={message.sender.type}
            className={cn(
                'flex flex-col',
                mine ? 'items-end' : 'items-start',
                startsGroup ? 'mt-3 first:mt-0' : 'mt-0.5',
            )}
        >
            {startsGroup && message.sender.name && (
                <span className="mb-1 px-1 text-xs text-muted-foreground">
                    {message.sender.name}
                </span>
            )}
            <div
                className={cn(
                    'grid max-w-[85%] gap-1.5 rounded-2xl px-3 py-2 sm:max-w-[75%]',
                    mine
                        ? 'bg-primary text-primary-foreground'
                        : 'bg-muted text-foreground',
                    endsGroup && (mine ? 'rounded-ee-md' : 'rounded-es-md'),
                    failed &&
                        'border border-destructive/60 bg-destructive/10 text-foreground',
                    message.status === 'sending' && 'opacity-80',
                )}
            >
                {message.attachments.length > 0 && (
                    <Attachments
                        attachments={message.attachments}
                        onOpen={onOpenImage}
                        onLoad={onImageLoad}
                    />
                )}
                {message.body && <MessageBody text={message.body} />}
            </div>

            {failed && message.clientMsgId && (
                <div
                    role="alert"
                    className="mt-1 flex flex-wrap items-center gap-1 text-xs text-destructive-foreground"
                >
                    <span>{t('inbox.message.not_sent')}</span>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        data-testid={`message-retry-${message.clientMsgId}`}
                        onClick={() => onRetry(message.clientMsgId as string)}
                    >
                        <RotateCw aria-hidden />
                        {t('inbox.message.retry')}
                    </Button>
                    <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs"
                        data-testid={`message-discard-${message.clientMsgId}`}
                        onClick={() => onDiscard(message.clientMsgId as string)}
                    >
                        <Trash2 aria-hidden />
                        {t('inbox.message.discard')}
                    </Button>
                </div>
            )}

            {endsGroup && !failed && (
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
                    {mine && <Ticks message={message} />}
                </span>
            )}
        </li>
    );
}
