<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.transferred` on `private-conversation.{ulid}`: `{v}` (the visitor sees "connecting you to another agent"). */
#[TypeScript]
class ConversationTransferredPayload extends Data
{
    public int $v = 1;
}
