import { MessagesSquare, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ChatRow } from '@/components/inbox/chat-row';
import { useNow } from '@/components/inbox/use-now';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import type { ConversationStaff } from '@/lib/chat/types';
import { cn } from '@/lib/utils';

export type ChatFilter = 'all' | 'unread' | 'active' | 'finished';

const FILTERS: ChatFilter[] = ['all', 'unread', 'active', 'finished'];

/** Does this chat match the search box (visitor name, e-mail, ticket number, last message, category)? */
export function matchesSearch(
    conversation: ConversationStaff,
    query: string,
): boolean {
    const needle = query.trim().toLowerCase();

    if (needle === '') {
        return true;
    }

    return [
        conversation.visitor.name,
        conversation.visitor.email,
        conversation.ticketNo,
        conversation.lastMessagePreview,
        conversation.category?.label,
    ].some((field) => field?.toLowerCase().includes(needle));
}

export function matchesFilter(
    conversation: ConversationStaff,
    filter: ChatFilter,
): boolean {
    switch (filter) {
        case 'unread':
            return conversation.unseenByAgent > 0;
        case 'active':
            return conversation.status === 'active';
        case 'finished':
            return (
                conversation.status === 'ended' ||
                conversation.status === 'closed'
            );
        default:
            return true;
    }
}

/** "My chats": search, a filter and the rows, already sorted by last activity. */
export function ChatList({
    chats,
    selected,
    viewerId,
}: {
    chats: ConversationStaff[];
    selected: string | null;
    viewerId: number;
}) {
    const { t } = useTrans();
    const now = useNow();
    const [query, setQuery] = useState('');
    const [filter, setFilter] = useState<ChatFilter>('all');

    const visible = useMemo(
        () =>
            chats.filter(
                (chat) =>
                    matchesFilter(chat, filter) && matchesSearch(chat, query),
            ),
        [chats, filter, query],
    );

    return (
        <section
            data-testid="inbox-mine"
            aria-labelledby="inbox-mine-title"
            className="grid grid-cols-1 gap-2 px-3 pb-3"
        >
            <header className="px-1 pt-3">
                <h2
                    id="inbox-mine-title"
                    className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                    <MessagesSquare className="size-3.5" aria-hidden />
                    {t('inbox.mine.title')}
                    <span className="font-normal tabular-nums">
                        {chats.length}
                    </span>
                </h2>
            </header>

            {chats.length > 0 && (
                <div className="grid gap-2">
                    <div className="relative">
                        <Search
                            className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                            aria-hidden
                        />
                        <Input
                            type="search"
                            value={query}
                            onChange={(event) => setQuery(event.target.value)}
                            placeholder={t('inbox.mine.search')}
                            aria-label={t('inbox.mine.search')}
                            data-testid="inbox-search"
                            className="h-9 ps-9"
                        />
                    </div>
                    <div
                        role="group"
                        aria-label={t('inbox.mine.filter')}
                        className="flex flex-wrap gap-1"
                    >
                        {FILTERS.map((option) => (
                            <button
                                key={option}
                                type="button"
                                data-testid={`inbox-filter-${option}`}
                                aria-pressed={filter === option}
                                onClick={() => setFilter(option)}
                                className={cn(
                                    'rounded-full border px-2.5 py-1 text-xs font-medium transition-colors duration-150 outline-none',
                                    'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                    filter === option
                                        ? 'border-primary bg-primary text-primary-foreground'
                                        : 'border-input bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
                                )}
                            >
                                {t(`inbox.filter.${option}`)}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            {chats.length === 0 ? (
                <Empty
                    data-testid="inbox-mine-empty"
                    className="rounded-xl border p-6 md:p-6"
                >
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <MessagesSquare aria-hidden />
                        </EmptyMedia>
                        <EmptyTitle className="text-base">
                            {t('inbox.mine.empty_title')}
                        </EmptyTitle>
                        <EmptyDescription>
                            {t('inbox.mine.empty_body')}
                        </EmptyDescription>
                    </EmptyHeader>
                </Empty>
            ) : visible.length === 0 ? (
                <p
                    data-testid="inbox-mine-no-match"
                    className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
                >
                    {t('inbox.mine.no_match')}
                </p>
            ) : (
                <ul className="-mx-1 grid min-w-0 grid-cols-1 gap-0.5">
                    {visible.map((chat) => (
                        <ChatRow
                            key={chat.ulid}
                            conversation={chat}
                            selected={chat.ulid === selected}
                            nowMs={now}
                            viewerId={viewerId}
                        />
                    ))}
                </ul>
            )}
        </section>
    );
}
