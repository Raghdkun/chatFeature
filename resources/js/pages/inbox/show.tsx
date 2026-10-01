import { Head } from '@inertiajs/react';
import { ConversationView } from '@/components/inbox/conversation-view';
import { InboxLayout } from '@/components/inbox/inbox-layout';
import { InboxShell } from '@/components/inbox/inbox-shell';
import { useTrans } from '@/hooks/use-trans';
import type { InboxShowProps } from '@/types/chat-staff';

export default function InboxShow({
    conversation,
    messages,
    ...shell
}: InboxShowProps) {
    const { t } = useTrans();
    const name = conversation.visitor.name ?? t('inbox.visitor.anonymous');

    return (
        <>
            <Head title={t('inbox.conversation.title', { name })} />
            <InboxShell {...shell} selectedUlid={conversation.ulid}>
                {/* Keyed by conversation: switching chats starts a clean message list, composer and typing state. */}
                <ConversationView
                    key={conversation.ulid}
                    conversation={conversation}
                    messages={messages}
                    categories={shell.categories}
                />
            </InboxShell>
        </>
    );
}

InboxShow.layout = InboxLayout;
