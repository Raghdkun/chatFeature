<?php

namespace App\Domain\Notifications\Support;

use App\Support\Network\OutboundUrlGuard;

/**
 * A browser hands us the URL of its push service and the server later POSTs to it, so an endpoint is a request-forgery target like
 * the auth portal's address: it must be an https URL of a PUBLIC host (never loopback, a private network or a cloud metadata
 * address; {@see OutboundUrlGuard::checkHost()} decides on the host the URL names). Checked when the subscription is stored and again
 * right before every send.
 */
final class PushEndpointGuard
{
    public const MAX_LENGTH = 2048;

    public function __construct(private readonly OutboundUrlGuard $guard) {}

    public function allows(string $endpoint): bool
    {
        if ($endpoint === '' || strlen($endpoint) > self::MAX_LENGTH) {
            return false;
        }

        $parts = parse_url($endpoint);

        // A push endpoint is https with a host (and usually a query: Windows' ends in `?token=...`), nothing else.
        if ($parts === false
            || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || ! isset($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) {
            return false;
        }

        return $this->guard->checkHost($parts['host'], (int) ($parts['port'] ?? 443), 'https')->ok;
    }
}
