<?php

namespace App\Domain\Notifications\Support;

use App\Support\Network\OutboundTarget;
use App\Support\Network\OutboundUrlGuard;
use Illuminate\Contracts\Cache\Repository as Cache;
use Throwable;

/**
 * A browser hands us the URL of its push service and the server later POSTs to it, so an endpoint is a request-forgery target the
 * browser (that is: an authenticated, but not trusted, member of staff) chooses. The rules are stricter than for an address an
 * administrator typed:
 *
 *  - https only, a host (never credentials or a fragment), printable ASCII without a backslash (whatever the URL parser and curl might read
 *    differently is refused), no trailing-dot host, at most {@see self::MAX_LENGTH} characters;
 *  - port 443, unless an entry of `push.allowed_hosts` names another one (`host:port`);
 *  - the host must be PUBLIC in every answer ({@see OutboundUrlGuard::checkPublicHost()}): loopback, private, link-local, metadata and the
 *    odd spellings of those (`0x7f.1`, `2130706433`, `localhost`, a name that resolves to a private address) are refused WHATEVER
 *    `PORTAL_ALLOW_PRIVATE_HOSTS` / `APP_ENV` say: that switch exists for the OpenWA gateway and the auth portal, not for browsers;
 *  - `push.allowed_hosts` (host patterns, `*.example.com` = any sub-domain) narrows it to the push services an installation trusts; empty
 *    means any public host.
 *
 * The judgement of a host (its resolved addresses) is cached for `push.dns_cache_seconds` (60): a burst of sends, or a flood of
 * registrations, costs one DNS lookup per host and minute, and the connection is PINNED to the judged addresses
 * ({@see OutboundTarget::curlResolveEntry()}) so the name cannot be re-pointed between the judgement and the connect. Checked when a
 * subscription is stored and again before every send.
 */
class PushEndpointGuard
{
    public const MAX_LENGTH = 2048;

    private const CACHE_PREFIX = 'push:endpoint-host:';

    public function __construct(
        private readonly OutboundUrlGuard $guard,
        private readonly Cache $cache,
    ) {}

    public function allows(string $endpoint): bool
    {
        return $this->inspect($endpoint)->ok;
    }

    /**
     * The verdict for an endpoint: when `ok`, `host`, `port` and `addresses` are what to connect to (see `curlResolveEntry()`).
     */
    public function inspect(string $endpoint): OutboundTarget
    {
        if ($endpoint === '' || strlen($endpoint) > self::MAX_LENGTH || preg_match('/[^\x21-\x7e]|\\\\/', $endpoint) === 1) {
            return OutboundTarget::blocked('malformed');
        }

        $parts = parse_url($endpoint);

        // A push endpoint is https with a host (and usually a query: Windows' ends in `?token=...`), nothing else.
        if ($parts === false
            || strtolower((string) ($parts['scheme'] ?? '')) !== 'https'
            || ! isset($parts['host'])
            || isset($parts['user']) || isset($parts['pass']) || isset($parts['fragment'])) {
            return OutboundTarget::blocked('malformed');
        }

        $host = strtolower($parts['host']);
        $port = (int) ($parts['port'] ?? 443);

        if ($host === '' || str_ends_with($host, '.') || ! $this->portAndHostAllowed($host, $port)) {
            return OutboundTarget::blocked('not_allowed');
        }

        return $this->judged($host, $port);
    }

    /**
     * Whether the configured list (if any) lets this host and port through; without a list only the standard port does.
     */
    private function portAndHostAllowed(string $host, int $port): bool
    {
        $patterns = $this->patterns();

        if ($patterns === []) {
            return $port === 443;
        }

        foreach ($patterns as [$pattern, $patternPort]) {
            if ($patternPort === $port && $this->matches($pattern, $host)) {
                return true;
            }
        }

        return false;
    }

    /**
     * @return list<array{0: string, 1: int}> pattern (lower case) and the port it allows (443 unless it says `:port`)
     */
    private function patterns(): array
    {
        $patterns = [];

        foreach ((array) config('push.allowed_hosts', []) as $entry) {
            if (! is_string($entry) || trim($entry) === '') {
                continue;
            }

            $entry = strtolower(trim($entry));
            $port = 443;

            if (preg_match('/^(.+):(\d{1,5})$/', $entry, $matches) === 1) {
                $entry = $matches[1];
                $port = (int) $matches[2];
            }

            $patterns[] = [$entry, $port];
        }

        return $patterns;
    }

    /** `example.com` is exactly that host; `*.example.com` is any sub-domain of it (one label or more), never the bare domain. */
    private function matches(string $pattern, string $host): bool
    {
        if (str_starts_with($pattern, '*.')) {
            $suffix = substr($pattern, 1);

            return strlen($host) > strlen($suffix) && str_ends_with($host, $suffix);
        }

        return $host === $pattern;
    }

    private function judged(string $host, int $port): OutboundTarget
    {
        $ttl = max(0, (int) config('push.dns_cache_seconds', 60));
        $key = self::CACHE_PREFIX.sha1($host.':'.$port);

        if ($ttl > 0) {
            try {
                $cached = $this->cache->get($key);

                if (is_array($cached) && isset($cached['ok'])) {
                    return $this->fromCache($cached, $host, $port);
                }
            } catch (Throwable) {
                // A cache outage only costs a lookup.
            }
        }

        $target = $this->guard->checkPublicHost($host, $port, 'https');

        if ($ttl > 0) {
            try {
                $this->cache->put($key, [
                    'ok' => $target->ok,
                    'addresses' => $target->addresses,
                    'ipLiteral' => $target->ipLiteral,
                    'reason' => $target->reason,
                ], $ttl);
            } catch (Throwable) {
                // Not worth failing a push for.
            }
        }

        return $target;
    }

    /**
     * @param  array<string, mixed>  $cached
     */
    private function fromCache(array $cached, string $host, int $port): OutboundTarget
    {
        if ($cached['ok'] !== true) {
            return OutboundTarget::blocked(is_string($cached['reason'] ?? null) ? $cached['reason'] : 'refused');
        }

        $addresses = array_values(array_filter((array) ($cached['addresses'] ?? []), is_string(...)));

        return new OutboundTarget(true, 'https', $host, $port, $addresses, (bool) ($cached['ipLiteral'] ?? false), false);
    }
}
