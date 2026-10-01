import { router, usePage } from '@inertiajs/react';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Composer } from '@/components/inbox/composer';
import { ConversationHeader } from '@/components/inbox/conversation-header';
import { DetailsSheet } from '@/components/inbox/details-sheet';
import { EndChatDialog } from '@/components/inbox/end-chat-dialog';
import { buildTranscript } from '@/components/inbox/format';
import { MessageList } from '@/components/inbox/message-list';
import { TransferDialog } from '@/components/inbox/transfer-dialog';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { useClipboard } from '@/hooks/use-clipboard';
import { useTrans } from '@/hooks/use-trans';
import type { ConversationStaff, MessageData } from '@/lib/chat/types';
import { staffRoutes } from '@/lib/chat-api/staff';
import {
    useInbox,
    useStaffRealtimeContext,
} from '@/lib/realtime/staff/context';
import { selectOpenQueueCount } from '@/lib/realtime/staff/store';
import {
    ConversationChannelBindings,
    useConversation,
} from '@/lib/realtime/staff/use-conversation';
import type { CategoryData } from '@/types/widgets';

/** Reasons the composer is replaced by a sentence (the conversation is not writable). */
function disabledReason(
    conversation: ConversationStaff,
    t: (key: string) => string,
): string | null {
    return conversation.status === 'active'
        ? null
        : t(`inbox.composer.disabled.${conversation.status}`);
}

/**
 * The open conversation: header, status banner, transcript, composer, and the dialogs behind the header buttons. All state lives
 * in `useConversation` (messages, send pipeline, receipts, typing, catch-up); the Echo bindings only mount when a websocket exists.
 */
export function ConversationView({
    conversation: initialConversation,
    messages: initialMessages,
    categories,
}: {
    conversation: ConversationStaff;
    messages: MessageData[];
    categories: CategoryData[];
}) {
    const { t, locale } = useTrans();
    const { auth } = usePage().props;
    const { controller, sockets, viewer } = useStaffRealtimeContext();
    const [, copy] = useClipboard();
    const roster = useInbox((state) => state.roster);
    const waiting = useInbox(selectOpenQueueCount);
    const [details, setDetails] = useState(false);
    const [transferring, setTransferring] = useState(false);
    const [ending, setEnding] = useState(false);
    const [claiming, setClaiming] = useState(false);
    const user = auth.user;

    const chat = useConversation({
        conversation: initialConversation,
        messages: initialMessages,
        me: {
            id: viewer.id,
            name: user?.name ?? '',
            avatarUrl: user?.avatar ?? null,
        },
    });
    const { conversation } = chat;
    const offline = conversation.type === 'offline';
    const active = conversation.status === 'active';
    const visitorName =
        conversation.visitor.name ?? t('inbox.visitor.anonymous');
    const monitoring =
        viewer.isAdmin &&
        conversation.assignedAgent !== null &&
        conversation.assignedAgent.id !== viewer.id;

    const copyTranscript = async (): Promise<void> => {
        const ok = await copy(
            buildTranscript(chat.messages, {
                locale,
                visitorName,
                agentName: user?.name ?? '',
                attachmentLabel: t('inbox.message.image_alt'),
            }),
        );

        if (ok) {
            toast.success(t('inbox.transcript.copied'));
        } else {
            toast.error(t('inbox.transcript.failed'));
        }
    };

    const claim = async (): Promise<void> => {
        setClaiming(true);

        try {
            await controller.claim(conversation.ulid);
        } finally {
            setClaiming(false);
        }
    };

    const endAction: 'end' | 'close' | null = !active
        ? null
        : offline
          ? 'close'
          : 'end';

    return (
        <section
            data-testid="conversation-view"
            data-status={conversation.status}
            aria-label={t('inbox.conversation.label', { name: visitorName })}
            className="flex h-full min-h-0 flex-col bg-background"
        >
            {sockets && (
                <ConversationChannelBindings
                    ulid={conversation.ulid}
                    bridge={chat.bridge}
                />
            )}

            <ConversationHeader
                conversation={conversation}
                waiting={waiting}
                canTransfer={active && !offline}
                endAction={endAction}
                onDetails={() => setDetails(true)}
                onCopy={() => void copyTranscript()}
                onTransfer={() => setTransferring(true)}
                onEnd={() => setEnding(true)}
            />

            {conversation.status === 'queued' && viewer.isAgent && (
                <div
                    data-testid="conversation-claim"
                    className="flex flex-wrap items-center justify-between gap-2 border-b bg-accent/50 px-4 py-2.5 text-sm"
                >
                    <span>
                        {offline
                            ? t('inbox.claim.ticket_prompt')
                            : t('inbox.claim.chat_prompt')}
                    </span>
                    <Button
                        type="button"
                        size="sm"
                        disabled={claiming}
                        data-testid="conversation-claim-button"
                        onClick={() => void claim()}
                    >
                        {claiming ? <Busy /> : <Check aria-hidden />}
                        {offline ? t('inbox.claim.ticket') : t('inbox.accept')}
                    </Button>
                </div>
            )}

            {monitoring && (
                <p
                    data-testid="conversation-monitoring"
                    className="border-b bg-muted/60 px-4 py-2 text-xs text-muted-foreground"
                >
                    {t('inbox.conversation.monitoring', {
                        name: conversation.assignedAgent?.name ?? '',
                    })}
                </p>
            )}

            <MessageList
                messages={chat.messages}
                typing={chat.typing}
                visitorName={visitorName}
                label={t('inbox.log.label', { name: visitorName })}
                onRetry={chat.retry}
                onDiscard={chat.discard}
            />

            <Composer
                conversation={conversation.ulid}
                disabledReason={disabledReason(conversation, t)}
                emailNotice={
                    offline && conversation.visitor.email
                        ? t('inbox.composer.email_notice', {
                              email: conversation.visitor.email,
                          })
                        : null
                }
                onSend={chat.send}
                onTyping={chat.notifyTyping}
            />

            <DetailsSheet
                open={details}
                onOpenChange={setDetails}
                conversation={conversation}
            />
            <EndChatDialog
                open={ending}
                mode={offline ? 'close' : 'end'}
                onOpenChange={setEnding}
                onConfirm={async () =>
                    (offline ? await chat.close() : await chat.end()) !== null
                }
            />
            <TransferDialog
                open={transferring}
                onOpenChange={setTransferring}
                conversation={conversation}
                roster={roster}
                categories={categories}
                viewerId={viewer.id}
                onTransfer={async (target) => {
                    const next = await chat.transfer(target);

                    if (next && !viewer.isAdmin) {
                        // It left this agent's hands: back to the list.
                        router.visit(staffRoutes.pages.inbox());
                    }

                    return next !== null;
                }}
            />
        </section>
    );
}
