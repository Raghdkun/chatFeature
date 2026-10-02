<?php

namespace App\Domain\Chat\Realtime\Channels;

use App\Data\Chat\PresenceMemberData;
use App\Domain\Presence\PresenceService;
use Illuminate\Contracts\Auth\Authenticatable;

/**
 * `presence-staff`: the roster of signed-in staff. Every active admin or agent may join; the member info other members see is
 * `{id, name, avatarUrl, status}` (no e-mail), the status being the account's effective presence (the presence store).
 */
final class PresenceStaffChannel
{
    public function __construct(
        private readonly StaffAccess $access,
        private readonly PresenceService $presence,
    ) {}

    /**
     * @return array<string, mixed>|false
     */
    public function join(?Authenticatable $user): array|false
    {
        $staff = $this->access->staff($user);

        if ($staff === null || ! ChannelName::isPresence()) {
            return false;
        }

        return PresenceMemberData::fromModel($staff, $this->presence->statusOf($staff))->toArray();
    }
}
