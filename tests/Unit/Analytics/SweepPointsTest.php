<?php

namespace Tests\Unit\Analytics;

use App\Domain\Analytics\Collection\DayMetrics;
use App\Domain\Analytics\Collection\SweepPoints;
use PHPUnit\Framework\TestCase;

/** The sweep behind peak concurrency and queue depth: exact overlaps to the second. */
class SweepPointsTest extends TestCase
{
    private const START = 1_000_000;

    private const END = self::START + 86400;

    private function peak(SweepPoints $points, string $column = 'peak_concurrent', string $dimension = 'total', string $key = ''): int
    {
        $metrics = new DayMetrics;
        $points->writePeaks($metrics);

        return $metrics->row($dimension, $key)[$column] ?? 0;
    }

    public function test_overlapping_intervals_peak_at_the_overlap(): void
    {
        $points = new SweepPoints(self::START, self::END);
        $points->add(SweepPoints::ACTIVE, 1, 1, 7, self::START + 100, self::START + 500);
        $points->add(SweepPoints::ACTIVE, 1, 1, 7, self::START + 400, self::START + 900);
        $points->add(SweepPoints::ACTIVE, 1, 1, 8, self::START + 450, self::START + 460);

        $this->assertSame(3, $this->peak($points));
        $this->assertSame(2, $this->peak($points, 'peak_concurrent', 'agent', '7'));
        $this->assertSame(1, $this->peak($points, 'peak_concurrent', 'agent', '8'));
        $this->assertSame(3, $this->peak($points, 'peak_concurrent', 'widget', '1'));
        $this->assertSame(0, $this->peak($points, 'queue_peak'));
    }

    public function test_an_interval_that_ends_when_another_starts_does_not_overlap_it(): void
    {
        $points = new SweepPoints(self::START, self::END);
        $points->add(SweepPoints::ACTIVE, 1, 1, 1, self::START + 100, self::START + 200);
        $points->add(SweepPoints::ACTIVE, 1, 1, 2, self::START + 200, self::START + 300);

        $this->assertSame(1, $this->peak($points));
    }

    public function test_an_interval_inside_one_second_still_occupies_it(): void
    {
        $points = new SweepPoints(self::START, self::END);
        $points->add(SweepPoints::ACTIVE, 1, 1, 1, self::START + 100, self::START + 100);
        $points->add(SweepPoints::ACTIVE, 1, 1, 2, self::START + 100, self::START + 101);

        $this->assertSame(2, $this->peak($points));
    }

    public function test_intervals_are_clipped_to_the_window_and_an_open_one_runs_to_the_limit(): void
    {
        $points = new SweepPoints(self::START, self::START + 1000);
        $points->add(SweepPoints::ACTIVE, 1, 1, 1, self::START - 5000, self::START + 10);     // started yesterday
        $points->add(SweepPoints::ACTIVE, 1, 1, 2, self::START + 900, null);                  // still open
        $points->add(SweepPoints::ACTIVE, 1, 1, 3, self::START - 5000, self::START);          // ended exactly at the start: not in the day
        $points->add(SweepPoints::ACTIVE, 1, 1, 4, self::START + 1000, self::START + 2000);   // starts after the limit

        $this->assertSame(1, $this->peak($points));
        $this->assertSame(0, $this->peak($points, 'peak_concurrent', 'agent', '3'));
        $this->assertSame(0, $this->peak($points, 'peak_concurrent', 'agent', '4'));
        $this->assertSame(1, $this->peak($points, 'peak_concurrent', 'agent', '2'));
    }

    public function test_the_queue_has_no_agent_rows_and_a_topicless_chat_is_category_zero(): void
    {
        $points = new SweepPoints(self::START, self::END);
        $points->add(SweepPoints::QUEUE, 1, 0, null, self::START + 10, self::START + 50);
        $points->add(SweepPoints::QUEUE, 1, 0, null, self::START + 20, self::START + 60);

        $this->assertSame(2, $this->peak($points, 'queue_peak'));
        $this->assertSame(2, $this->peak($points, 'queue_peak', 'category', '0'));
        $metrics = new DayMetrics;
        $points->writePeaks($metrics);
        $this->assertSame([], $metrics->keys('agent'));
    }
}
