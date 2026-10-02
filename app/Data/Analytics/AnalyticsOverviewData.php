<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET /analytics/overview`: the KPIs of the range and, with `compare=1`, of the equally long range right before it. */
#[TypeScript]
class AnalyticsOverviewData extends Data
{
    public function __construct(
        public AnalyticsRangeData $range,
        public ?AnalyticsRangeData $previousRange,
        public AnalyticsScopeData $scope,
        public AnalyticsKpisData $current,
        public ?AnalyticsKpisData $previous,
        public AnalyticsMetaData $meta,
    ) {}
}
