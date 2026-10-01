<?php

namespace App\Auth\Pizzasys\Results;

/**
 * Human wording for the machine reasons the portal client reports. Messages are curated on purpose: raw
 * transport errors (hosts, resolver output, response bodies) never reach a page or a log line.
 */
final class PortalFailure
{
    public const TIMEOUT = 'timeout';

    public const CONNECTION = 'connection';

    public const TLS = 'tls';

    public const RATE_LIMITED = 'rate_limited';

    public const UNEXPECTED_RESPONSE = 'unexpected_response';

    public const CIRCUIT_OPEN = 'circuit_open';

    public const NOT_CONFIGURED = 'not_configured';

    /** The address is refused by the outbound guard. Looks like "cannot connect" to everybody. */
    public const BLOCKED = 'blocked';

    public static function http(int $status): string
    {
        return 'http_'.$status;
    }

    /** Whether the portal could not be reached at all (as opposed to answering something unexpected). */
    public static function isUnreachable(?string $reason): bool
    {
        return $reason === null
            || in_array($reason, [self::TIMEOUT, self::CONNECTION, self::TLS, self::CIRCUIT_OPEN, self::NOT_CONFIGURED, self::RATE_LIMITED, self::BLOCKED], true)
            || str_starts_with($reason, 'http_5');
    }

    /**
     * Our own wording for the portal's 401 on the service credential. The portal's text is never echoed (it ends up in
     * the UI and in stored check results), so only the known messages are recognised.
     */
    public static function serviceRejection(?string $upstreamMessage): string
    {
        return match (strtolower(rtrim(trim((string) $upstreamMessage), '.'))) {
            'unknown service' => __('The portal does not know a service with this name.'),
            'invalid service token' => __('The service token is not valid for this service.'),
            'service is inactive' => __('The service is deactivated in the portal.'),
            'service token expired' => __('The service token has expired.'),
            default => __('The portal rejected the service credential.'),
        };
    }

    public static function message(?string $reason): string
    {
        return match (true) {
            $reason === self::TIMEOUT => __('The portal did not answer in time.'),
            $reason === self::TLS => __('The portal\'s TLS certificate could not be verified.'),
            $reason === self::RATE_LIMITED => __('The portal is rate limiting requests.'),
            $reason === self::UNEXPECTED_RESPONSE => __('The portal returned an answer this app cannot read.'),
            $reason === self::CIRCUIT_OPEN => __('Paused for a moment after repeated portal failures.'),
            $reason === self::NOT_CONFIGURED => __('The portal is not configured.'),
            $reason !== null && str_starts_with($reason, 'http_') => __('The portal answered with HTTP :status. Check the base URL and API prefix.', ['status' => substr($reason, 5)]),
            default => __('Could not connect to the portal. Check the address and that it is running.'),
        };
    }
}
