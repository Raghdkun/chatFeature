<?php

namespace App\Data\Chat\Events;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `queue.updated` on `private-staff.{id}` and `private-admin`: `{v, queued}` (what that audience can see in the queue). */
#[TypeScript]
class QueueUpdatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public int $queued,
    ) {}
}
