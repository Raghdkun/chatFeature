<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.missed` on `private-conversation.{ulid}`: `{v}`. The visitor's cue to show the offline form. */
#[TypeScript]
class ConversationMissedPayload extends Data
{
    public int $v = 1;
}
