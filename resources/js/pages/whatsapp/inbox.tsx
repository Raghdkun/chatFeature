import { Head, usePage } from '@inertiajs/react';
import { ChatView } from '@/components/whatsapp/chat-view';
import { chatTitle } from '@/components/whatsapp/format';
import {
    WaInboxLayout,
    WhatsAppForbidden,
} from '@/components/whatsapp/inbox-layout';
import {
    EmptyConversation,
    WaInboxShell,
} from '@/components/whatsapp/inbox-shell';
import { useReplyOnlyToInbound } from '@/components/whatsapp/use-reply-policy';
import { WaReady } from '@/components/whatsapp/wa-ready';
import { useTrans } from '@/hooks/use-trans';
import type { WaInboxPageProps } from '@/types/whatsapp';

/**
 * `/whatsapp` and `/whatsapp/chats/{chat}` (administrators only). One page: the list column and, when `selected` is set, the open chat.
 * Picking a chat reloads only `selected` (the same component stays mounted), so the filters, the search text and the pages already loaded
 * survive. An agent is answered 403 by the server; the check here only keeps a stale tab from drawing any WhatsApp data.
 */
export default function WhatsAppInbox({
    sessions,
    chats,
    meta,
    widgets,
    categories,
    whatsappEnabled,
    selected,
}: WaInboxPageProps) {
    const { t } = useTrans();
    const { auth } = usePage().props;
    const isAdmin = auth.user?.is_admin === true;
    // Not in the page props: asked once, when a chat is open (an agent's stale tab never asks).
    const replyOnlyToInbound = useReplyOnlyToInbound(
        isAdmin && selected !== null,
    );

    if (!isAdmin) {
        return <WhatsAppForbidden />;
    }

    return (
        <>
            <Head
                title={
                    selected
                        ? t('whatsapp.chat.title', {
                              name: chatTitle(
                                  selected.detail.chat,
                                  t('whatsapp.chat.unknown'),
                              ),
                          })
                        : t('whatsapp.inbox.title')
                }
            />
            <WaReady>
                <WaInboxShell
                    chats={chats}
                    cursor={meta.next_cursor}
                    hasMore={meta.next_cursor !== null}
                    sessions={sessions}
                    widgets={widgets}
                    categories={categories}
                    whatsappEnabled={whatsappEnabled}
                    selectedUlid={selected?.detail.chat.ulid ?? null}
                >
                    {selected ? (
                        // Keyed by chat: switching chats starts a clean transcript, composer and reply queue.
                        <ChatView
                            key={selected.detail.chat.ulid}
                            detail={selected.detail}
                            messages={selected.messages}
                            hasOlder={selected.meta.prev_cursor !== null}
                            replyOnlyToInbound={replyOnlyToInbound}
                        />
                    ) : (
                        <EmptyConversation />
                    )}
                </WaInboxShell>
            </WaReady>
        </>
    );
}

WhatsAppInbox.layout = WaInboxLayout;
