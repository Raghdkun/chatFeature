<?php

namespace App\Domain\Widgets\Support;

/**
 * Collapses a client address into the unit rate limits are applied to: an IPv4 address stays itself, an IPv6 address
 * becomes its /64 (one subscriber usually owns a whole /64, so per-address buckets would let one host dodge a limit
 * by rotating addresses), and an IPv4-mapped IPv6 address (`::ffff:203.0.113.9`) is the IPv4 address it wraps.
 */
final class ClientNetwork
{
    /**
     * A keyed hash (HMAC-SHA256, hex) of the network bucket: it lets two sessions from the same network be matched without keeping the
     * address itself (and without a table of all IPv4 addresses being enough to reverse it: the key is the application key).
     */
    public static function fingerprint(?string $ip): string
    {
        return hash_hmac('sha256', self::bucket($ip), (string) config('app.key'));
    }

    public static function bucket(?string $ip): string
    {
        if ($ip === null || $ip === '') {
            return 'unknown';
        }

        $packed = @inet_pton($ip);

        if ($packed === false) {
            return 'unknown';
        }

        if (strlen($packed) === 4) {
            return $ip;
        }

        if (str_starts_with($packed, str_repeat("\0", 10)."\xff\xff")) {
            return (string) inet_ntop(substr($packed, 12));
        }

        return (string) inet_ntop(substr($packed, 0, 8).str_repeat("\0", 8)).'/64';
    }
}
