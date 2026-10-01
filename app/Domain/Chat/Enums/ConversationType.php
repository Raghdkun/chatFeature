<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `live` is a real-time chat offered to online agents; `offline` is a ticket left while nobody was available
 * (answered by email). Offline tickets never use the `ended` / `missed` statuses.
 */
#[TypeScript]
enum ConversationType: string
{
    case Live = 'live';
    case Offline = 'offline';
}
