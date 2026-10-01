/**
 * Compile-time drift guard for the embed panel (`npm run types:check` fails here when a PHP Data class and what the panel reads or
 * sends stop agreeing). Two kinds of check:
 *
 * - `Same<A, B>`: the panel uses the generated type itself (visitor API responses, realtime payloads), or mirrors it exactly.
 * - `Narrower<A, B>`: a hand-written panel type that is a subset of the generated one (a payload the panel only partly reads).
 *
 * The request bodies of the public endpoints have no PHP Data class (they are validated by form requests): they are pinned to the
 * documented snake_case keys of docs/contracts/rest-shapes.md instead.
 */
import type {
    PanelAvailability,
    PanelCategory,
    PanelFeatures,
    PanelTheme,
    PreChatField,
} from '@/embed/config/panel-config';
import type {
    CreateConversationRequest,
    MessagesPage,
    OfflineTicketRequest,
    ReceiptsRequest,
    RatingRequest,
    SendMessageRequest,
    SentMessage,
    VisitorApi,
} from '@/lib/chat-api/visitor';
import type { RealtimeHandlers } from '@/lib/realtime/visitor/connection';
import type { ConversationPublic, MessageData } from '@/lib/chat/types';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Narrower<A, B> = [A] extends [B] ? true : false;
type Result<K extends keyof VisitorApi> = Awaited<ReturnType<VisitorApi[K]>>;
type Keys<T> = keyof T;

export const visitorApiConforms: {
    /* responses are the generated Data types */
    conversation: Same<
        ConversationPublic,
        App.Data.Chat.ConversationPublicData
    >;
    message: Same<MessageData, App.Data.Chat.MessageData>;
    createConversation: Same<
        Result<'createConversation'>,
        App.Data.Chat.ConversationPublicData
    >;
    createOfflineTicket: Same<
        Result<'createOfflineTicket'>,
        App.Data.Chat.ConversationPublicData
    >;
    getConversation: Same<
        Result<'getConversation'>,
        App.Data.Chat.ConversationPublicData | null
    >;
    endConversation: Same<
        Result<'endConversation'>,
        App.Data.Chat.ConversationPublicData
    >;
    attachment: Same<Result<'uploadAttachment'>, App.Data.Chat.AttachmentData>;
    sentMessage: Same<SentMessage['message'], App.Data.Chat.MessageData>;
    messagesPage: Same<MessagesPage['messages'], App.Data.Chat.MessageData[]>;
    session: Same<
        NonNullable<Result<'createSession'>['conversation']>,
        App.Data.Chat.ConversationPublicData
    >;
    /* request bodies: the documented keys, exactly */
    createConversationBody: Same<
        Keys<CreateConversationRequest>,
        'category' | 'name' | 'email' | 'phone' | 'message' | 'consent'
    >;
    offlineTicketBody: Same<
        Keys<OfflineTicketRequest>,
        'name' | 'email' | 'message' | 'category' | 'missed_conversation'
    >;
    sendMessageBody: Same<
        Keys<SendMessageRequest>,
        'client_msg_id' | 'body' | 'attachments'
    >;
    receiptsBody: Same<Keys<ReceiptsRequest>, 'delivered_upto' | 'seen_upto'>;
    ratingBody: Same<Keys<RatingRequest>, 'score' | 'comment'>;
} = {
    conversation: true,
    message: true,
    createConversation: true,
    createOfflineTicket: true,
    getConversation: true,
    endConversation: true,
    attachment: true,
    sentMessage: true,
    messagesPage: true,
    session: true,
    createConversationBody: true,
    offlineTicketBody: true,
    sendMessageBody: true,
    receiptsBody: true,
    ratingBody: true,
};

type Handlers = RealtimeHandlers;

/** What the realtime layer hands to the panel is exactly what the payload classes declare. */
export const realtimePayloadsConform: {
    claimedAgent: Same<
        Parameters<Handlers['onClaimed']>[0]['agent'],
        App.Data.Chat.Events.ChatClaimedPayload['agent']
    >;
    claimedAt: Same<
        Parameters<Handlers['onClaimed']>[0]['claimedAt'],
        App.Data.Chat.Events.ChatClaimedPayload['claimedAt']
    >;
    message: Same<
        Parameters<Handlers['onMessage']>[0],
        App.Data.Chat.Events.MessageCreatedPayload['message']
    >;
    seenBy: Same<
        Parameters<Handlers['onSeen']>[0]['by'],
        App.Data.Chat.Events.MessageSeenPayload['by']
    >;
    seenUpTo: Same<
        Parameters<Handlers['onSeen']>[0]['upToSeq'],
        App.Data.Chat.Events.MessageSeenPayload['upToSeq']
    >;
    endedBy: Same<
        Parameters<Handlers['onEnded']>[0]['endedBy'],
        App.Data.Chat.Events.ConversationEndedPayload['endedBy']
    >;
    ratingRequested: Same<
        Parameters<Handlers['onEnded']>[0]['ratingRequested'],
        App.Data.Chat.Events.ConversationEndedPayload['ratingRequested']
    >;
    closedReason: Same<
        Parameters<Handlers['onClosed']>[0]['reason'],
        App.Data.Chat.Events.ConversationClosedPayload['reason']
    >;
} = {
    claimedAgent: true,
    claimedAt: true,
    message: true,
    seenBy: true,
    seenUpTo: true,
    endedBy: true,
    ratingRequested: true,
    closedReason: true,
};

/** The boot config the panel validates (`config/panel-config.ts`) mirrors the resolved config's generated types. */
export const panelConfigConforms: {
    availability: Same<
        PanelAvailability,
        App.Domain.Widgets.Data.AvailabilityData
    >;
    features: Same<PanelFeatures, App.Domain.Widgets.Data.FeaturesConfigData>;
    preChatField: Same<PreChatField, App.Domain.Widgets.Data.PreChatFieldData>;
    category: Same<PanelCategory, App.Domain.Widgets.Data.BootCategoryData>;
    theme: Narrower<
        PanelTheme,
        Pick<App.Domain.Widgets.Data.ThemeConfigData, keyof PanelTheme>
    >;
    themeKeys: Narrower<
        Keys<PanelTheme>,
        Keys<App.Domain.Widgets.Data.ThemeConfigData>
    >;
} = {
    availability: true,
    features: true,
    preChatField: true,
    category: true,
    theme: true,
    themeKeys: true,
};
