<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET /analytics/ratings`: count, average and 1-5 distribution of the range, and (administrators) the latest ratings with their comments. */
#[TypeScript]
class AnalyticsRatingsReportData extends Data
{
    /**
     * @param  list<AnalyticsRatingEntryData>  $recent
     */
    public function __construct(
        public AnalyticsRangeData $range,
        public AnalyticsRatingsData $ratings,
        public array $recent,
        public AnalyticsMetaData $meta,
    ) {}
}
