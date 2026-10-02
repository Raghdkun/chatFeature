<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET /analytics/timeseries`: one or more metrics bucketed by `day`, `week` (Monday first) or `month`. */
#[TypeScript]
class AnalyticsTimeseriesData extends Data
{
    /**
     * @param  list<AnalyticsSeriesData>  $series
     */
    public function __construct(
        public AnalyticsRangeData $range,
        public string $interval,
        public array $series,
        public AnalyticsMetaData $meta,
    ) {}
}
