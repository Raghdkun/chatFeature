<?php

namespace App\Auth\Pizzasys;

use App\Domain\Install\InstallState;
use App\Domain\Settings\SettingsRepository;
use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\NatsSettings;

/**
 * The NATS block of the ACTIVE auth environment (`auth_environments` + `auth.pizzasys.nats.*` settings), for the
 * event consumer. Null before the install, outside mode 2, and while the active environment has no NATS URL.
 */
final class DatabaseNatsSettingsProvider implements NatsSettingsProvider
{
    public function __construct(
        private readonly InstallState $install,
        private readonly SettingsRepository $settings,
        private readonly AuthEnvironmentRepository $environments,
    ) {}

    public function current(): ?NatsSettings
    {
        if (! $this->install->isInstalled() || $this->settings->string('auth.mode', 'fortify') !== 'pizzasys') {
            return null;
        }

        $environment = $this->environments->active();

        if ($environment === null || $environment->nats_url === null || $environment->nats_url === '') {
            return null;
        }

        return new NatsSettings(
            enabled: $this->settings->bool('auth.pizzasys.nats.enabled'),
            url: $environment->nats_url,
            token: $environment->nats_token,
            stream: $environment->nats_stream,
            ensureStream: $this->settings->bool('auth.pizzasys.nats.ensure_stream', true),
            environmentKey: $environment->key,
            tlsCaFile: is_string($ca = config('nats.tls_ca_file')) && trim($ca) !== '' ? trim($ca) : null,
            verifyTls: $environment->verify_tls,
        );
    }
}
