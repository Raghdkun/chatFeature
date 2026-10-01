<?php

namespace App\Infrastructure\Nats;

/**
 * A NATS server address parsed from `nats://[user:pass@]host[:port]` (also `tls://`, or a bare `host[:port]`).
 * TLS is negotiated by the client library when the server announces it, so the scheme does not matter here.
 */
final readonly class NatsEndpoint
{
    public const DEFAULT_PORT = 4222;

    public function __construct(
        public string $host,
        public int $port = self::DEFAULT_PORT,
        public ?string $user = null,
        public ?string $password = null,
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
            $parts['host'],
            $parts['port'] ?? self::DEFAULT_PORT,
            isset($parts['user']) ? rawurldecode($parts['user']) : null,
            isset($parts['pass']) ? rawurldecode($parts['pass']) : null,
        );
    }
}
