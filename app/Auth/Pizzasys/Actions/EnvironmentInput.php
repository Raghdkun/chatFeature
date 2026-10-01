<?php

namespace App\Auth\Pizzasys\Actions;

use SensitiveParameter;

/**
 * What an administrator (or `chat:auth:set-env`) submits for one auth environment. `null` means "keep what is stored"
 * for everything except the NATS token, where {@see $natsTokenGiven} tells "left out" (keep) from "sent, possibly empty"
 * (replace, or clear when empty).
 */
final readonly class EnvironmentInput
{
    public function __construct(
        public string $baseUrl,
        public string $serviceName,
        public ?string $label = null,
        public ?string $apiPrefix = null,
        #[SensitiveParameter]
        public ?string $serviceToken = null,
        public ?string $natsUrl = null,
        #[SensitiveParameter]
        public ?string $natsToken = null,
        public bool $natsTokenGiven = false,
        public ?bool $verifyTls = null,
    ) {}

    public function hasServiceToken(): bool
    {
        return $this->serviceToken !== null && $this->serviceToken !== '';
    }

    /**
     * @return array<string, mixed>
     */
    public function __debugInfo(): array
    {
        return [
            'baseUrl' => $this->baseUrl,
            'serviceName' => $this->serviceName,
            'natsUrl' => $this->natsUrl,
            'serviceToken' => $this->serviceToken !== null ? '[redacted]' : null,
            'natsToken' => $this->natsToken !== null ? '[redacted]' : null,
        ];
    }
}
