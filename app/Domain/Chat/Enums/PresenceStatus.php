<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** An agent's availability. `online` and `away` both count as "available" for routing (online agents are offered first). */
#[TypeScript]
enum PresenceStatus: string
{
    case Online = 'online';
    case Away = 'away';
    case Offline = 'offline';

    /** Whether the agent can be offered chats at all. */
    public function isAvailable(): bool
    {
        return $this !== self::Offline;
    }
}
