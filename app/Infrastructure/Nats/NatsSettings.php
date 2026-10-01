<?php

namespace App\Infrastructure\Nats;

/**
 * Connection + behaviour settings for the pizzasys event consumer (the active auth environment's NATS block).
 *
 * `tlsCaFile`: path of a CA bundle. basis-company/nats only verifies the server certificate when one is given
 * (otherwise TLS is encrypted but unauthenticated).
 */
final readonly class NatsSettings
{
    public function __construct(
        public bool $enabled,
        public ?string $url,
        public ?string $token,
        public string $stream = 'AUTH_EVENTS',
        public bool $ensureStream = true,
        public string $environmentKey = 'production',
        public ?string $tlsCaFile = null,
    ) {}
}
