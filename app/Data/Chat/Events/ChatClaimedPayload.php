<?php

namespace App\Data\Chat\Events;

use App\Data\Chat\AgentRefData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `chat.claimed` on `private-conversation.{ulid}`: `{v, agent: {name, avatarUrl}, claimedAt}`. Visitor-safe. */
#[TypeScript]
class ChatClaimedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public AgentRefData $agent,
        public string $claimedAt,
    ) {}
}
