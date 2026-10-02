<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** One bucket of a series: `date` is its first day, `days` how many days of the bucket lie inside the range, `value` is `null` when there was nothing to average. */
#[TypeScript]
class AnalyticsPointData extends Data
{
    public function __construct(
        public string $date,
        public ?float $value,
        public int $days,
    ) {}
}
