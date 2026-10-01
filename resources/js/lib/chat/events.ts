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
    messageSeen: 'message.seen',
    conversationEnded: 'conversation.ended',
    conversationClosed: 'conversation.closed',
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
    'message.seen': App.Data.Chat.Events.MessageSeenPayload;
    'conversation.ended': App.Data.Chat.Events.ConversationEndedPayload;
    'conversation.closed': App.Data.Chat.Events.ConversationClosedPayload;
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
