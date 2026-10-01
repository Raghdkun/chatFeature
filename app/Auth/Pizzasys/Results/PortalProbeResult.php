<?php

namespace App\Auth\Pizzasys\Results;

/** Result of the service-credential probe (`token-verify` with a dummy token: expects HTTP 200 `active:false`). */
final readonly class PortalProbeResult
{
    public function __construct(
        public bool $reachable,
        public bool $serviceCredentialAccepted,
        public ?int $latencyMs,
        public ?string $message = null,
        public ?string $reason = null,
    ) {}
}
