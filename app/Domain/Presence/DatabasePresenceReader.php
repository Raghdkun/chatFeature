<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Widgets\Contracts\PresenceReader;

/**
 * Widget availability from the presence mirror in the database (P4). P5 keeps the interface and puts Redis behind `PresenceService`.
 */
final class DatabasePresenceReader implements PresenceReader
{
    public function __construct(private readonly AvailableAgents $agents) {}

    public function onlineAgentsByCategory(array $categoryIds, ?array $statuses = null): array
    {
        return $this->agents->countByCategory($categoryIds, $statuses === null ? null : array_values(array_filter(array_map(PresenceStatus::tryFrom(...), $statuses))));
    }
}
