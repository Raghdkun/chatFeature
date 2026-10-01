<?php

namespace App\Infrastructure\Nats\Contracts;

use App\Infrastructure\Nats\NatsSettings;

/**
 * Supplies the NATS settings of the ACTIVE auth environment. Track 2B ships a config-backed default;
 * track 2A binds the database-backed implementation (auth_environments + settings).
 */
interface NatsSettingsProvider
{
    /** Null when NATS is not configured. */
    public function current(): ?NatsSettings;
}
