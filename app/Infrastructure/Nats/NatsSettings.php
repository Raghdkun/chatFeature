<?php

namespace App\Infrastructure\Nats;

use SensitiveParameter;

/**
 * Connection + behaviour settings for the pizzasys event consumer (the active auth environment's NATS block).
 *
 * `verifyTls` / `tlsCaFile`: whether the server certificate and host name are verified, and against which CA bundle
 * (`NATS_TLS_CA_FILE`; the system store when empty). See {@see TlsPolicy} for when a plaintext session is refused.
 */
final readonly class NatsSettings
{
    public function __construct(
        public bool $enabled,
        public ?string $url,
        #[SensitiveParameter]
        public ?string $token,
        public string $stream = 'AUTH_EVENTS',
        public bool $ensureStream = true,
        public string $environmentKey = 'production',
        public ?string $tlsCaFile = null,
        public bool $verifyTls = true,
    ) {}
}
