import { Head } from '@inertiajs/react';
import { ChatView } from '@/components/whatsapp/chat-view';
import { chatTitle } from '@/components/whatsapp/format';
import { WaInboxLayout } from '@/components/whatsapp/inbox-layout';
import { useTrans } from '@/hooks/use-trans';
import type { WaInboxShowProps } from '@/types/whatsapp';

/** `/whatsapp/{chat}` (admin only): one chat's conversation pane; the list column is the layout's. */
export default function WhatsAppShow({
    detail,
    messages,
    hasOlder,
    replyOnlyToInbound,
}: WaInboxShowProps) {
    const { t } = useTrans();
    const name = chatTitle(detail.chat, t('whatsapp.chat.unknown'));

    return (
        <>
            <Head title={t('whatsapp.chat.title', { name })} />
            {/* Keyed by chat: switching chats starts a clean transcript, composer and reply queue. */}
            <ChatView
                key={detail.chat.ulid}
                detail={detail}
                messages={messages}
                hasOlder={hasOlder}
                replyOnlyToInbound={replyOnlyToInbound}
            />
        </>
    );
}

WhatsAppShow.layout = WaInboxLayout;
