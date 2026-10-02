<?php

namespace App\Domain\WhatsApp\Support;

use App\Domain\Chat\Realtime\Channels\ChannelName;
use App\Domain\Chat\Realtime\Channels\StaffAccess;
use Illuminate\Contracts\Auth\Authenticatable;

/**
 * `private-whatsapp-admin`: active administrators only, never agents (decision P6-D1). Same rule as `private-admin` (a real chat role
 * and an active account, a Sanctum bearer's portal session judged like a browser's), and the channel exists only as a `private-`
 * channel: `presence-whatsapp-admin` is refused. Visitors never come through this callback.
 */
final class WhatsAppAdminChannel
{
    public function __construct(private readonly StaffAccess $access) {}

    public function join(?Authenticatable $user): bool
    {
        return $this->access->admin($user) !== null && ChannelName::isPrivate();
    }
}
