<?php

namespace App\Domain\Chat\Realtime;

/**
 * The event names of docs/contracts/realtime-events.md (`broadcastAs()`), plus `typing`: the REST fallback of the
 * `client-typing` whisper (a server may not publish an event whose name starts with `client-`).
 */
enum RealtimeEvent: string
{
    case ChatOffered = 'chat.offered';
    case ChatTaken = 'chat.taken';
    case ChatAssigned = 'chat.assigned';
    case ChatClaimed = 'chat.claimed';
    case ConversationUpdated = 'conversation.updated';
    case UnreadUpdated = 'unread.updated';
    case QueueUpdated = 'queue.updated';
    case SessionRevoked = 'session.revoked';
    case PresenceChanged = 'presence.changed';
    case MessageCreated = 'message.created';
    case MessageDelivered = 'message.delivered';
    case MessageSeen = 'message.seen';
    case ConversationEnded = 'conversation.ended';
    case ConversationClosed = 'conversation.closed';
    case ConversationMissed = 'conversation.missed';
    case ConversationTransferred = 'conversation.transferred';
    case OfflineTicketCreated = 'offline-ticket.created';
    case ConversationRated = 'conversation.rated';
    case Typing = 'typing';
}
