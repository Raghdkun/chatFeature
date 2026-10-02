/**
 * Channel and event names of docs/contracts/realtime-events.md, with the payload type of each event. Payload types come from
 * the PHP payload classes (`app/Data/Chat/Events`, generated as `App.Data.Chat.App.Data.Chat.Events.*`); `OfferData` is the `chat.offered`
 * payload itself and `message.created` is `{ v, message }`.
 */
import type { OfferData, TypingWhisper } from '@/lib/chat/types';

export const CHAT_EVENT = {
    offered: 'chat.offered',
    taken: 'chat.taken',
    assigned: 'chat.assigned',
    claimed: 'chat.claimed',
    conversationUpdated: 'conversation.updated',
    unreadUpdated: 'unread.updated',
    queueUpdated: 'queue.updated',
    sessionRevoked: 'session.revoked',
    presenceChanged: 'presence.changed',
    messageCreated: 'message.created',
    messageDelivered: 'message.delivered',
    messageSeen: 'message.seen',
    conversationEnded: 'conversation.ended',
    conversationClosed: 'conversation.closed',
    conversationMissed: 'conversation.missed',
    conversationTransferred: 'conversation.transferred',
    offlineTicketCreated: 'offline-ticket.created',
    conversationRated: 'conversation.rated',
    /** Client whisper (no server round trip): payload is a `TypingWhisper`. */
    typing: 'client-typing',
    /** Server event for the REST typing fallback (a server cannot publish `client-*` events): payload `{ v, actor, typing }`. */
    typingFallback: 'typing',
} as const;

export type ChatEventName = (typeof CHAT_EVENT)[keyof typeof CHAT_EVENT];

/** Event name -> payload. Every server payload carries `v: 1`. */
export type ChatEventPayloads = {
    'chat.offered': OfferData;
    'chat.taken': App.Data.Chat.Events.ChatTakenPayload;
    'chat.assigned': App.Data.Chat.Events.ChatAssignedPayload;
    'chat.claimed': App.Data.Chat.Events.ChatClaimedPayload;
    'conversation.updated': App.Data.Chat.Events.ConversationUpdatedPayload;
    'unread.updated': App.Data.Chat.Events.UnreadUpdatedPayload;
    'queue.updated': App.Data.Chat.Events.QueueUpdatedPayload;
    'session.revoked': App.Data.Chat.Events.SessionRevokedPayload;
    'presence.changed': App.Data.Chat.Events.PresenceChangedPayload;
    'message.created': App.Data.Chat.Events.MessageCreatedPayload;
    'message.delivered': App.Data.Chat.Events.MessageDeliveredPayload;
    'message.seen': App.Data.Chat.Events.MessageSeenPayload;
    'conversation.ended': App.Data.Chat.Events.ConversationEndedPayload;
    'conversation.closed': App.Data.Chat.Events.ConversationClosedPayload;
    'conversation.missed': App.Data.Chat.Events.ConversationMissedPayload;
    'conversation.transferred': App.Data.Chat.Events.ConversationTransferredPayload;
    'offline-ticket.created': App.Data.Chat.Events.OfflineTicketCreatedPayload;
    'conversation.rated': App.Data.Chat.Events.ConversationRatedPayload;
    'client-typing': TypingWhisper;
    typing: { v: 1; actor: TypingWhisper['actor']; typing: boolean };
};

/** The only payload version the clients understand. */
export const PAYLOAD_VERSION = 1;

/** Channel names as Echo takes them (`echo.private(...)`, `echo.join(...)`): no `private-` / `presence-` prefix. */
export const channels = {
    staff: (userId: number): string => `staff.${userId}`,
    conversation: (ulid: string): string => `conversation.${ulid}`,
    admin: 'admin',
    presenceStaff: 'staff',
} as const;

/**
 * The name to pass to Echo's `listen()` / `useEcho()`. The server names events with `broadcastAs()`, and Echo only keeps a custom
 * name as it is when it starts with a dot.
 */
export function echoEvent(name: ChatEventName): string {
    return `.${name}`;
}

/**
 * The admin-only WhatsApp channel `private-whatsapp-admin` (P6, decision P6-D8; docs/contracts/whatsapp-data-p6.md). Active
 * administrators only: an agent can never subscribe, so the WhatsApp pages are the only code that listens to it. Every payload carries
 * `v: 1`; the types come from `app/Data/WhatsApp/Events`.
 */
export const WA_EVENT = {
    /** A message was stored (inbound, or an admin's reply handed to OpenWA): `{v, message, chat}`. */
    messageCreated: 'wa.message.created',
    /** A stored message changed (delivery ack, failure): `{v, message}`, merge by `message.ulid`. */
    messageUpdated: 'wa.message.updated',
    /** A chat's list entry changed: `{v, chat}`. */
    chatUpdated: 'wa.chat.updated',
    /** A session changed status or has a new QR to fetch over REST (the image is never broadcast): `{v, session}`. */
    sessionStatus: 'wa.session.status',
} as const;

export type WaEventName = (typeof WA_EVENT)[keyof typeof WA_EVENT];

/** WhatsApp event name -> payload. */
export type WaEventPayloads = {
    'wa.message.created': App.Data.WhatsApp.Events.WaMessageCreatedPayload;
    'wa.message.updated': App.Data.WhatsApp.Events.WaMessageUpdatedPayload;
    'wa.chat.updated': App.Data.WhatsApp.Events.WaChatUpdatedPayload;
    'wa.session.status': App.Data.WhatsApp.Events.WaSessionStatusPayload;
};

/** The WhatsApp channel as Echo takes it (`echo.private(waChannels.admin)`): no `private-` prefix. */
export const waChannels = {
    admin: 'whatsapp-admin',
} as const;

/** The name to pass to Echo's `listen()` / `useEcho()` for a WhatsApp event (custom `broadcastAs` names need the leading dot). */
export function waEchoEvent(name: WaEventName): string {
    return `.${name}`;
}
