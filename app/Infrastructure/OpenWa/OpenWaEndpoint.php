<?php

namespace App\Infrastructure\OpenWa;

use App\Support\Network\OutboundTarget;
use SensitiveParameter;

/**
 * Where the OpenWA gateway is for ONE call: the saved base URL, the API key and the destination the outbound guard just judged
 * (so the connection can be pinned to it). Built per call, never kept; the key is only reachable through {@see self::apiKey()} and
 * is hidden from dumps, so it cannot end up in a log line or an exception by accident.
 */
final class OpenWaEndpoint
{
    public function __construct(
        public readonly string $baseUrl,
        #[SensitiveParameter] private readonly string $apiKey,
        public readonly OutboundTarget $target,
    ) {}

    public function apiKey(): string
    {
        return $this->apiKey;
    }

    /** The full URL of an API path (`/api/sessions`). */
    public function url(string $path): string
    {
        return rtrim($this->baseUrl, '/').'/'.ltrim($path, '/');
    }

    /**
     * @return array<string, mixed>
     */
    public function __debugInfo(): array
    {
        return ['baseUrl' => $this->baseUrl, 'apiKey' => '[hidden]'];
    }
}
