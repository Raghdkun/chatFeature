<?php

namespace App\Domain\Widgets\Origin;

/**
 * Domain whitelist logic for widgets: normalises the hosts an admin may enter and decides whether a browser
 * `Origin` (or the origin of a `Referer`) is allowed to embed / call a widget.
 *
 * Rules (docs/contracts/dashboard-pages-p3.md):
 * - an entry is `host`, `host:port` or `*.host[:port]`; hosts are lower-case, punycode, without scheme/path/userinfo;
 * - the wildcard is only valid as the whole first label and needs a base with at least two labels (`*.com` is refused);
 *   it matches subdomains at any depth but never the apex (`*.example.com` matches `a.b.example.com`, not `example.com`);
 * - an entry without a port matches only the scheme's default port; an entry with a port matches exactly that port;
 * - matching is by label boundary, so `evil-example.com` and `example.com.evil.net` never match `*.example.com`;
 * - `Origin: null`, userinfo (`@`), paths, backslashes and percent escapes never match.
 *
 * Stateless: safe to share. Entries that fail to parse are skipped (they cannot match anything).
 *
 * @phpstan-type ParsedHost array{host: string, port: int|null, wildcard: bool, scheme: string|null}
 * @phpstan-type ParsedOrigin array{scheme: string, host: string, port: int|null}
 */
final class OriginMatcher
{
    private const MAX_ENTRY_LENGTH = 260;

    /**
     * Normalise an admin-entered domain, or null when it is not an acceptable host.
     */
    public function normalizeEntry(string $input): ?string
    {
        $parsed = $this->parseEntry($input);

        if ($parsed === null) {
            return null;
        }

        return ($parsed['wildcard'] ? '*.' : '').$parsed['host'].($parsed['port'] !== null ? ':'.$parsed['port'] : '');
    }

    /**
     * Whether the request origin is covered by one of the (normalised) entries.
     *
     * @param  iterable<string>  $entries
     */
    public function matches(?string $origin, iterable $entries): bool
    {
        $parsed = $this->parseOrigin($origin);

        if ($parsed === null) {
            return false;
        }

        foreach ($entries as $entry) {
            $candidate = $this->parseEntry($entry);

            if ($candidate !== null && $this->covers($candidate, $parsed)) {
                return true;
            }
        }

        return false;
    }

    /**
     * Strictly parse an `Origin` header value (`scheme://host[:port]`, nothing else).
     *
     * @return ParsedOrigin|null
     */
    public function parseOrigin(?string $origin): ?array
    {
        if ($origin === null || $origin === '' || strlen($origin) > self::MAX_ENTRY_LENGTH || strcasecmp($origin, 'null') === 0) {
            return null;
        }

        if (preg_match('~^(https?)://([^/?#@\\\\\s%\x00-\x1f\x7f]+)$~iD', $origin, $parts) !== 1) {
            return null;
        }

        $scheme = strtolower($parts[1]);
        $host = $this->parseAuthority($parts[2], allowWildcard: false);

        if ($host === null) {
            return null;
        }

        $port = $host['port'];

        if ($port === $this->defaultPort($scheme)) {
            $port = null;
        }

        return ['scheme' => $scheme, 'host' => $host['host'], 'port' => $port];
    }

    /**
     * The origin (`scheme://host[:port]`) of a full URL such as a `Referer`, or null when it has none or hides userinfo.
     */
    public function originFromUrl(?string $url): ?string
    {
        if ($url === null || $url === '' || strlen($url) > 4096) {
            return null;
        }

        $parts = parse_url($url);

        if ($parts === false || ! isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass'])) {
            return null;
        }

        $origin = strtolower($parts['scheme']).'://'.$parts['host'].(isset($parts['port']) ? ':'.$parts['port'] : '');

        return $this->parseOrigin($origin) === null ? null : $origin;
    }

    /**
     * `frame-ancestors` source list for the allowed entries (`'none'` when nothing may embed the page).
     *
     * @param  iterable<string>  $entries
     */
    public function frameAncestors(iterable $entries): string
    {
        $sources = [];

        foreach ($entries as $entry) {
            $normalised = $this->normalizeEntry($entry);

            if ($normalised !== null) {
                $sources[$normalised] = $normalised;
            }
        }

        return $sources === [] ? "'none'" : implode(' ', $sources);
    }

    /**
     * @param  ParsedHost  $entry
     * @param  ParsedOrigin  $origin
     */
    private function covers(array $entry, array $origin): bool
    {
        $originPort = $origin['port'] ?? $this->defaultPort($origin['scheme']);
        $entryPort = $entry['port'] ?? $this->defaultPort($origin['scheme']);

        if ($originPort !== $entryPort) {
            return false;
        }

        if ($entry['wildcard']) {
            return str_ends_with($origin['host'], '.'.$entry['host']);
        }

        return hash_equals($entry['host'], $origin['host']);
    }

    /**
     * @return ParsedHost|null
     */
    private function parseEntry(string $input): ?array
    {
        $value = trim($input);

        if ($value === '' || strlen($value) > self::MAX_ENTRY_LENGTH || preg_match('~[\s\x00-\x1f\x7f\\\\%@?#]~', $value) === 1) {
            return null;
        }

        $scheme = null;

        if (preg_match('~^([a-z][a-z0-9+.\-]*)://(.*)$~iD', $value, $parts) === 1) {
            $scheme = strtolower($parts[1]);
            $value = $parts[2];

            if (! in_array($scheme, ['http', 'https'], true)) {
                return null;
            }
        }

        if (str_ends_with($value, '/')) {
            $value = substr($value, 0, -1);
        }

        if (str_contains($value, '/')) {
            return null;
        }

        $parsed = $this->parseAuthority($value, allowWildcard: true);

        if ($parsed === null) {
            return null;
        }

        // `https://example.com:443` is just `example.com`.
        if ($scheme !== null && $parsed['port'] === $this->defaultPort($scheme)) {
            $parsed['port'] = null;
        }

        $parsed['scheme'] = $scheme;

        return $parsed;
    }

    /**
     * Parse `host[:port]` (bracketed IPv6 supported) into a normalised lower-case punycode host.
     *
     * @return array{host: string, port: int|null, wildcard: bool, scheme: string|null}|null
     */
    private function parseAuthority(string $authority, bool $allowWildcard): ?array
    {
        if ($authority === '') {
            return null;
        }

        $port = null;

        if ($authority[0] === '[') {
            $end = strpos($authority, ']');

            if ($end === false) {
                return null;
            }

            $literal = substr($authority, 1, $end - 1);
            $rest = substr($authority, $end + 1);

            if (filter_var($literal, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) === false) {
                return null;
            }

            if ($rest !== '') {
                $port = $this->parsePort($rest);

                if ($port === null) {
                    return null;
                }
            }

            return ['host' => '['.strtolower($literal).']', 'port' => $port, 'wildcard' => false, 'scheme' => null];
        }

        $colon = strpos($authority, ':');

        if ($colon !== false) {
            $port = $this->parsePort(substr($authority, $colon));

            if ($port === null) {
                return null;
            }

            $authority = substr($authority, 0, $colon);
        }

        $wildcard = false;

        if (str_starts_with($authority, '*.')) {
            if (! $allowWildcard) {
                return null;
            }

            $wildcard = true;
            $authority = substr($authority, 2);
        }

        $host = $this->normalizeHostname($authority);

        if ($host === null) {
            return null;
        }

        $isIp = filter_var($host, FILTER_VALIDATE_IP) !== false;

        // A wildcard needs a base with at least two labels (never `*.com`) and cannot apply to an IP address.
        if ($wildcard && ($isIp || ! str_contains($host, '.'))) {
            return null;
        }

        return ['host' => $host, 'port' => $port, 'wildcard' => $wildcard, 'scheme' => null];
    }

    private function parsePort(string $segment): ?int
    {
        if (preg_match('/^:([0-9]{1,5})$/D', $segment, $parts) !== 1) {
            return null;
        }

        $port = (int) $parts[1];

        return $port >= 1 && $port <= 65535 ? $port : null;
    }

    private function normalizeHostname(string $hostname): ?string
    {
        if ($hostname === '' || str_contains($hostname, '*')) {
            return null;
        }

        if (str_ends_with($hostname, '.')) {
            $hostname = substr($hostname, 0, -1);
        }

        if ($hostname === '') {
            return null;
        }

        $ascii = idn_to_ascii($hostname, IDNA_NONTRANSITIONAL_TO_ASCII, INTL_IDNA_VARIANT_UTS46, $info);

        if ($ascii === false || ($info['errors'] ?? 0) !== 0) {
            return null;
        }

        $ascii = strtolower($ascii);

        if ($ascii === '' || strlen($ascii) > 253) {
            return null;
        }

        foreach (explode('.', $ascii) as $label) {
            if (preg_match('/^(?!-)[a-z0-9-]{1,63}(?<!-)$/D', $label) !== 1) {
                return null;
            }
        }

        $labels = explode('.', $ascii);
        $last = end($labels);

        // Dotted numbers must be real IPv4 addresses; an all-numeric TLD is never a hostname.
        if (preg_match('/^[0-9]+$/D', $last) === 1 && filter_var($ascii, FILTER_VALIDATE_IP, FILTER_FLAG_IPV4) === false) {
            return null;
        }

        return $ascii;
    }

    private function defaultPort(string $scheme): int
    {
        return $scheme === 'https' ? 443 : 80;
    }
}
