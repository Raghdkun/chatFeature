<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** What the NATS event consumer last reported (cache heartbeat keys written by `chat:auth:consume-nats`). */
#[TypeScript]
class AuthNatsHealthData extends Data
{
    public function __construct(
        public bool $enabled,
        public ?bool $connected,
        public ?string $last_event_at,
    ) {}
}
