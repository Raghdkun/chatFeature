<?php

namespace App\Auth\Pizzasys;

use App\Auth\Pizzasys\Results\PortalClaims;
use App\Auth\Pizzasys\Results\PortalVerifyResult;
use App\Domain\Settings\SettingsRepository;
use Illuminate\Cache\ArrayStore;
use Illuminate\Cache\Repository as CacheRepository;
use Illuminate\Contracts\Cache\Factory as CacheFactory;
use Illuminate\Contracts\Cache\Lock;
use Illuminate\Contracts\Cache\LockProvider;
use Illuminate\Contracts\Cache\Repository;
use SensitiveParameter;

/**
 * Short-lived cache of `token-verify` answers, keyed by sha256(user token) so the token itself never lands in
 * the cache. A generation number is part of every key: bumping it drops every cached answer at once.
 *
 * Positive answers live `auth.pizzasys.verify_ttl_seconds`; negative answers (`active:false`) only
 * NEGATIVE_TTL_SECONDS. Single-flight: `lockFor()` hands out a per-token lock so that concurrent requests
 * for the same session wait for one upstream call instead of stampeding the portal.
 */
final class VerifyCache
{
    public const NEGATIVE_TTL_SECONDS = 15;

    public const LOCK_SECONDS = 10;

    private const GENERATION_KEY = 'auth.verify.generation';

    public function __construct(
        private readonly CacheFactory $cache,
        private readonly SettingsRepository $settings,
    ) {}

    public function get(string $environment, #[SensitiveParameter] string $token): ?PortalVerifyResult
    {
        $value = $this->store()->get($this->key($environment, $token));

        if (! is_array($value)) {
            return null;
        }

        if (($value['active'] ?? null) === false) {
            return PortalVerifyResult::inactive()->cached();
        }

        $claims = PortalClaims::fromArray(is_array($value['claims'] ?? null) ? $value['claims'] : []);

        return $claims !== null ? PortalVerifyResult::active($claims)->cached() : null;
    }

    public function putActive(string $environment, #[SensitiveParameter] string $token, PortalClaims $claims): void
    {
        $ttl = max(1, $this->settings->int('auth.pizzasys.verify_ttl_seconds', 60));

        $this->store()->put($this->key($environment, $token), ['active' => true, 'claims' => $claims->toArray()], $ttl);
    }

    public function putInactive(string $environment, #[SensitiveParameter] string $token): void
    {
        $this->store()->put($this->key($environment, $token), ['active' => false], self::NEGATIVE_TTL_SECONDS);
    }

    public function forget(string $environment, #[SensitiveParameter] string $token): void
    {
        $this->store()->forget($this->key($environment, $token));
    }

    /** Drop every cached answer (role/permission/store changes upstream, role mapping changes). */
    public function flushAll(): void
    {
        $store = $this->store();
        $store->add(self::GENERATION_KEY, 1);
        $store->increment(self::GENERATION_KEY);
    }

    public function lockFor(string $environment, #[SensitiveParameter] string $token): Lock
    {
        $name = 'auth.verify.lock.'.$environment.'.'.hash('sha256', $token);

        /** @var CacheRepository $repository */
        $repository = $this->store();
        $store = $repository->getStore();

        // Every production cache store can lock; a store that cannot gets a private (process-local) lock.
        return ($store instanceof LockProvider ? $store : new ArrayStore)->lock($name, self::LOCK_SECONDS);
    }

    private function key(string $environment, #[SensitiveParameter] string $token): string
    {
        $generation = $this->store()->get(self::GENERATION_KEY, 1);

        return 'auth.verify.'.(is_numeric($generation) ? (int) $generation : 1).'.'.$environment.'.'.hash('sha256', $token);
    }

    private function store(): Repository
    {
        return $this->cache->store();
    }
}
