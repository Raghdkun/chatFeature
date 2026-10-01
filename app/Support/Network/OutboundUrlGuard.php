<?php

namespace App\Support\Network;

use Illuminate\Contracts\Config\Repository;
use Illuminate\Contracts\Foundation\Application;

/**
 * The one place that decides whether this server may connect to an address an administrator typed in (the auth portal's
 * base URL, its NATS server). The app calls those addresses with a bearer token, so a careless value would turn the
 * "Test connection" button into a request forger for the internal network or the cloud metadata service.
 *
 * What is accepted:
 *  - only canonical literals: a dotted-quad IPv4 (never `2852039166`, `0xA9FEA9FE`, `127.1`, `010.0.0.5`) or a valid
 *    IPv6 in brackets, and host names made of ordinary labels (no numeric top-level label, no stray characters, one
 *    trailing root dot is dropped);
 *  - after resolving the name (through the injectable {@see HostResolver}) EVERY address must be public. Loopback,
 *    private (RFC 1918, unique-local), link-local, CGNAT, unspecified, multicast and the cloud metadata addresses are
 *    refused, IPv4-mapped / NAT64 / 6to4 IPv6 forms are judged by the IPv4 address they carry;
 *  - `PORTAL_ALLOW_PRIVATE_HOSTS` (config `chat.portal_allow_private_hosts`) or APP_ENV=local lifts the loopback /
 *    private / CGNAT refusal for portals that really live on a private network (a Docker network, a VPN). The metadata
 *    addresses, the unspecified address, multicast and link-local ranges are refused regardless;
 *  - plain `http` only in APP_ENV=local, or for localhost / 127.0.0.1 / ::1 / *.test / *.localhost.
 *
 * A refusal is a bare "no": callers show one fixed sentence, never which rule applied or what a name resolved to.
 *
 * Residual risk (documented, not closable here): the verdict is computed from a lookup made just BEFORE the call, and
 * the HTTP client resolves the name again when it connects (a DNS-rebinding window of a few milliseconds). NATS
 * connections and the connection test pin the validated address, HTTP calls pin it through CURLOPT_RESOLVE where the
 * curl handler is in use ({@see OutboundTarget::curlResolveEntry()}).
 */
class OutboundUrlGuard
{
    /** Addresses that are never acceptable, not even with private hosts enabled. */
    private const METADATA_ADDRESSES = ['169.254.169.254', '169.254.170.2', '100.100.100.200', '192.0.0.192', 'fd00:ec2::254'];

    /** Names that are never acceptable. */
    private const METADATA_NAMES = ['metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal', 'metadata.azure.internal'];

    /** Name suffixes that never resolve on the public internet. */
    private const INTERNAL_SUFFIXES = ['.local', '.localhost', '.internal', '.localdomain', '.lan', '.home.arpa', '.intranet', '.corp', '.private', '.home'];

    /** Reserved names that are not real public hosts either (documentation / testing). */
    private const RESERVED_SUFFIXES = ['.test', '.invalid', '.example'];

    public function __construct(
        private readonly HostResolver $resolver,
        private readonly Repository $config,
        private readonly Application $app,
    ) {}

    /**
     * Is this a public DNS name: dotted, ordinary labels, not an IP literal, not a numeric spelling and not on a private
     * or reserved suffix? A lexical check only (no lookup), used to decide whether a host may be shown to visitors.
     */
    public static function isPublicDnsName(string $host): bool
    {
        $host = strtolower(rtrim(trim($host), '.'));

        if ($host === '' || ! str_contains($host, '.') || filter_var($host, FILTER_VALIDATE_IP) !== false || ! self::isValidHostName($host)) {
            return false;
        }

        foreach ([...self::INTERNAL_SUFFIXES, ...self::RESERVED_SUFFIXES] as $suffix) {
            if (str_ends_with($host, $suffix)) {
                return false;
            }
        }

        return true;
    }

    /** Whether private-network targets are allowed at all (a deliberate server setting, or local development). */
    public function allowsPrivateHosts(): bool
    {
        return $this->config->get('chat.portal_allow_private_hosts') === true || $this->app->environment('local');
    }

    /**
     * An http(s) base URL of an auth portal.
     */
    public function checkHttpUrl(string $url): OutboundTarget
    {
        $parts = $this->parse($url, ['http', 'https']);

        if ($parts === null) {
            return OutboundTarget::blocked('malformed');
        }

        [$scheme, $host, $port] = $parts;

        if ($scheme === 'http' && ! $this->app->environment('local') && ! $this->isDevelopmentHost($host)) {
            return OutboundTarget::blocked('plain_http');
        }

        return $this->checkHost($host, $port, $scheme);
    }

    /**
     * A `nats://` or `tls://` address (host and optional port only).
     */
    public function checkNatsUrl(string $url): OutboundTarget
    {
        $parts = $this->parse($url, ['nats', 'tls'], defaultPort: 4222, allowEmptyPath: true);

        return $parts === null ? OutboundTarget::blocked('malformed') : $this->checkHost($parts[1], $parts[2], $parts[0]);
    }

    /**
     * The destination itself, however it was spelled: normalises the host, resolves a name and judges every address.
     */
    public function checkHost(string $host, int $port, string $scheme = 'https'): OutboundTarget
    {
        $host = $this->normaliseHost($host);

        if ($host === null || $port < 1 || $port > 65535) {
            return OutboundTarget::blocked('bad_host');
        }

        if (in_array($host, self::METADATA_NAMES, true)) {
            return OutboundTarget::blocked('metadata_name');
        }

        $literal = $this->literalAddress($host);

        if ($literal !== null) {
            return $this->judge($scheme, $host, $port, [$literal], ipLiteral: true, internalName: false);
        }

        if (! self::isValidHostName($host)) {
            return OutboundTarget::blocked('bad_host');
        }

        $internalName = ! str_contains($host, '.') || $this->hasInternalSuffix($host);

        if ($internalName && ! $this->allowsPrivateHosts()) {
            return OutboundTarget::blocked('internal_name');
        }

        $addresses = array_values(array_unique($this->resolver->resolve($host)));

        if ($addresses === []) {
            return OutboundTarget::blocked('unresolvable');
        }

        return $this->judge($scheme, $host, $port, $addresses, ipLiteral: false, internalName: $internalName);
    }

    /**
     * @param  list<string>  $addresses
     */
    private function judge(string $scheme, string $host, int $port, array $addresses, bool $ipLiteral, bool $internalName): OutboundTarget
    {
        $private = $internalName;
        $canonical = [];

        foreach ($addresses as $address) {
            $class = $this->classify($address);

            if ($class === 'invalid' || $class === 'blocked') {
                return OutboundTarget::blocked('address_'.$class);
            }

            if ($class === 'private') {
                $private = true;
            }

            $canonical[] = $address;
        }

        if ($private && ! $this->allowsPrivateHosts()) {
            return OutboundTarget::blocked('private_address');
        }

        return new OutboundTarget(true, $scheme, $host, $port, $canonical, $ipLiteral, $private);
    }

    /**
     * public | private (loopback, RFC 1918, CGNAT, unique-local ...: allowed only when private hosts are) |
     * blocked (never allowed) | invalid.
     */
    public function classify(string $address): string
    {
        $packed = @inet_pton($address);

        if ($packed === false) {
            return 'invalid';
        }

        if (strlen($packed) === 4) {
            return $this->classifyV4(array_values(unpack('C4', $packed) ?: []), $address);
        }

        return $this->classifyV6($packed, $address);
    }

    /**
     * @param  list<int>  $octets
     */
    private function classifyV4(array $octets, string $text): string
    {
        if (count($octets) !== 4) {
            return 'invalid';
        }

        [$a, $b, $c] = $octets;

        if (in_array($text, self::METADATA_ADDRESSES, true)) {
            return 'blocked';
        }

        return match (true) {
            $a === 0, $a >= 224 => 'blocked',                      // this network / unspecified, multicast, reserved, broadcast
            $a === 169 && $b === 254 => 'blocked',                 // link-local (cloud metadata lives here)
            $a === 192 && $b === 0 && $c === 0 => 'blocked',       // IETF protocol assignments (one cloud's metadata address)
            $a === 127 => 'private',                               // loopback
            $a === 10 => 'private',
            $a === 172 && $b >= 16 && $b <= 31 => 'private',
            $a === 192 && $b === 168 => 'private',
            $a === 100 && $b >= 64 && $b <= 127 => 'private',      // carrier-grade NAT
            $a === 198 && ($b === 18 || $b === 19) => 'private',  // benchmarking
            default => 'public',
        };
    }

    private function classifyV6(string $packed, string $text): string
    {
        $bytes = array_values(unpack('C16', $packed) ?: []);

        if (count($bytes) !== 16) {
            return 'invalid';
        }

        $normalised = (string) inet_ntop($packed);

        if (in_array($normalised, self::METADATA_ADDRESSES, true)) {
            return 'blocked';
        }

        if ($packed === str_repeat("\0", 16)) {
            return 'blocked';                                       // ::
        }

        if ($packed === str_repeat("\0", 15)."\x01") {
            return 'private';                                       // ::1
        }

        $firstTen = array_sum(array_slice($bytes, 0, 10)) === 0;
        $mapped = $firstTen && $bytes[10] === 0xFF && $bytes[11] === 0xFF;           // ::ffff:a.b.c.d
        $compatible = array_sum(array_slice($bytes, 0, 12)) === 0;                   // ::a.b.c.d
        $nat64 = $bytes[0] === 0x00 && $bytes[1] === 0x64 && $bytes[2] === 0xFF && $bytes[3] === 0x9B && array_sum(array_slice($bytes, 4, 8)) === 0; // 64:ff9b::/96

        if ($mapped || $compatible || $nat64) {
            return $this->classifyV4(array_slice($bytes, 12, 4), implode('.', array_slice($bytes, 12, 4)));
        }

        if ($bytes[0] === 0x20 && $bytes[1] === 0x02) {             // 6to4 2002::/16 carries an IPv4 address in bytes 2-5
            return $this->classifyV4(array_slice($bytes, 2, 4), implode('.', array_slice($bytes, 2, 4)));
        }

        return match (true) {
            $bytes[0] === 0xFF => 'blocked',                                              // multicast
            $bytes[0] === 0xFE && ($bytes[1] & 0xC0) === 0x80 => 'blocked',               // fe80::/10 link-local
            $bytes[0] === 0xFE && ($bytes[1] & 0xC0) === 0xC0 => 'private',               // fec0::/10 site-local (deprecated)
            ($bytes[0] & 0xFE) === 0xFC => 'private',                                     // fc00::/7 unique-local
            default => 'public',
        };
    }

    /**
     * Scheme, normalised host and port of a URL, or null when it is not a plain `scheme://host[:port][/path]`.
     *
     * @param  list<string>  $schemes
     * @return array{0: string, 1: string, 2: int}|null
     */
    private function parse(string $url, array $schemes, int $defaultPort = 0, bool $allowEmptyPath = false): ?array
    {
        // Whatever the URL parser and the HTTP client might read differently: refuse it.
        if ($url === '' || strlen($url) > 255 || preg_match('/[^\x21-\x7e]|[\\\\@#?]/', $url) === 1) {
            return null;
        }

        $parts = parse_url($url);

        if ($parts === false || ! isset($parts['scheme'], $parts['host']) || isset($parts['user']) || isset($parts['pass']) || isset($parts['query']) || isset($parts['fragment'])) {
            return null;
        }

        $scheme = strtolower($parts['scheme']);

        if (! in_array($scheme, $schemes, true)) {
            return null;
        }

        if ($allowEmptyPath && isset($parts['path']) && $parts['path'] !== '' && $parts['path'] !== '/') {
            return null;
        }

        $port = $parts['port'] ?? ($defaultPort > 0 ? $defaultPort : ($scheme === 'http' ? 80 : 443));

        return [$scheme, $parts['host'], $port];
    }

    /** Lower-case, brackets of an IPv6 literal removed, one trailing root dot dropped; null when it cannot be a host. */
    private function normaliseHost(string $host): ?string
    {
        $host = strtolower(trim($host));

        if (str_starts_with($host, '[') && str_ends_with($host, ']')) {
            $host = substr($host, 1, -1);

            return filter_var($host, FILTER_VALIDATE_IP, FILTER_FLAG_IPV6) !== false ? $host : null;
        }

        if (str_ends_with($host, '.')) {
            $host = substr($host, 0, -1);
        }

        return $host === '' || strlen($host) > 253 ? null : $host;
    }

    /** The canonical IP literal behind this host, or null when it is a name. Numeric look-alikes are not names either. */
    private function literalAddress(string $host): ?string
    {
        if (filter_var($host, FILTER_VALIDATE_IP) !== false) {
            return $host;
        }

        return null;
    }

    private static function isValidHostName(string $host): bool
    {
        if (preg_match('/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/', $host) !== 1) {
            return false;
        }

        $labels = explode('.', $host);
        $last = end($labels);

        // `2852039166`, `127.1`, `0xA9FEA9FE`, `1.2.3.4.5`: numeric spellings of addresses, never host names.
        return preg_match('/^(\d+|0x[0-9a-f]*)$/', $last) !== 1;
    }

    private function hasInternalSuffix(string $host): bool
    {
        foreach (self::INTERNAL_SUFFIXES as $suffix) {
            if (str_ends_with($host, $suffix)) {
                return true;
            }
        }

        return false;
    }

    /** Hosts that may be reached over plain http: localhost, loopback and the reserved `.test` / `.localhost` names. */
    private function isDevelopmentHost(string $host): bool
    {
        $host = $this->normaliseHost($host) ?? '';

        return in_array($host, ['localhost', '127.0.0.1', '::1'], true) || str_ends_with($host, '.test') || str_ends_with($host, '.localhost');
    }
}
