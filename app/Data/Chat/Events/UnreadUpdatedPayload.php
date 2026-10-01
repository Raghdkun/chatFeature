<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `unread.updated` on `private-staff.{id}`: `{v, conversation: ulid, unseen}` (the server's counter, never a delta). */
#[TypeScript]
class UnreadUpdatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public string $conversation,
        public int $unseen,
    ) {}
}
