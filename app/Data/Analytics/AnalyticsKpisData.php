<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Every headline number of a range, computed from the summed rollup rows (an average is always sum / count of the same range, never an
 * average of daily averages). Numbers that cannot belong to one agent (chats started, missed, cancelled, closed, the queue) are `null`
 * in an agent's own view. `answerRate` = handled / (handled + missed), 0-1.
 */
#[TypeScript]
class AnalyticsKpisData extends Data
{
    public function __construct(
        public ?int $started,
        public int $handled,
        public int $reclaimed,
        public int $transferred,
        public ?int $missed,
        public ?int $cancelled,
        public int $ended,
        public ?int $closed,
        public ?float $answerRate,
        public AnalyticsDurationData $wait,
        public AnalyticsDurationData $firstResponse,
        public AnalyticsDurationData $handling,
        public AnalyticsRatingsData $ratings,
        public AnalyticsMessagesData $messages,
        public int $peakConcurrent,
        public ?int $queuePeak,
        public AnalyticsResolutionData $resolution,
        public AnalyticsOfflineData $offline,
        public AnalyticsOffersData $offers,
    ) {}
}
