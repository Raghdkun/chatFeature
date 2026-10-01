<?php

namespace App\Data\Chat\Events;

use App\Data\Chat\MessageData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `message.created` on `private-conversation.{ulid}`: `{v, message: Message}`. The channel is shared by the visitor and the
 * agent, so the message is always the visitor-safe form (no staff ids).
 */
#[TypeScript]
class MessageCreatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public MessageData $message,
    ) {}
}
