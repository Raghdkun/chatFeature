import { Head } from '@inertiajs/react';
import { WaInboxLayout } from '@/components/whatsapp/inbox-layout';
import { EmptyConversation } from '@/components/whatsapp/inbox-shell';
import { useTrans } from '@/hooks/use-trans';

/**
 * `/whatsapp` (admin only): the list is drawn by the layout (which receives the page props: the first page of chats and the sessions);
 * this page is the "pick a chat" pane.
 */
export default function WhatsAppIndex() {
    const { t } = useTrans();

    return (
        <>
            <Head title={t('whatsapp.inbox.title')} />
            <EmptyConversation />
        </>
    );
}

WhatsAppIndex.layout = WaInboxLayout;
