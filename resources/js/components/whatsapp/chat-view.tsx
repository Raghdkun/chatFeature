import { router } from '@inertiajs/react';
import { useState } from 'react';
import { toast } from 'sonner';
import { ConnectionBanner } from '@/components/inbox/connection-banner';
import { WaComposer } from '@/components/whatsapp/composer';
import { ChatDetailsSheet } from '@/components/whatsapp/details-sheet';
import { ChatHeader } from '@/components/whatsapp/chat-header';
import { chatTitle } from '@/components/whatsapp/format';
import { Transcript } from '@/components/whatsapp/transcript';
import { useTrans } from '@/hooks/use-trans';
import { useWaChat } from '@/lib/realtime/whatsapp/use-wa-chat';
import { describeWaError } from '@/lib/whatsapp-api/client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaChatDetail, WaMessage } from '@/lib/whatsapp/types';

/**
 * The open chat: header, transcript, reply box and the details sheet. All state lives in `useWaChat` (the live copy, the transcript, the
 * reply pipeline, catch-up, mark-read); this component only draws it and runs the archive and delete actions.
 */
export function ChatView({
    detail,
    messages: initialMessages,
    hasOlder,
    replyOnlyToInbound,
}: {
    detail: WaChatDetail;
    messages: WaMessage[];
    /** There is older history than `messages` starts with. */
    hasOlder: boolean;
    /** `whatsapp.reply_only_to_inbound`, when the page knows it. */
    replyOnlyToInbound?: boolean;
}) {
    const { t, locale } = useTrans();
    const [details, setDetails] = useState(false);
    const [archiving, setArchiving] = useState(false);
    const chat = useWaChat({
        chat: detail.chat,
        messages: initialMessages,
        hasOlder,
        replyOnlyToInbound,
    });
    const title = chatTitle(chat.chat, t('whatsapp.chat.unknown'));
    const archived = chat.chat.status === 'archived';

    const toggleArchive = async (): Promise<void> => {
        setArchiving(true);

        try {
            await chat.setArchived(!archived);
            toast.success(
                t(
                    archived
                        ? 'whatsapp.toast.unarchived'
                        : 'whatsapp.toast.archived',
                ),
            );
        } catch (error) {
            toast.error(describeWaError(error, t, locale));
        } finally {
            setArchiving(false);
        }
    };

    return (
        <section
            data-testid="wa-chat-view"
            data-status={chat.chat.status}
            aria-label={t('whatsapp.chat.label', { name: title })}
            className="flex h-full min-h-0 flex-col bg-background"
        >
            <ChatHeader
                chat={chat.chat}
                archiving={archiving}
                onDetails={() => setDetails(true)}
                onToggleArchive={() => void toggleArchive()}
            />

            <ConnectionBanner status={chat.connection} variant="conversation" />

            {archived && (
                <p
                    data-testid="wa-chat-archived"
                    role="status"
                    className="border-b bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
                >
                    {t('whatsapp.chat.archived_note')}
                </p>
            )}

            <Transcript
                messages={chat.messages}
                label={t('whatsapp.transcript.label', { name: title })}
                hasOlder={chat.hasOlder}
                loadingOlder={chat.loadingOlder}
                onLoadOlder={() => void chat.loadOlder()}
                onRetry={(clientMsgId) => void chat.retry(clientMsgId)}
                onDiscard={chat.discard}
                onImageError={() => void chat.refreshMediaUrls()}
            />

            <WaComposer
                chat={chat.chat.ulid}
                block={chat.block}
                pausedUntil={chat.pausedUntil}
                onSend={chat.send}
            />

            <ChatDetailsSheet
                open={details}
                onOpenChange={setDetails}
                detail={detail}
                chat={chat.chat}
                onDelete={async () => {
                    await chat.deleteChat();
                    toast.success(t('whatsapp.toast.chat_deleted'));
                    router.visit(waRoutes.pages.inbox());
                }}
            />
        </section>
    );
}
