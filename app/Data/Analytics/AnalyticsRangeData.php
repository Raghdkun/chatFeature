<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** An inclusive range of days (`Y-m-d`, counted in the application time zone). */
#[TypeScript]
class AnalyticsRangeData extends Data
{
    public function __construct(
        public string $from,
        public string $to,
        public int $days,
    ) {}
}
