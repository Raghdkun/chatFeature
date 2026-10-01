<?php

namespace App\Auth\Pizzasys;

use Carbon\CarbonImmutable;
use Illuminate\Contracts\Cache\Factory as CacheFactory;

/**
 * Reads (never writes) what the NATS event consumer reports through the default cache store:
 * `auth.nats.heartbeat_at`, `auth.nats.last_event_at` (ISO timestamps) and `auth.nats.connected` (bool).
 */
final class NatsHealth
{
    /** A heartbeat older than this means the consumer is not running. */
    public const HEARTBEAT_STALE_SECONDS = 120;

    public function __construct(private readonly CacheFactory $cache) {}

    /**
     * @return bool|null null = no heartbeat seen yet (unknown)
     */
    public function connected(): ?bool
    {
        $store = $this->cache->store();
        $heartbeat = $this->time($store->get('auth.nats.heartbeat_at'));

        if ($heartbeat === null) {
            return null;
        }

        if ($heartbeat->lessThan(now()->subSeconds(self::HEARTBEAT_STALE_SECONDS))) {
            return false;
        }

        return (bool) $store->get('auth.nats.connected', false);
    }

    public function lastEventAt(): ?string
    {
        return $this->time($this->cache->store()->get('auth.nats.last_event_at'))?->toIso8601String();
    }

    private function time(mixed $value): ?CarbonImmutable
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        try {
            return CarbonImmutable::parse($value);
        } catch (\Throwable) {
            return null;
        }
    }
}
