<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Presence\Contracts\PresenceStore;

/**
 * Read side of presence: the effective status of one or many users right now, from whichever store is active. Routing
 * (`AvailableAgents`), the public availability, `GET /me/presence`, the roster and the agents page all read through here (batch reads: one
 * round trip for any number of users), which is why they cannot disagree.
 */
final class EffectivePresence
{
    public function __construct(
        private readonly PresenceStore $store,
        private readonly PresencePolicy $policy,
    ) {}

    public function of(int $userId): PresenceStatus
    {
        return $this->many([$userId])[$userId];
    }

    /**
     * @param  list<int>  $userIds
     * @return array<int, PresenceStatus> every given id (`offline` when the store has no record)
     */
    public function many(array $userIds): array
    {
        $now = now();
        $records = $this->store->findMany(array_values(array_unique($userIds)), $now);
        $statuses = [];

        foreach ($userIds as $userId) {
            $statuses[$userId] = $this->policy->effective($records[$userId] ?? null, $now);
        }

        return $statuses;
    }
}
