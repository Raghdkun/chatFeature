<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET /analytics/breakdown` (administrators only): every widget, topic or agent that had activity in the range, busiest first. */
#[TypeScript]
class AnalyticsBreakdownData extends Data
{
    /**
     * @param  list<AnalyticsBreakdownRowData>  $rows
     */
    public function __construct(
        public string $by,
        public AnalyticsRangeData $range,
        public array $rows,
        public AnalyticsMetaData $meta,
    ) {}
}
