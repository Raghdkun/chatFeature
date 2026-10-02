<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One metric over time. `unit` is `count`, `seconds`, `score` (1-5) or `ratio` (0-1). */
#[TypeScript]
class AnalyticsSeriesData extends Data
{
    /**
     * @param  list<AnalyticsPointData>  $points
     */
    public function __construct(
        public string $metric,
        public string $unit,
        public array $points,
    ) {}
}
