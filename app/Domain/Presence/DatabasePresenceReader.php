<?php

namespace App\Domain\Presence;

use App\Domain\Chat\Enums\PresenceStatus;
use App\Domain\Widgets\Contracts\PresenceReader;

/**
 * Widget availability for the public endpoint. The name is P4's (it read the table): since P5 it reads the presence store through
 * `AvailableAgents`, the same effective statuses routing uses, so a widget never says `online` for a chat that would then be refused.
 */
final class DatabasePresenceReader implements PresenceReader
{
    public function __construct(private readonly AvailableAgents $agents) {}

    public function onlineAgentsByCategory(array $categoryIds, ?array $statuses = null): array
    {
        return $this->agents->countByCategory($categoryIds, $statuses === null ? null : array_values(array_filter(array_map(PresenceStatus::tryFrom(...), $statuses))));
    }
}
