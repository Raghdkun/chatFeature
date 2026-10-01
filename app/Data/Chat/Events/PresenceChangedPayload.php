<?php

namespace App\Data\Chat\Events;

use App\Domain\Chat\Enums\PresenceStatus;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `presence.changed` on `presence-staff`: `{v, userId, status}`. */
#[TypeScript]
class PresenceChangedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public int $userId,
        public PresenceStatus $status,
    ) {}
}
