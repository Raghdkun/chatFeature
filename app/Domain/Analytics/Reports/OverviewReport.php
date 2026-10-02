<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsOverviewData;
use App\Domain\Analytics\AnalyticsQuery;

/**
 * `GET /analytics/overview`: the KPIs of the range and, on request, of the equally long range before it.
 */
final class OverviewReport
{
    public function __construct(private readonly RowReader $reader, private readonly KpiBuilder $kpis) {}

    public function handle(AnalyticsQuery $query): AnalyticsOverviewData
    {
        $scope = $query->scope;
        $agentRow = $scope->isAgentDimension();
        $current = $this->reader->read($scope->dimension, $scope->key, $query->from, $query->to);
        $previousRange = null;
        $previousKpis = null;
        $previousMissing = 0;

        if ($query->compare) {
            $previousRange = $query->previousRange();
            $previous = $this->reader->read($scope->dimension, $scope->key, $previousRange->from, $previousRange->to);
            $previousKpis = $this->kpis->build($previous->sum($previousRange->from, $previousRange->to), $agentRow);
            $previousMissing = $previous->missingDays;
        }

        return new AnalyticsOverviewData(
            range: $query->range(),
            previousRange: $previousRange,
            scope: $scope->toData(),
            current: $this->kpis->build($current->sum($query->from, $query->to), $agentRow),
            previous: $previousKpis,
            meta: MetaFactory::fromResult($query, $current, $previousMissing),
        );
    }
}
