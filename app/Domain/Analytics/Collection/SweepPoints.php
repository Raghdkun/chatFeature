<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\AnalyticsColumns;

/**
 * Collects the start and end of intervals per dimension and turns them into peaks: the most intervals open at the same instant. Each
 * interval is clipped to the window; one that opens and closes within a single second occupies that second; at one instant the intervals
 * that end come before the ones that start (a chat that ends at 10:00:00 and one that starts at 10:00:00 never overlap).
 */
final class SweepPoints
{
    public const QUEUE = 'queue';

    public const ACTIVE = 'active';

    /** @var array<string, array<string, array<int|string, list<array{0: int, 1: int}>>>> kind -> dimension -> key -> points */
    private array $points = [];

    public function __construct(private readonly int $windowStart, private readonly int $limit) {}

    /**
     * @param  int|null  $agent  `null` = the interval has no agent (the queue)
     * @param  int|null  $end  `null` = still open
     */
    public function add(string $kind, int $widget, int $category, ?int $agent, int $start, ?int $end): void
    {
        $rawEnd = $end ?? $this->limit;
        $rawEnd = $rawEnd <= $start ? $start + 1 : $rawEnd;
        $from = max($start, $this->windowStart);
        $to = min($rawEnd, $this->limit);

        if ($to <= $from) {
            return;
        }

        $keys = [
            [AnalyticsColumns::TOTAL, ''],
            [AnalyticsColumns::WIDGET, (string) $widget],
            [AnalyticsColumns::CATEGORY, (string) $category],
        ];

        if ($agent !== null) {
            $keys[] = [AnalyticsColumns::AGENT, (string) $agent];
        }

        foreach ($keys as [$dimension, $key]) {
            $this->points[$kind][$dimension][$key][] = [$from, 1];
            $this->points[$kind][$dimension][$key][] = [$to, -1];
        }
    }

    public function writePeaks(DayMetrics $metrics): void
    {
        foreach ([self::QUEUE => 'queue_peak', self::ACTIVE => 'peak_concurrent'] as $kind => $column) {
            foreach ($this->points[$kind] ?? [] as $dimension => $keys) {
                foreach ($keys as $key => $sweep) {
                    usort($sweep, static fn (array $a, array $b): int => $a[0] <=> $b[0] ?: $a[1] <=> $b[1]);

                    $running = 0;
                    $peak = 0;

                    foreach ($sweep as [, $delta]) {
                        $running += $delta;
                        $peak = max($peak, $running);
                    }

                    if ($peak > 0) {
                        $metrics->raise((string) $dimension, (string) $key, $column, $peak);
                    }
                }
            }
        }
    }
}
