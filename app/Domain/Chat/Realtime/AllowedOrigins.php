<?php

namespace App\Domain\Chat\Realtime;

/**
 * The host names Reverb accepts a websocket from (`reverb.apps.apps.0.allowed_origins`). Reverb compares the HOST of the
 * browser's `Origin` header only (no scheme, no port) and understands `*` patterns, so entries are reduced to bare lower-case
 * hosts and a wildcard-only entry is never produced.
 *
 * Both the dashboard and the visitor panel (an iframe served by this application) open their socket from the application's own
 * host, so that host is the whole default. Anything else is an explicit REVERB_ALLOWED_ORIGINS entry.
 */
final class AllowedOrigins
{
    /**
     * What `config/reverb.php` passes: the host of APP_URL, the REVERB_ALLOWED_ORIGINS list, and loopback in the `local` environment.
     * (The values come in as arguments, straight from `env()`, which is only valid inside the config files and may yield anything.)
     *
     * @return list<string>
     */
    public static function forApp(mixed $appUrl, mixed $extraOrigins, bool $allowLoopback): array
    {
        $hosts = [self::host(is_string($appUrl) ? $appUrl : '')];

        if ($allowLoopback) {
            array_push($hosts, 'localhost', '127.0.0.1');
        }

        return self::parse(is_string($extraOrigins) ? $extraOrigins : '', array_values(array_filter($hosts)));
    }

    /**
     * @param  list<string>  $base  Hosts that are always allowed.
     * @return list<string>
     */
    public static function parse(string $list, array $base = []): array
    {
        $hosts = $base;

        foreach (explode(',', $list) as $entry) {
            $host = self::host($entry);

            if ($host !== null) {
                $hosts[] = $host;
            }
        }

        return array_values(array_unique($hosts));
    }

    /**
     * The saved application URL (setup wizard) joins the configured hosts.
     *
     * @param  list<string>  $configured
     * @return list<string>
     */
    public static function withAppUrl(array $configured, string $appUrl): array
    {
        $host = self::host($appUrl);

        return $host === null ? $configured : array_values(array_unique([...$configured, $host]));
    }

    /**
     * `https://chat.example.com:8443/path`, `chat.example.com:8443` and `Chat.Example.com` all become `chat.example.com`;
     * anything that is not a usable host (empty, `*`, a bare wildcard) is null.
     */
    private static function host(string $entry): ?string
    {
        $entry = trim($entry);

        if ($entry === '' || $entry === '*') {
            return null;
        }

        $parts = parse_url(str_contains($entry, '://') ? $entry : '//'.$entry);
        $host = is_array($parts) ? ($parts['host'] ?? null) : null;

        if (! is_string($host) || $host === '' || trim($host, '*.') === '') {
            return null;
        }

        return strtolower($host);
    }
}
