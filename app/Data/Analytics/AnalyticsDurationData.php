<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A duration metric over a range: the exact average (sum of seconds / samples), the longest and how many samples there were. */
#[TypeScript]
class AnalyticsDurationData extends Data
{
    public function __construct(
        public ?float $averageSeconds,
        public int $maxSeconds,
        public int $count,
    ) {}
}
