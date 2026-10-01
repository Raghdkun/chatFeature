<?php

namespace App\Domain\Install;

use Illuminate\Contracts\Config\Repository;

/**
 * Until the install lock exists there may be no database, Redis or websocket server, so the
 * runtime drivers are forced to file / file / sync / null. Once installed this class does nothing
 * and the real drivers from `.env` apply untouched (`.env` is never rewritten).
 */
final class InstallAwareConfig
{
    /** @var array<string, mixed> */
    private array $original = [];

    public function __construct(
        private readonly Repository $config,
        private readonly InstallState $state,
    ) {}

    /**
     * @return bool Whether the pre-install drivers were forced.
     */
    public function apply(): bool
    {
        if ($this->state->isInstalled()) {
            return false;
        }

        /** @var array<string, string> $forced */
        $forced = $this->config->get('install.forced_drivers', []);

        foreach ($forced as $key => $value) {
            $this->original[$key] ??= $this->config->get($key);
            $this->config->set($key, $value);
        }

        return true;
    }

    /** Put the configured (`.env`) drivers back, e.g. right after the lock was written in-process. */
    public function restore(): void
    {
        foreach ($this->original as $key => $value) {
            $this->config->set($key, $value);
        }

        $this->original = [];
    }

    /** The driver `.env` asked for, before it was forced (null if nothing was overridden). */
    public function original(string $key): mixed
    {
        return $this->original[$key] ?? null;
    }

    /**
     * Whether any configured (pre-override) driver is Redis-backed.
     */
    public function usesRedis(): bool
    {
        foreach (['session.driver', 'cache.default', 'queue.default'] as $key) {
            $value = $this->original[$key] ?? $this->config->get($key);

            if ($value === 'redis') {
                return true;
            }
        }

        return false;
    }
}
