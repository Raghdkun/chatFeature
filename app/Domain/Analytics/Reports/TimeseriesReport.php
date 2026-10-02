<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsPointData;
use App\Data\Analytics\AnalyticsSeriesData;
use App\Data\Analytics\AnalyticsTimeseriesData;
use App\Domain\Analytics\AnalyticsMetric;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\Buckets;
use App\Domain\Analytics\Support\Rows;
use Carbon\CarbonImmutable;

/**
 * `GET /analytics/timeseries`: metrics bucketed by day, ISO week or month. Each bucket is the sum of its days' rows (inside the range), so an
 * average over a week is the week's total seconds / the week's total samples, not an average of daily averages.
 */
final class TimeseriesReport
{
    public function __construct(private readonly RowReader $reader) {}

    /**
     * @param  list<AnalyticsMetric>  $metrics
     */
    public function handle(AnalyticsQuery $query, array $metrics, string $interval): AnalyticsTimeseriesData
    {
        $scope = $query->scope;
        $result = $this->reader->read($scope->dimension, $scope->key, $query->from, $query->to);

        /** @var array<string, array{row: array<string, int>, days: int}> $buckets */
        $buckets = [];

        for ($day = CarbonImmutable::createFromFormat('!Y-m-d', $query->from, 'UTC'); $day->format('Y-m-d') <= $query->to; $day = $day->addDay()) {
            $date = $day->format('Y-m-d');
            $bucket = Buckets::start($date, $interval);
            $buckets[$bucket] ??= ['row' => Rows::zero(), 'days' => 0];
            $buckets[$bucket]['row'] = Rows::merge($buckets[$bucket]['row'], $result->row($date));
            $buckets[$bucket]['days']++;
        }

        $series = [];

        foreach ($metrics as $metric) {
            $points = [];

            foreach ($buckets as $date => $bucket) {
                $points[] = new AnalyticsPointData((string) $date, $metric->compute($bucket['row']), $bucket['days']);
            }

            $series[] = new AnalyticsSeriesData($metric->value, $metric->unit(), $points);
        }

        return new AnalyticsTimeseriesData($query->range(), $interval, $series, MetaFactory::fromResult($query, $result));
    }
}
