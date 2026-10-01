<?php

namespace App\Infrastructure\Nats;

use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use Illuminate\Contracts\Config\Repository;

/**
 * Default NatsSettingsProvider: reads `config/nats.php` (env-backed). Used in dev and tests; production binds
 * the database-backed provider of the pizzasys auth driver instead.
 */
final class ConfigNatsSettingsProvider implements NatsSettingsProvider
{
    public function __construct(private readonly Repository $config) {}

    public function current(): ?NatsSettings
    {
        $url = $this->text('nats.url');

        if ($url === null) {
            return null;
        }

        return new NatsSettings(
            enabled: (bool) $this->config->get('nats.enabled', false),
            url: $url,
            token: $this->text('nats.token'),
            stream: $this->text('nats.stream') ?? 'AUTH_EVENTS',
            ensureStream: (bool) $this->config->get('nats.ensure_stream', true),
            environmentKey: $this->text('nats.environment_key') ?? 'production',
            tlsCaFile: $this->text('nats.tls_ca_file'),
        );
    }

    private function text(string $key): ?string
    {
        $value = $this->config->get($key);

        return is_string($value) && trim($value) !== '' ? trim($value) : null;
    }
}
