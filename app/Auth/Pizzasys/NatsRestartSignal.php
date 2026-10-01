<?php

namespace App\Auth\Pizzasys;

use Illuminate\Contracts\Cache\Factory as CacheFactory;

/**
 * The NATS consumer (track 2B) polls the integer cache key `auth.nats.restart` and reconnects whenever it changes.
 * Bumped whenever the active environment or its NATS settings change.
 */
final class NatsRestartSignal
{
    public const KEY = 'auth.nats.restart';

    public function __construct(private readonly CacheFactory $cache) {}

    public function request(): void
    {
        $store = $this->cache->store();
        $store->add(self::KEY, 0);
        $store->increment(self::KEY);
    }
}
