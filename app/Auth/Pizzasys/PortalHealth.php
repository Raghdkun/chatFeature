<?php

namespace App\Auth\Pizzasys;

use Carbon\CarbonImmutable;
use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Cache\Repository;

/**
 * What the app has observed about the portal lately (cache only, never the database): last good verify, last
 * failure and whether the service credential is currently being rejected. Feeds `AuthDriver::health()` and the
 * Settings > Auth health card.
 */
final class PortalHealth
{
    /** How long a rejected-credential finding short-circuits calls before the portal is asked again. */
    public const SERVICE_REJECTED_SECONDS = 60;

    private const OBSERVATION_TTL_SECONDS = 604800;

    private const FAILURE_RELEVANT_SECONDS = 600;

    public function __construct(
        private readonly CacheFactory $cache,
        private readonly PizzasysCircuitBreaker $breaker,
    ) {}

    public function markOk(string $environment): void
    {
        $store = $this->store();
        $store->put($this->key($environment, 'last_ok_at'), now()->format(DATE_RFC3339_EXTENDED), self::OBSERVATION_TTL_SECONDS);
        $store->forget($this->key($environment, 'service_rejected'));
    }

    public function markFailure(string $environment, string $reason): void
    {
        $this->store()->put($this->key($environment, 'last_failure'), ['at' => now()->format(DATE_RFC3339_EXTENDED), 'reason' => $reason], self::OBSERVATION_TTL_SECONDS);
    }

    public function markServiceRejected(string $environment, ?string $message): void
    {
        $this->store()->put(
            $this->key($environment, 'service_rejected'),
            ['at' => now()->toIso8601String(), 'message' => $message],
            self::SERVICE_REJECTED_SECONDS,
        );
    }

    public function clearServiceRejected(string $environment): void
    {
        $this->store()->forget($this->key($environment, 'service_rejected'));
    }

    /**
     * @return array{at: string, message: string|null}|null Set while the portal is rejecting our service credential.
     */
    public function serviceRejection(string $environment): ?array
    {
        $value = $this->store()->get($this->key($environment, 'service_rejected'));

        if (! is_array($value) || ! is_string($value['at'] ?? null)) {
            return null;
        }

        return ['at' => $value['at'], 'message' => is_string($value['message'] ?? null) ? $value['message'] : null];
    }

    public function lastVerifyAt(string $environment): ?CarbonImmutable
    {
        return $this->time($this->store()->get($this->key($environment, 'last_ok_at')));
    }

    /**
     * @return 'ok'|'degraded'|'down'|'unknown'
     */
    public function status(string $environment): string
    {
        if ($this->breaker->isOpen($environment)) {
            return 'down';
        }

        if ($this->serviceRejection($environment) !== null) {
            return 'degraded';
        }

        $lastOk = $this->lastVerifyAt($environment);
        $failure = $this->store()->get($this->key($environment, 'last_failure'));
        $failedAt = is_array($failure) ? $this->time($failure['at'] ?? null) : null;

        if ($failedAt !== null
            && $failedAt->greaterThan(now()->subSeconds(self::FAILURE_RELEVANT_SECONDS))
            && ($lastOk === null || $failedAt->greaterThan($lastOk))) {
            return 'degraded';
        }

        return $lastOk !== null ? 'ok' : 'unknown';
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

    private function key(string $environment, string $part): string
    {
        return "auth.portal.{$environment}.{$part}";
    }

    private function store(): Repository
    {
        return $this->cache->store();
    }
}
