import { MessagesSquare } from 'lucide-react';
import { ChatFilters } from '@/components/whatsapp/chat-filters';
import { ChatRow } from '@/components/whatsapp/chat-row';
import { useNow } from '@/components/inbox/use-now';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import type { useWaChatList } from '@/lib/realtime/whatsapp/use-wa-chat-list';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

/** The chats of the current filters, with the controls that change them. State lives in `useWaChatList` (the shell owns the hook). */
export function ChatList({
    list,
    sessions,
    selected,
}: {
    list: ReturnType<typeof useWaChatList>;
    sessions: Pick<WhatsAppSession, 'ulid' | 'name'>[];
    selected: string | null;
}) {
    const { t } = useTrans();
    const now = useNow();
    const { chats, filters, loading, error, hasMore, searching } = list;
    const filtered =
        searching ||
        filters.status !== 'open' ||
        filters.linked !== 'all' ||
        filters.unreadOnly ||
        filters.session !== '';

    return (
        <section
            data-testid="wa-chat-list"
            aria-labelledby="wa-list-title"
            className="grid grid-cols-1 gap-2 px-3 pb-3"
        >
            <header className="px-1 pt-3">
                <h2
                    id="wa-list-title"
                    className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                    <MessagesSquare className="size-3.5" aria-hidden />
                    {t('whatsapp.list.title')}
                    <span className="font-normal tabular-nums">
                        {chats.length}
                    </span>
                </h2>
            </header>

            <ChatFilters
                filters={filters}
                sessions={sessions}
                onChange={(patch) =>
                    list.setFilters((held) => ({ ...held, ...patch }))
                }
            />

            {error && (
                <p
                    role="alert"
                    data-testid="wa-list-error"
                    className="flex flex-wrap items-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm"
                >
                    {t('whatsapp.list.error')}
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        className="bg-background"
                        data-testid="wa-list-retry"
                        onClick={() => void list.reload()}
                    >
                        {t('whatsapp.list.retry')}
                    </Button>
                </p>
            )}

            {chats.length === 0 && !loading ? (
                filtered ? (
                    <p
                        data-testid="wa-list-no-match"
                        className="rounded-lg border border-dashed px-3 py-4 text-center text-sm text-muted-foreground"
                    >
                        {t('whatsapp.list.no_match')}
                    </p>
                ) : (
                    <Empty
                        data-testid="wa-list-empty"
                        className="rounded-xl border p-6 md:p-6"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <MessagesSquare aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle className="text-base">
                                {t('whatsapp.list.empty_title')}
                            </EmptyTitle>
                            <EmptyDescription>
                                {t('whatsapp.list.empty_body')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                )
            ) : (
                <ul
                    aria-busy={loading || undefined}
                    className="-mx-1 grid min-w-0 grid-cols-1 gap-0.5"
                >
                    {chats.map((chat) => (
                        <ChatRow
                            key={chat.ulid}
                            chat={chat}
                            selected={chat.ulid === selected}
                            nowMs={now}
                            showSession={sessions.length > 1}
                        />
                    ))}
                </ul>
            )}

            {loading && chats.length === 0 && (
                <p
                    role="status"
                    className="flex items-center justify-center gap-2 py-4 text-sm text-muted-foreground"
                >
                    <Busy />
                    {t('whatsapp.list.loading')}
                </p>
            )}

            {hasMore && (
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={loading}
                    data-testid="wa-list-more"
                    onClick={() => void list.loadMore()}
                >
                    {loading && <Busy />}
                    {t('whatsapp.list.more')}
                </Button>
            )}
        </section>
    );
}
