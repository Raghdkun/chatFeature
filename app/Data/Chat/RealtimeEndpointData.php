<?php

namespace App\Data\Chat;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Where the visitor panel opens its websocket (`ws` of the session answer): the public Reverb key and address, never a secret. */
#[TypeScript]
class RealtimeEndpointData extends Data
{
    public function __construct(
        public string $key,
        public string $host,
        public int $port,
        public string $scheme,
    ) {}

    /**
     * @param  array{key: string, host: string, port: int, scheme: string}  $endpoint  `ReverbEndpoint::forVisitors()`
     */
    public static function fromArray(array $endpoint): self
    {
        return new self(key: $endpoint['key'], host: $endpoint['host'], port: $endpoint['port'], scheme: $endpoint['scheme']);
    }
}
