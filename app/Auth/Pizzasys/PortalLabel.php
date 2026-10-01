<?php

namespace App\Auth\Pizzasys;

use App\Support\Network\OutboundUrlGuard;

/**
 * What the sign-in page may say about the portal. `AuthCapabilities::portalUrl` reaches every visitor on every Inertia
 * page, so it must not disclose the address the server really calls (an internal host, a Docker service name, a port, a
 * path or an IP): only `https://<host>` of a public DNS name, otherwise nothing (the login screen copes with null).
 */
final class PortalLabel
{
    public static function forBaseUrl(?string $baseUrl): ?string
    {
        if ($baseUrl === null || $baseUrl === '') {
            return null;
        }

        $host = parse_url($baseUrl, PHP_URL_HOST);

        if (! is_string($host)) {
            return null;
        }

        $host = strtolower(rtrim($host, '.'));

        return OutboundUrlGuard::isPublicDnsName($host) ? 'https://'.$host : null;
    }
}
