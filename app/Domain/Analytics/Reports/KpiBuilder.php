<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsDurationData;
use App\Data\Analytics\AnalyticsKpisData;
use App\Data\Analytics\AnalyticsMessagesData;
use App\Data\Analytics\AnalyticsOffersData;
use App\Data\Analytics\AnalyticsOfflineData;
use App\Data\Analytics\AnalyticsRatingsData;
use App\Data\Analytics\AnalyticsResolutionData;
use App\Domain\Analytics\AnalyticsMetric;

/**
 * The headline numbers of a summed row. An average is sum / count of the same range; a number that cannot belong to one agent is `null` in
 * an agent's row.
 */
final class KpiBuilder
{
    /**
     * @param  array<string, int>  $row
     */
    public function build(array $row, bool $agentRow): AnalyticsKpisData
    {
        $get = static fn (string $column): int => $row[$column] ?? 0;
        $closed = AnalyticsMetric::Closed->compute($row);

        return new AnalyticsKpisData(
            started: $agentRow ? null : $get('started'),
            handled: $get('handled'),
            reclaimed: $get('reclaimed'),
            transferred: $get('transferred'),
            missed: $agentRow ? null : $get('missed'),
            cancelled: $agentRow ? null : $get('closed_cancelled'),
            ended: $get('ended'),
            closed: $agentRow ? null : (int) $closed,
            answerRate: $agentRow ? null : AnalyticsMetric::AnswerRate->compute($row),
            wait: new AnalyticsDurationData(AnalyticsMetric::WaitAvg->compute($row), $get('wait_max_s'), $get('wait_count')),
            firstResponse: new AnalyticsDurationData(AnalyticsMetric::FirstResponseAvg->compute($row), $get('frt_max_s'), $get('frt_count')),
            handling: new AnalyticsDurationData(AnalyticsMetric::HandlingAvg->compute($row), $get('handling_max_s'), $get('handling_count')),
            ratings: $this->ratings($row),
            messages: new AnalyticsMessagesData($agentRow ? null : $get('messages_visitor'), $get('messages_agent'), AnalyticsMetric::MessagesPerChat->compute($row)),
            peakConcurrent: $get('peak_concurrent'),
            queuePeak: $agentRow ? null : $get('queue_peak'),
            resolution: new AnalyticsResolutionData($get('res_visitor'), $get('res_agent'), $get('res_system'), $get('res_idle')),
            offline: new AnalyticsOfflineData(
                $agentRow ? null : $get('offline_created'),
                $get('offline_answered'),
                $agentRow ? null : $get('offline_closed'),
                AnalyticsMetric::OfflineResponseAvg->compute($row),
            ),
            offers: new AnalyticsOffersData($get('offers'), AnalyticsMetric::OfferAcceptRate->compute($row)),
        );
    }

    /**
     * @param  array<string, int>  $row
     */
    public function ratings(array $row): AnalyticsRatingsData
    {
        $get = static fn (string $column): int => $row[$column] ?? 0;

        return new AnalyticsRatingsData(
            $get('rating_count'),
            AnalyticsMetric::RatingAvg->compute($row),
            [$get('rating_1'), $get('rating_2'), $get('rating_3'), $get('rating_4'), $get('rating_5')],
        );
    }
}
