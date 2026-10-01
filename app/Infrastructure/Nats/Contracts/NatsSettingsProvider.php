<?php

namespace App\Infrastructure\Nats\Contracts;

use App\Infrastructure\Nats\ConfigNatsSettingsProvider;
use App\Infrastructure\Nats\NatsSettings;
use Illuminate\Container\Attributes\Bind;

/**
 * Supplies the NATS settings of the ACTIVE auth environment. Track 2B ships a config-backed default;
 * track 2A binds the database-backed implementation (auth_environments + settings).
 *
 * The #[Bind] attribute is only the fallback: an explicit container binding (track 2A) always wins.
 */
#[Bind(ConfigNatsSettingsProvider::class)]
interface NatsSettingsProvider
{
    /** Null when NATS is not configured. */
    public function current(): ?NatsSettings;
}
