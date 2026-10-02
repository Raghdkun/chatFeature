<?php

namespace App\Domain\Notifications\Support;

use App\Support\Network\OutboundUrlGuard;

/**
 * A browser hands us the URL of its push service and the server later POSTs to it, so an endpoint is a request-forgery target like
 * the auth portal's address: it must be an https URL of a PUBLIC host (never loopback, a private network or a cloud metadata
 * address; {@see OutboundUrlGuard} decides). Checked when the subscription is stored and again right before every send.
 */
final class PushEndpointGuard
{
    public const MAX_LENGTH = 2048;

    public function __construct(private readonly OutboundUrlGuard $guard) {}

    public function allows(string $endpoint): bool
    {
        if ($endpoint === '' || strlen($endpoint) > self::MAX_LENGTH || ! str_starts_with(strtolower($endpoint), 'http')) {
            return false;
        }

        $parts = parse_url($endpoint);

        if ($parts === false || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) {
            return false;
        }

        return $this->guard->checkHttpUrl($endpoint)->ok;
    }
}
