<?php

namespace App\Domain\Widgets\Support;

use App\Domain\Widgets\Contracts\PresenceReader;

/** Default binding until P5 ships presence: no agent is ever online. */
final class NullPresenceReader implements PresenceReader
{
    public function onlineAgentsByCategory(array $categoryIds, ?array $statuses = null): array
    {
        return [];
    }
}
