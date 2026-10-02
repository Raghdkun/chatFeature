<?php

namespace App\Domain\Analytics\Reports;

use App\Domain\Analytics\Support\Rows;

/**
 * The daily rows of one dimension row over a range, plus what the reader knows about their freshness (see `AnalyticsMetaData`).
 */
final class ReadResult
{
    /**
     * @param  array<string, array<string, int>>  $days  date => row; days without activity are absent
     */
    public function __construct(
        public readonly array $days,
        public readonly bool $live,
        public readonly ?string $rolledUpTo,
        public readonly int $missingDays,
        public readonly bool $timezoneChanged,
    ) {}

    /**
     * @return array<string, int>
     */
    public function row(string $date): array
    {
        return $this->days[$date] ?? Rows::zero();
    }

    /**
     * The summed row of the days in `[from, to]` (counters added, maxima maxed).
     *
     * @return array<string, int>
     */
    public function sum(string $from, string $to): array
    {
        $rows = [];

        foreach ($this->days as $date => $row) {
            if ($date >= $from && $date <= $to) {
                $rows[] = $row;
            }
        }

        return Rows::sum($rows);
    }
}
