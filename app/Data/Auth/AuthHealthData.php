<?php

namespace App\Data\Auth;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Portal health card. `service_credential_rejected` is additive to the contract: true while the portal is answering
 * HTTP 401 to our service credential (sessions keep working through `/auth/me`; new sign-ins are refused).
 */
#[TypeScript]
class AuthHealthData extends Data
{
    public function __construct(
        public PortalHealthStatus $portal,
        public bool $circuit_open,
        public ?string $last_verify_at,
        public AuthNatsHealthData $nats,
        public bool $service_credential_rejected = false,
    ) {}
}
