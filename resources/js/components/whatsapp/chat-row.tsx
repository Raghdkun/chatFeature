import { Link } from '@inertiajs/react';
import { Archive, Link2, Users } from 'lucide-react';
import { shortAge } from '@/components/inbox/format';
import { ChatAvatar } from '@/components/whatsapp/chat-avatar';
import { chatTitle } from '@/components/whatsapp/format';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaChat } from '@/lib/whatsapp/types';
import { cn } from '@/lib/utils';

/** One chat in the list: who, the last message, how long ago, the unread badge and what links it to the website. */
export function ChatRow({
    chat,
    selected,
    nowMs,
    showSession,
}: {
    chat: WaChat;
    selected: boolean;
    nowMs: number;
    /** More than one session exists: say which one the chat is on. */
    showSession: boolean;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const title = chatTitle(chat, t('whatsapp.chat.unknown'));
    const unread = chat.unreadByAdmin;
    const age = shortAge(
        chat.lastMessageAt ?? chat.createdAt,
        nowMs,
        locale,
        t,
    );
    const archived = chat.status === 'archived';
    const link = [chat.widget?.name, chat.category?.label].filter(Boolean);

    return (
        <li className="min-w-0">
            <Link
                href={waRoutes.pages.chat(chat.ulid)}
                only={['detail', 'messages', 'hasOlder']}
                preserveScroll
                preserveState
                data-testid={`wa-chat-row-${chat.ulid}`}
                data-unseen={unread > 0 ? 'true' : undefined}
                aria-current={selected ? 'page' : undefined}
                className={cn(
                    'group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors duration-150 outline-none',
                    'hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/50',
                    selected && 'bg-accent',
                    archived && !selected && 'opacity-80',
                )}
            >
                <ChatAvatar title={title} />
                <span className="min-w-0 flex-1">
                    <span className="flex items-baseline justify-between gap-2">
                        <span
                            dir="auto"
                            className={cn(
                                'flex min-w-0 items-center gap-1 text-sm',
                                unread > 0 ? 'font-semibold' : 'font-medium',
                            )}
                        >
                            <span className="truncate">{title}</span>
                            {chat.isGroup && (
                                <Users
                                    className="size-3.5 shrink-0 text-muted-foreground"
                                    aria-label={t('whatsapp.chat.group')}
                                />
                            )}
                        </span>
                        {age && (
                            <time
                                dateTime={chat.lastMessageAt ?? chat.createdAt}
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
                                unread > 0
                                    ? 'text-foreground'
                                    : 'text-muted-foreground',
                            )}
                        >
                            {chat.lastMessagePreview ??
                                t('whatsapp.chat.no_messages')}
                        </span>
                        {unread > 0 && (
                            <span
                                data-testid={`wa-chat-unread-${chat.ulid}`}
                                className="inline-flex h-5 min-w-5 shrink-0 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums"
                            >
                                <span aria-hidden>
                                    {unread > 99 ? '99+' : unread}
                                </span>
                                <span className="sr-only">
                                    {plural('whatsapp.chat.unread', unread)}
                                </span>
                            </span>
                        )}
                    </span>
                    <span className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
                        {link.length > 0 ? (
                            <span
                                data-testid={`wa-chat-link-${chat.ulid}`}
                                className="inline-flex max-w-full items-center gap-1 rounded bg-emerald-100 px-1.5 py-px text-emerald-900 dark:bg-emerald-400/15 dark:text-emerald-100"
                            >
                                <Link2
                                    className="size-3 shrink-0"
                                    aria-hidden
                                />
                                <span className="truncate">
                                    {link.join(' · ')}
                                </span>
                            </span>
                        ) : (
                            <span className="rounded bg-muted px-1.5 py-px">
                                {t('whatsapp.chat.unlinked')}
                            </span>
                        )}
                        {showSession && (
                            <span className="rounded bg-muted px-1.5 py-px">
                                {chat.session.name}
                            </span>
                        )}
                        {archived && (
                            <span className="inline-flex items-center gap-1 rounded bg-muted px-1.5 py-px">
                                <Archive className="size-3" aria-hidden />
                                {t('whatsapp.chat.archived')}
                            </span>
                        )}
                    </span>
                </span>
            </Link>
        </li>
    );
}
