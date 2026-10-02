<?php

namespace Tests\Unit\Analytics;

use App\Domain\Analytics\Support\DayWindow;
use InvalidArgumentException;
use Tests\TestCase;

/** A calendar day of a time zone as a UTC window: DST days are 23 / 25 hours, boundaries are half-open. */
class DayWindowTest extends TestCase
{
    public function test_an_ordinary_day_is_24_hours_in_utc(): void
    {
        $window = DayWindow::forDate('2026-03-10', 'UTC');

        $this->assertSame('2026-03-10 00:00:00', $window->startDb());
        $this->assertSame('2026-03-11 00:00:00', $window->endDb());
        $this->assertSame(86400, $window->lengthSeconds());
    }

    public function test_the_window_follows_the_time_zone_offset(): void
    {
        $berlin = DayWindow::forDate('2026-03-10', 'Europe/Berlin');
        $kolkata = DayWindow::forDate('2026-03-10', 'Asia/Kolkata');

        $this->assertSame('2026-03-09 23:00:00', $berlin->startDb());
        $this->assertSame('2026-03-10 23:00:00', $berlin->endDb());
        $this->assertSame('2026-03-09 18:30:00', $kolkata->startDb());
        $this->assertSame('2026-03-10 18:30:00', $kolkata->endDb());
    }

    public function test_a_dst_day_is_23_or_25_hours_long(): void
    {
        $spring = DayWindow::forDate('2026-03-29', 'Europe/Berlin');   // clocks go forward at 02:00
        $autumn = DayWindow::forDate('2026-10-25', 'Europe/Berlin');   // and back again

        $this->assertSame(23 * 3600, $spring->lengthSeconds());
        $this->assertSame('2026-03-28 23:00:00', $spring->startDb());
        $this->assertSame('2026-03-29 22:00:00', $spring->endDb());
        $this->assertSame(25 * 3600, $autumn->lengthSeconds());
        $this->assertSame('2026-10-24 22:00:00', $autumn->startDb());
        $this->assertSame('2026-10-25 23:00:00', $autumn->endDb());
    }

    public function test_consecutive_days_tile_the_timeline_without_a_gap_or_an_overlap(): void
    {
        $previous = DayWindow::forDate('2026-03-27', 'Europe/Berlin');

        for ($day = 28; $day <= 31; $day++) {
            $next = DayWindow::forDate("2026-03-{$day}", 'Europe/Berlin');
            $this->assertSame($previous->endTs, $next->startTs);
            $previous = $next;
        }
    }

    public function test_the_date_of_an_instant_in_a_zone(): void
    {
        $this->assertSame('2026-03-10', DayWindow::dateOf(strtotime('2026-03-10 22:59:59 UTC'), 'Europe/Berlin'));
        $this->assertSame('2026-03-11', DayWindow::dateOf(strtotime('2026-03-10 23:00:00 UTC'), 'Europe/Berlin'));
    }

    public function test_stored_timestamps_are_parsed_in_the_database_zone(): void
    {
        $this->assertSame(strtotime('2026-03-10 09:15:30 UTC'), DayWindow::parseDb('2026-03-10 09:15:30'));
        $this->assertNull(DayWindow::parseDb(null));
        $this->assertNull(DayWindow::parseDb(''));
        $this->assertNull(DayWindow::parseDb('garbage'));
    }

    public function test_it_refuses_anything_that_is_not_a_real_date(): void
    {
        foreach (['2026-02-30', '2026-13-01', 'yesterday', '2026-3-1', ''] as $bad) {
            try {
                DayWindow::forDate($bad, 'UTC');
                $this->fail("{$bad} was accepted");
            } catch (InvalidArgumentException) {
                $this->addToAssertionCount(1);
            }
        }
    }
}
