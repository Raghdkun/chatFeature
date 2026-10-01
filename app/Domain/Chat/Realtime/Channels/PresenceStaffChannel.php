<?php

namespace App\Domain\Chat\Realtime\Channels;

use App\Data\Chat\PresenceMemberData;
use App\Domain\Chat\Enums\PresenceStatus;
use Illuminate\Contracts\Auth\Authenticatable;

/**
 * `presence-staff`: the roster of signed-in staff. Every active admin or agent may join; the member info other members see is
 * `{id, name, avatarUrl, status}` (no e-mail), the status being the stored presence of the account.
 */
final class PresenceStaffChannel
{
    public function __construct(private readonly StaffAccess $access) {}

    /**
     * @return array<string, mixed>|false
     */
    public function join(?Authenticatable $user): array|false
    {
        $staff = $this->access->staff($user);

        if ($staff === null || ! ChannelName::isPresence()) {
            return false;
        }

        return PresenceMemberData::fromModel($staff, $staff->presence->status ?? PresenceStatus::Offline)->toArray();
    }
}
