<?php

namespace App\Auth\Pizzasys;

use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Cache\Repository;
use Illuminate\Support\Facades\Log;

/**
 * Cache-backed circuit breaker per portal environment: FAILURE_THRESHOLD failures within WINDOW_SECONDS
 * open the circuit for OPEN_SECONDS, during which the portal is not called at all (callers answer
 * "unavailable" immediately instead of every request waiting for a timeout). Any success resets the count.
 */
final class PizzasysCircuitBreaker
{
    public const FAILURE_THRESHOLD = 5;

    public const WINDOW_SECONDS = 30;

    public const OPEN_SECONDS = 30;

    public function __construct(private readonly CacheFactory $cache) {}

    public function isOpen(string $environment): bool
    {
        return $this->store()->has($this->key($environment, 'open'));
    }

    /**
     * Only a portal that is down counts: timeout, connection or TLS error, 5xx (see PortalFailure::countsAgainstBreaker;
     * the gateway never reports a 401 / 422 / 429 or an `active:false` here).
     */
    public function recordFailure(string $environment): void
    {
        $store = $this->store();
        $failures = $this->key($environment, 'failures');

        $store->add($failures, 0, self::WINDOW_SECONDS);
        $count = $store->increment($failures);

        if (is_int($count) && $count >= self::FAILURE_THRESHOLD) {
            $store->put($this->key($environment, 'open'), now()->toIso8601String(), self::OPEN_SECONDS);
            $store->forget($failures);

            Log::warning('Auth portal circuit opened after repeated failures.', ['environment' => $environment, 'open_seconds' => self::OPEN_SECONDS]);
        }
    }

    public function recordSuccess(string $environment): void
    {
        $this->store()->forget($this->key($environment, 'failures'));
    }

    public function failures(string $environment): int
    {
        $value = $this->store()->get($this->key($environment, 'failures'), 0);

        return is_numeric($value) ? (int) $value : 0;
    }

    /** Test/ops helper: close the circuit right away. */
    public function reset(string $environment): void
    {
        $this->store()->forget($this->key($environment, 'failures'));
        $this->store()->forget($this->key($environment, 'open'));
    }

    private function key(string $environment, string $part): string
    {
        return "auth.breaker.{$environment}.{$part}";
    }

    private function store(): Repository
    {
        return $this->cache->store();
    }
}
