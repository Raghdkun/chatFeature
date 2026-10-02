<?php

namespace App\Domain\Analytics\Collection;

/**
 * One family of numbers of a day, read from the raw tables by the timestamp of the event it counts (docs/analytics.md, "Attribution").
 */
interface MetricCollector
{
    public function collect(DayContext $context): void;
}
