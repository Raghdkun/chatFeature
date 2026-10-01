<?php

namespace App\Infrastructure\Nats;

use Carbon\CarbonImmutable;
use Carbon\CarbonInterface;
use Illuminate\Contracts\Cache\Repository;
use Throwable;

/**
 * The consumer's shared status, kept in the default cache store (contract: docs/contracts/auth-pizzasys.md).
 * Written by the consumer process, read by the Settings > Auth health card. Flags expire on their own so a dead
 * consumer cannot keep reporting "connected".
 */
final class NatsStatusStore
{
    /** ISO-8601; refreshed on every poll cycle. */
    public const HEARTBEAT_AT = 'auth.nats.heartbeat_at';

    /** ISO-8601; the last event received (any outcome). */
    public const LAST_EVENT_AT = 'auth.nats.last_event_at';

    /** bool; true only while a session is established. */
    public const CONNECTED = 'auth.nats.connected';

    /** int; incremented by the auth settings code to make the consumer reconnect with fresh settings. */
    public const RESTART = 'auth.nats.restart';

    private const HEARTBEAT_TTL = 600;

    private const CONNECTED_TTL = 120;

    private const LAST_EVENT_TTL = 2_592_000;

    public function __construct(private readonly Repository $cache) {}

    public function heartbeat(CarbonInterface $now): void
    {
        $this->write(self::HEARTBEAT_AT, $now->toIso8601String(), self::HEARTBEAT_TTL);
    }

    public function eventReceived(CarbonInterface $now): void
    {
        $this->write(self::LAST_EVENT_AT, $now->toIso8601String(), self::LAST_EVENT_TTL);
    }

    public function setConnected(bool $connected): void
    {
        $this->write(self::CONNECTED, $connected, self::CONNECTED_TTL);
    }

    public function restartToken(): int
    {
        try {
            $value = $this->cache->get(self::RESTART, 0);
        } catch (Throwable) {
            return 0;
        }

        return is_numeric($value) ? (int) $value : 0;
    }

    public function connected(): ?bool
    {
        $value = $this->cache->get(self::CONNECTED);

        return is_bool($value) ? $value : null;
    }

    public function heartbeatAt(): ?CarbonImmutable
    {
        return $this->timestamp(self::HEARTBEAT_AT);
    }

    public function lastEventAt(): ?CarbonImmutable
    {
        return $this->timestamp(self::LAST_EVENT_AT);
    }

    /** Status reporting is best effort: a cache outage must never stop event consumption. */
    private function write(string $key, mixed $value, int $ttlSeconds): void
    {
        try {
            $this->cache->put($key, $value, $ttlSeconds);
        } catch (Throwable) {
            // Dropped on purpose; the next write retries.
        }
    }

    private function timestamp(string $key): ?CarbonImmutable
    {
        $value = $this->cache->get($key);

        if (! is_string($value)) {
            return null;
        }

        try {
            return CarbonImmutable::parse($value);
        } catch (Throwable) {
            return null;
        }
    }
}
