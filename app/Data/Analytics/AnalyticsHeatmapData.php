<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `GET /analytics/heatmap`: counts by weekday and hour of the day in `timezone` (the viewer's), `matrix[weekday][hour]` with weekday 0 =
 * Monday ... 6 = Sunday and hour 0-23. `metric` is `started` (chats started) or `claimed` (chats accepted; the only one an agent gets).
 */
#[TypeScript]
class AnalyticsHeatmapData extends Data
{
    /**
     * @param  list<list<int>>  $matrix
     */
    public function __construct(
        public string $timezone,
        public string $metric,
        public AnalyticsRangeData $range,
        public array $matrix,
        public int $max,
        public int $total,
        public AnalyticsMetaData $meta,
    ) {}
}
