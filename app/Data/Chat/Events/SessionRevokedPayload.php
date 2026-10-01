<?php

namespace App\Data\Chat\Events;

use App\Domain\Chat\Enums\SessionRevokeReason;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `session.revoked` on `private-staff.{id}`: `{v, reason}`. */
#[TypeScript]
class SessionRevokedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public SessionRevokeReason $reason,
    ) {}
}
