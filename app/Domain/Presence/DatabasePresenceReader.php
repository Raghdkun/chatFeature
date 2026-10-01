<?php

namespace App\Domain\Presence;

use App\Domain\Widgets\Contracts\PresenceReader;

/**
 * Widget availability from the presence mirror in the database (P4). P5 keeps the interface and puts Redis behind `PresenceService`.
 */
final class DatabasePresenceReader implements PresenceReader
{
    public function __construct(private readonly AvailableAgents $agents) {}

    public function onlineAgentsByCategory(array $categoryIds): array
    {
        return $this->agents->countByCategory($categoryIds);
    }
}
