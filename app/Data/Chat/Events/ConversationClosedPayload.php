<?php

namespace App\Data\Chat\Events;

use App\Domain\Chat\Enums\ConversationCloseReason;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.closed` on `private-conversation.{ulid}`: `{v, reason}`. */
#[TypeScript]
class ConversationClosedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public ConversationCloseReason $reason,
    ) {}
}
