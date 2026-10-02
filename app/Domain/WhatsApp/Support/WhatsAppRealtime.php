<?php

namespace App\Domain\WhatsApp\Support;

use Illuminate\Broadcasting\PrivateChannel;

/**
 * The one place the name of the WhatsApp channel is spelled. `PrivateChannel` adds the `private-` prefix the Pusher protocol (and so
 * `routes/channels.php`) expects. The event names are `App\Domain\WhatsApp\Enums\WaRealtimeEvent`.
 */
final class WhatsAppRealtime
{
    /** The name `routes/channels.php` registers (Laravel strips the `private-` prefix before it matches). */
    public const ADMIN_CHANNEL = 'whatsapp-admin';

    public static function adminChannel(): PrivateChannel
    {
        return new PrivateChannel(self::ADMIN_CHANNEL);
    }
}
