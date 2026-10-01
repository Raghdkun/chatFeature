<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Why a conversation reached `closed` (`conversations.close_reason`):
 * `rated` / `skipped` after the rating prompt, `timeout` when the rating window ran out, `idle` for the idle sweep,
 * `cancelled` when the visitor left the queue, `system` for anything the server decided.
 */
#[TypeScript]
enum ConversationCloseReason: string
{
    case Rated = 'rated';
    case Skipped = 'skipped';
    case Idle = 'idle';
    case Timeout = 'timeout';
    case System = 'system';
    case Cancelled = 'cancelled';
}
