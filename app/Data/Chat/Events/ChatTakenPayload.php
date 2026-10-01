<?php

namespace App\Data\Chat\Events;

use App\Data\Chat\StaffAgentRefData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `chat.taken` on `private-staff.{id}` (the other offered agents): `{v, conversation: ulid, by: {id, name}}`. */
#[TypeScript]
class ChatTakenPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public string $conversation,
        public StaffAgentRefData $by,
    ) {}
}
