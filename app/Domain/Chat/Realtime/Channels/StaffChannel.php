<?php

namespace App\Domain\Chat\Realtime\Channels;

use Illuminate\Contracts\Auth\Authenticatable;

/** `private-staff.{userId}`: one staff member, only themselves. */
final class StaffChannel
{
    public function __construct(private readonly StaffAccess $access) {}

    public function join(?Authenticatable $user, string $userId): bool
    {
        $staff = $this->access->staff($user);

        return $staff !== null && ChannelName::isPrivate() && ctype_digit($userId) && (string) $staff->id === $userId;
    }
}
