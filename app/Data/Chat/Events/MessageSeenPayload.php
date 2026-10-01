<?php

namespace App\Data\Chat\Events;

use App\Domain\Chat\Enums\SenderType;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `message.seen` on `private-conversation.{ulid}`: `{v, upToSeq, by: 'visitor' | 'agent', at}`. */
#[TypeScript]
class MessageSeenPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public int $upToSeq,
        public SenderType $by,
        public string $at,
    ) {}
}
