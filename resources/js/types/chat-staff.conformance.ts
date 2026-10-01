/**
 * Compile-time drift guard for the agent dashboard: the shapes the UI declares (page props, REST bodies, realtime payloads) must
 * stay identical to the generated PHP Data types (`App.Data.Chat.*`). If a Data class changes without the UI following, or the other
 * way round, `npm run types:check` fails here. Nothing in this file runs.
 */
import type { SendMessageInput } from '@/lib/chat-api/staff';
import type { ChatEventPayloads } from '@/lib/chat/events';
import type * as C from '@/lib/chat/types';
import type * as S from '@/types/chat-staff';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Row<T> = T extends readonly (infer R)[] ? R : never;

export const staffPagesConform: {
    conversation: Same<
        Row<S.InboxShellProps['queue']>,
        App.Data.Chat.ConversationStaffData
    >;
    mine: Same<
        Row<S.InboxShellProps['mine']>,
        App.Data.Chat.ConversationStaffData
    >;
    presence: Same<
        S.InboxShellProps['presence']['status'],
        App.Domain.Chat.Enums.PresenceStatus
    >;
    category: Same<
        Row<S.InboxShellProps['categories']>,
        App.Data.Catalog.CategoryData
    >;
    transcript: Same<
        Row<S.InboxShowProps['messages']>,
        App.Data.Chat.MessageData
    >;
    selected: Same<
        S.InboxShowProps['conversation'],
        App.Data.Chat.ConversationStaffData
    >;
    tickets: Same<
        Row<S.OfflineTicketsPageProps['tickets']>,
        App.Data.Chat.ConversationStaffData
    >;
    history: Same<
        Row<S.HistoryPageProps['conversations']>,
        App.Data.Chat.ConversationStaffData
    >;
    ratings: Same<Row<S.HistoryPageProps['ratings']>, App.Data.Chat.RatingData>;
} = {
    conversation: true,
    mine: true,
    presence: true,
    category: true,
    transcript: true,
    selected: true,
    tickets: true,
    history: true,
    ratings: true,
};

/** The shared short names are the generated types, not copies. */
export const sharedAliasesConform: {
    message: Same<C.MessageData, App.Data.Chat.MessageData>;
    staff: Same<C.ConversationStaff, App.Data.Chat.ConversationStaffData>;
    offer: Same<C.OfferData, App.Data.Chat.OfferData>;
    presenceStatus: Same<
        C.PresenceStatus,
        App.Domain.Chat.Enums.PresenceStatus
    >;
} = {
    message: true,
    staff: true,
    offer: true,
    presenceStatus: true,
};

/** The realtime payloads the controller reads. */
export const staffEventsConform: {
    offered: Same<ChatEventPayloads['chat.offered'], App.Data.Chat.OfferData>;
    taken: Same<
        ChatEventPayloads['chat.taken'],
        App.Data.Chat.Events.ChatTakenPayload
    >;
    updated: Same<
        ChatEventPayloads['conversation.updated'],
        App.Data.Chat.Events.ConversationUpdatedPayload
    >;
    unread: Same<
        ChatEventPayloads['unread.updated'],
        App.Data.Chat.Events.UnreadUpdatedPayload
    >;
    revoked: Same<
        ChatEventPayloads['session.revoked'],
        App.Data.Chat.Events.SessionRevokedPayload
    >;
    created: Same<
        ChatEventPayloads['message.created'],
        App.Data.Chat.Events.MessageCreatedPayload
    >;
    delivered: Same<
        ChatEventPayloads['message.delivered'],
        App.Data.Chat.Events.MessageDeliveredPayload
    >;
    seen: Same<
        ChatEventPayloads['message.seen'],
        App.Data.Chat.Events.MessageSeenPayload
    >;
    ended: Same<
        ChatEventPayloads['conversation.ended'],
        App.Data.Chat.Events.ConversationEndedPayload
    >;
    ticket: Same<
        ChatEventPayloads['offline-ticket.created'],
        App.Data.Chat.Events.OfflineTicketCreatedPayload
    >;
} = {
    offered: true,
    taken: true,
    updated: true,
    unread: true,
    revoked: true,
    created: true,
    delivered: true,
    seen: true,
    ended: true,
    ticket: true,
};

/** The REST body of a send is `{client_msg_id, body?, attachments?}` (the contract); the UI input maps onto it field by field. */
export const sendBodyConforms: Same<
    ReturnType<typeof import('@/lib/chat-api/staff').sendMessageBody>,
    { client_msg_id: string; body?: string; attachments?: string[] }
> = true;

/** What the composer hands to `send()`: text plus already-uploaded attachments (the generated `AttachmentData`). */
export const sendInputConforms: Same<
    NonNullable<SendMessageInput['attachmentUlids']>,
    string[]
> = true;
