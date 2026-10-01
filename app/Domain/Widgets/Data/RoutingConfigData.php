<?php

namespace App\Domain\Widgets\Data;

use App\Domain\Widgets\Enums\RoutingStatus;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `config.routing`: server-side policy only, never sent to visitors.
 * `queueTimeoutSeconds` mirrors `widgets.queue_timeout_seconds` (authoritative).
 */
#[TypeScript]
class RoutingConfigData extends Data
{
    /**
     * @param  array<int, RoutingWaveData>  $waves
     */
    public function __construct(
        public array $waves = [
            new RoutingWaveData(0, [RoutingStatus::Online]),
            new RoutingWaveData(20, [RoutingStatus::Away]),
        ],
        public bool $wakeOfflineViaPush = false,
        public int $queueTimeoutSeconds = 90,
    ) {}
}
