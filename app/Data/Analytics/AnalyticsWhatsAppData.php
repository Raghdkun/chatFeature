<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `GET /analytics/whatsapp` (administrators only). */
#[TypeScript]
class AnalyticsWhatsAppData extends Data
{
    /**
     * @param  list<AnalyticsWhatsAppPointData>  $series
     */
    public function __construct(
        public AnalyticsRangeData $range,
        public ?AnalyticsRangeData $previousRange,
        public string $interval,
        public AnalyticsWhatsAppTotalsData $current,
        public ?AnalyticsWhatsAppTotalsData $previous,
        public array $series,
        public AnalyticsMetaData $meta,
    ) {}
}
