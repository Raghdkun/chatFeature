<?php

namespace App\Domain\Chat\Realtime\Channels;

use Illuminate\Contracts\Auth\Authenticatable;

/** `private-admin`: active administrators only. */
final class AdminChannel
{
    public function __construct(private readonly StaffAccess $access) {}

    public function join(?Authenticatable $user): bool
    {
        return $this->access->admin($user) !== null && ChannelName::isPrivate();
    }
}
