<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.rated` on `private-admin`: `{v, conversation: ulid, score: 1..5}`. */
#[TypeScript]
class ConversationRatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public string $conversation,
        public int $score,
    ) {}
}
