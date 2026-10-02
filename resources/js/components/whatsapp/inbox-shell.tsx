import { Link } from '@inertiajs/react';
import { MessagesSquare, Settings } from 'lucide-react';
import { useLayoutEffect, type ReactNode } from 'react';
import { ConnectionBanner } from '@/components/inbox/connection-banner';
import { ChatList } from '@/components/whatsapp/chat-list';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { useTrans } from '@/hooks/use-trans';
import { useWaRealtime, useWaState } from '@/lib/realtime/whatsapp/context';
import { useWaChatList } from '@/lib/realtime/whatsapp/use-wa-chat-list';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaInboxShellProps } from '@/types/whatsapp';
import { cn } from '@/lib/utils';

/** The "pick a chat" pane of `/whatsapp` (wide screens; on a phone the list is the whole screen). */
export function EmptyConversation() {
    const { t } = useTrans();

    return (
        <Empty data-testid="wa-empty-conversation" className="border-0">
            <EmptyHeader>
                <EmptyMedia variant="icon">
                    <MessagesSquare aria-hidden />
                </EmptyMedia>
                <EmptyTitle>
                    {t('whatsapp.conversation.empty_title')}
                </EmptyTitle>
                <EmptyDescription>
                    {t('whatsapp.conversation.empty_body')}
                </EmptyDescription>
            </EmptyHeader>
        </Empty>
    );
}

/**
 * The two-pane WhatsApp inbox: the list column (search, filters, chats) and the conversation. From `md` up both are visible; below it the
 * list and an open chat are separate screens (`/whatsapp` and `/whatsapp/{chat}` with a back arrow). It is mounted by the page layout, so
 * the filters, the search text and the pages already loaded survive a click on a chat. The sessions are seeded into the live store: the
 * composer reads their status from there, and `wa.session.status` keeps it current.
 */
export function WaInboxShell({
    chats,
    hasMore,
    sessions,
    selectedUlid,
    children,
}: WaInboxShellProps & {
    selectedUlid: string | null;
    /** The conversation pane (`/whatsapp/{chat}`); absent on `/whatsapp`. */
    children?: ReactNode;
}) {
    const { t } = useTrans();
    const { store } = useWaRealtime();
    const connection = useWaState((state) => state.connection);
    const list = useWaChatList({
        initialChats: chats,
        initialHasMore: hasMore,
    });
    const Title = selectedUlid ? 'h2' : 'h1';

    useLayoutEffect(() => {
        store.dispatch({
            type: 'sessionsLoaded',
            sessions,
            since: store.getState().clock,
        });
    }, [store, sessions]);

    return (
        <div
            data-testid="wa-inbox"
            className="flex h-[calc(100dvh-4rem)] min-h-0 overflow-hidden md:h-[calc(100dvh-5rem)] md:rounded-xl md:border md:bg-card"
        >
            {/* A region, not an `aside`: it sits inside the page's own <main>, where a complementary landmark is not allowed. */}
            <section
                aria-label={t('whatsapp.list.label')}
                className={cn(
                    'min-h-0 w-full shrink-0 flex-col border-e bg-background md:flex md:w-80 lg:w-[22rem]',
                    selectedUlid ? 'hidden' : 'flex',
                )}
            >
                <div className="flex items-center gap-2 border-b px-3 py-2.5">
                    <Title className="flex-1 text-base font-semibold tracking-tight">
                        {t('whatsapp.inbox.title')}
                    </Title>
                    <Button
                        asChild
                        variant="ghost"
                        size="icon"
                        className="size-8"
                    >
                        <Link
                            href={waRoutes.pages.settings()}
                            data-testid="wa-open-settings"
                            aria-label={t('whatsapp.inbox.settings')}
                            title={t('whatsapp.inbox.settings')}
                        >
                            <Settings aria-hidden />
                        </Link>
                    </Button>
                </div>

                <ConnectionBanner status={connection} />

                <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
                    <ChatList
                        list={list}
                        sessions={sessions}
                        selected={selectedUlid}
                    />
                </div>
            </section>

            <div
                className={cn(
                    'min-w-0 flex-1 flex-col',
                    selectedUlid ? 'flex' : 'hidden md:flex',
                )}
            >
                {children ?? <EmptyConversation />}
            </div>
        </div>
    );
}
