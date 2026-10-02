<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Offline tickets: created, answered (first agent reply) and closed in the range, and the average time from creation to the first reply. */
#[TypeScript]
class AnalyticsOfflineData extends Data
{
    public function __construct(
        public ?int $created,
        public int $answered,
        public ?int $closed,
        public ?float $averageResponseSeconds,
    ) {}
}
