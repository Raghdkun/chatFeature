<?php

namespace Tests\Support\Nats;

use App\Infrastructure\Nats\Contracts\NatsSettingsProvider;
use App\Infrastructure\Nats\NatsSettings;

final class FakeNatsSettingsProvider implements NatsSettingsProvider
{
    public int $reads = 0;

    public function __construct(public ?NatsSettings $current = null) {}

    public function current(): ?NatsSettings
    {
        $this->reads++;

        return $this->current;
    }
}
