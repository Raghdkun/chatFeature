<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `chat.assigned` on `private-staff.{id}` (transfer / admin assignment): `{v, conversation: ulid}`. */
#[TypeScript]
class ChatAssignedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public string $conversation,
    ) {}
}
