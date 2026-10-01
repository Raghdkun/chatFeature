<?php

namespace App\Infrastructure\Nats;

use SensitiveParameter;

/**
 * A NATS server address parsed from `nats://[user:pass@]host[:port]` (also `tls://`, or a bare `host[:port]`).
 * `tls` is true for a `tls://` address: that session must be encrypted ({@see TlsPolicy}).
 */
final readonly class NatsEndpoint
{
    public const DEFAULT_PORT = 4222;

    public function __construct(
        public string $host,
        public int $port = self::DEFAULT_PORT,
        public ?string $user = null,
        #[SensitiveParameter]
        public ?string $password = null,
        public bool $tls = false,
    ) {}

    /**
     * @throws GatewayException
     */
    public static function parse(string $url): self
    {
        $url = trim($url);

        if ($url === '') {
            throw new GatewayException('The NATS URL is empty.');
        }

        $parts = parse_url(str_contains($url, '://') ? $url : 'nats://'.$url);

        if ($parts === false || ! isset($parts['host']) || $parts['host'] === '') {
            throw new GatewayException('The NATS URL is not valid.');
        }

        return new self(
            // An IPv6 literal comes back in brackets; the host is kept bare.
            trim($parts['host'], '[]'),
            $parts['port'] ?? self::DEFAULT_PORT,
            isset($parts['user']) ? rawurldecode($parts['user']) : null,
            isset($parts['pass']) ? rawurldecode($parts['pass']) : null,
            strtolower((string) ($parts['scheme'] ?? '')) === 'tls',
        );
    }
}
