<?php

namespace App\Infrastructure\Nats;

/**
 * Connection + behaviour settings for the pizzasys event consumer (the active auth environment's NATS block).
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
    ) {}
}
