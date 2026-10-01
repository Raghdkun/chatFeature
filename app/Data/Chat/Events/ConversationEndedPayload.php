<?php

namespace App\Data\Chat\Events;

use App\Domain\Chat\Enums\ConversationEndedBy;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.ended` on `private-conversation.{ulid}`: `{v, endedBy, ratingRequested}`. */
#[TypeScript]
class ConversationEndedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public ConversationEndedBy $endedBy,
        public bool $ratingRequested,
    ) {}
}
