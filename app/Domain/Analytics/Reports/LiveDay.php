<?php

namespace App\Domain\Analytics\Reports;

use App\Domain\Analytics\Collection\MetricCalculator;
use Illuminate\Support\Facades\Cache;

/**
 * A day computed on the spot with {@see MetricCalculator} (the same call the rollup stores), kept `analytics.live_ttl` seconds because every
 * report of every viewer asks for today. Used for the current day and for the few past days nobody rolled up yet.
 */
final class LiveDay
{
    public function __construct(private readonly MetricCalculator $calculator) {}

    /**
     * @return array{rows: array<string, array<string, array<string, int>>>, slots: list<array{slot: int, dimension: string, key: string, values: array<string, int>}>}
     */
    public function get(string $date, string $timezone, ?int $ttl = null): array
    {
        $ttl ??= (int) config('analytics.live_ttl', 30);
        $build = function () use ($date, $timezone): array {
            $metrics = $this->calculator->forDay($date, $timezone);
            $rows = [];

            foreach ($metrics->rows() as $row) {
                $rows[$row['dimension']][$row['key']] = $row['values'];
            }

            return ['rows' => $rows, 'slots' => $metrics->slotRows()];
        };

        return $ttl > 0 ? Cache::remember('analytics:live:'.$timezone.':'.$date, $ttl, $build) : $build();
    }
}
