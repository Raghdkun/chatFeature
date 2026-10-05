import { Link } from '@inertiajs/react';
import { BadgeCheck } from 'lucide-react';
import { shortAge } from '@/components/inbox/format';
import { VisitorAvatar } from '@/components/inbox/visitor-avatar';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { ConversationStaff } from '@/lib/chat/types';
import { activityMs } from '@/lib/realtime/staff/store';
import { cn } from '@/lib/utils';

/** One conversation in "My chats": who, the last message, how long ago, and the unseen badge. */
export function ChatRow({
    conversation,
    selected,
    nowMs,
    viewerId,
}: {
    conversation: ConversationStaff;
    selected: boolean;
    nowMs: number;
    /** Admins also see other agents' chats: those say whose they are. */
    viewerId: number;
}) {
    const { t, locale } = useTrans();
    const name = conversation.visitor.name ?? t('inbox.visitor.anonymous');
    const unseen = conversation.unseenByAgent;
    const finished =
        conversation.status === 'ended' || conversation.status === 'closed';
    const age = shortAge(
        new Date(activityMs(conversation) || nowMs).toISOString(),
        nowMs,
        locale,
        t,
    );
    const otherAgent =
        conversation.assignedAgent !== null &&
        conversation.assignedAgent.id !== viewerId
            ? conversation.assignedAgent.name
            : null;

    return (
        <li className="min-w-0">
            <Link
                href={staffRoutes.pages.conversation(conversation.ulid)}
                only={['conversation', 'messages']}
                preserveScroll
                preserveState
                data-testid={`chat-row-${conversation.ulid}`}
                data-unseen={unseen > 0 ? 'true' : undefined}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                    'group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 outline-none',
                    'hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selected && 'bg-accent',
                )}
            >
                {/* A finished chat is told apart by a grey avatar: opacity (on the row or the avatar) put the text under 4.5:1. */}
                <span className={cn(finished && !selected && 'grayscale')}>
                    <VisitorAvatar name={conversation.visitor.name} />
                </span>
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                        <span
                            className={cn(
                                'flex min-w-0 items-center gap-1 text-sm',
                                unseen > 0 ? 'font-semibold' : 'font-medium',
                            )}
                        >
                            <span className="truncate">{name}</span>
                            {conversation.visitor.verified && (
                                <BadgeCheck
                                    className="size-3.5 shrink-0 text-primary"
                                    aria-label={t('inbox.visitor.verified')}
                                />
                            )}
                        </span>
                        {age && (
                            <time
                                dateTime={
                                    conversation.lastMessageAt ?? undefined
                                }
                                className="shrink-0 text-xs text-muted-foreground tabular-nums"
                            >
                                {age}
                            </time>
                        )}
                    </span>
                    <span className="mt-0.5 flex items-center justify-between gap-2">
                        <span
                            dir="auto"
                            className={cn(
                                'line-clamp-1 text-sm break-words',
                                unseen > 0
                                    ? 'text-foreground'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {conversation.lastMessagePreview ??
                                t('inbox.chat.no_messages')}
                        </span>
                        {unseen > 0 && (
                            <span
                                data-testid={`chat-unseen-${conversation.ulid}`}
                                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums"
                            >
                                <span aria-hidden>
                                    {unseen > 99 ? '99+' : unseen}
                                </span>
                                <span className="sr-only">
                                    {t('inbox.chat.unseen', { count: unseen })}
                                </span>
                            </span>
                        )}
                    </span>
                    {(otherAgent || finished || conversation.category) && (
                        <span className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                            {conversation.category && (
                                <span>{conversation.category.label}</span>
                            )}
                            {finished && (
                                <span className="rounded bg-muted px-1.5 py-px">
                                    {t(`inbox.status.${conversation.status}`)}
                                </span>
                            )}
                            {otherAgent && (
                                <span className="rounded bg-muted px-1.5 py-px">
                                    {t('inbox.chat.with_agent', {
                                        name: otherAgent,
                                    })}
                                </span>
                            )}
                        </span>
                    )}
                </span>
            </Link>
        </li>
    );
}
