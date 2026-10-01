<?php

namespace App\Auth\Pizzasys;

use App\Domain\Settings\SettingsRepository;
use App\Models\AuthEnvironment;
use Illuminate\Support\Collection;

/**
 * Reads the configured portal environments and knows which one is active. Decrypted tokens exist only in the
 * {@see PizzasysEndpoint} value objects it hands out, for the duration of one call.
 */
final class AuthEnvironmentRepository
{
    public function __construct(private readonly SettingsRepository $settings) {}

    /** `production` or `testing`, whichever `auth.pizzasys.active_env` says (anything else counts as production). */
    public function activeKey(): string
    {
        $key = $this->settings->get('auth.pizzasys.active_env', AuthEnvironment::PRODUCTION);

        return is_string($key) && in_array($key, AuthEnvironment::KEYS, true) ? $key : AuthEnvironment::PRODUCTION;
    }

    public function active(): ?AuthEnvironment
    {
        return $this->find($this->activeKey());
    }

    public function activeEndpoint(): ?PizzasysEndpoint
    {
        return $this->active()?->endpoint();
    }

    public function find(string $key): ?AuthEnvironment
    {
        return AuthEnvironment::query()->where('key', $key)->first();
    }

    /**
     * @return Collection<string, AuthEnvironment> Keyed by environment key.
     */
    public function all(): Collection
    {
        return AuthEnvironment::query()->get()->keyBy('key');
    }

    /**
     * Keep `auth.pizzasys.nats.enabled` in step with the ACTIVE environment: the consumer only runs when that
     * environment has a NATS URL.
     */
    public function syncNatsEnabled(): void
    {
        $url = $this->active()?->nats_url;
        $enabled = $url !== null && $url !== '';

        if ($this->settings->bool('auth.pizzasys.nats.enabled') !== $enabled) {
            $this->settings->set('auth.pizzasys.nats.enabled', $enabled);
        }
    }
}
