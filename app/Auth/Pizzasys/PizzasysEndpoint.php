<?php

namespace App\Auth\Pizzasys;

use SensitiveParameter;

/**
 * Everything needed to talk to one pizzasys deployment, with the service token decrypted. It only ever
 * lives in memory for the duration of a request: it is never serialised, logged or returned to a client.
 */
final readonly class PizzasysEndpoint
{
    public function __construct(
        public string $key,
        public string $baseUrl,
        public string $apiPrefix,
        public string $serviceName,
        #[SensitiveParameter]
        public string $serviceToken,
        public bool $verifyTls = true,
    ) {}

    /** Absolute URL of an auth endpoint, e.g. `url('/auth/login')`. */
    public function url(string $path): string
    {
        return rtrim($this->baseUrl, '/').'/'.trim($this->apiPrefix, '/').'/'.ltrim($path, '/');
    }

    /**
     * @return array<string, mixed>
     */
    public function __debugInfo(): array
    {
        return [
            'key' => $this->key,
            'baseUrl' => $this->baseUrl,
            'apiPrefix' => $this->apiPrefix,
            'serviceName' => $this->serviceName,
            'serviceToken' => '[redacted]',
            'verifyTls' => $this->verifyTls,
        ];
    }
}
