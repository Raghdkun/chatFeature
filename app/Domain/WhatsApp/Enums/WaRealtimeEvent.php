<?php

namespace App\Domain\WhatsApp\Enums;

/**
 * The event names (`broadcastAs()`) of the admin-only channel `private-whatsapp-admin` (decision P6-D8). Every payload carries `v: 1`;
 * the payload classes are in `app/Data/WhatsApp/Events`, the TypeScript twin is `WA_EVENT` in `resources/js/lib/chat/events.ts`.
 */
enum WaRealtimeEvent: string
{
    /** A message was stored (inbound, or an admin's reply handed to OpenWA): `{v, message, chat}`. */
    case MessageCreated = 'wa.message.created';

    /** A stored message changed (delivery ack, failure): `{v, message}`. */
    case MessageUpdated = 'wa.message.updated';

    /** A chat's list entry changed (new activity, unread counter, link to a widget, archive): `{v, chat}`. */
    case ChatUpdated = 'wa.chat.updated';

    /** A session changed status or has a new QR to fetch: `{v, session}`. */
    case SessionStatus = 'wa.session.status';
}
