<?php

namespace Tests\Unit\Widgets;

use App\Domain\Widgets\Availability\OpeningHours;
use App\Domain\Widgets\Enums\OfflineMode;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\TestCase;

class OpeningHoursTest extends TestCase
{
    /**
     * @param  list<array{day: int, start: string, end: string}>  $schedule
     * @param  list<string>  $holidays
     */
    private function hours(string $timezone, array $schedule, array $holidays = [], OfflineMode $mode = OfflineMode::AutoHours): OpeningHours
    {
        return new OpeningHours($mode, $timezone, $schedule, $holidays);
    }

    private function utc(string $moment): CarbonImmutable
    {
        return CarbonImmutable::parse($moment, 'UTC');
    }

    /**
     * @return list<array{day: int, start: string, end: string}>
     */
    private function weekdays(): array
    {
        return array_map(fn (int $day): array => ['day' => $day, 'start' => '09:00', 'end' => '17:00'], [1, 2, 3, 4, 5]);
    }

    public function test_the_schedule_is_read_in_the_widget_timezone(): void
    {
        $berlin = $this->hours('Europe/Berlin', $this->weekdays());

        // 2026-01-12 is a Monday; Berlin is UTC+1 in winter.
        $this->assertFalse($berlin->isOpen($this->utc('2026-01-12 07:59:00')));
        $this->assertTrue($berlin->isOpen($this->utc('2026-01-12 08:00:00')));
        $this->assertTrue($berlin->isOpen($this->utc('2026-01-12 15:59:59')));
        $this->assertFalse($berlin->isOpen($this->utc('2026-01-12 16:00:00')), 'the end of a range is exclusive');
    }

    public function test_a_day_boundary_in_another_timezone_changes_the_weekday(): void
    {
        $sydney = $this->hours('Australia/Sydney', $this->weekdays());

        // Sunday 23:00 UTC is Monday 10:00 in Sydney (UTC+11 in January).
        $this->assertTrue($sydney->isOpen($this->utc('2026-01-11 23:00:00')));
        // Friday 07:00 UTC is Friday 18:00 in Sydney: closed.
        $this->assertFalse($sydney->isOpen($this->utc('2026-01-16 07:00:00')));

        $honolulu = $this->hours('Pacific/Honolulu', $this->weekdays());
        // Monday 18:00 UTC is Monday 08:00 in Honolulu (UTC-10): closed. 19:00 UTC is 09:00: open.
        $this->assertFalse($honolulu->isOpen($this->utc('2026-01-12 18:59:00')));
        $this->assertTrue($honolulu->isOpen($this->utc('2026-01-12 19:00:00')));
    }

    public function test_the_same_wall_clock_hours_hold_across_the_us_spring_forward(): void
    {
        $newYork = $this->hours('America/New_York', $this->weekdays());

        // Clocks go forward on Sunday 2026-03-08. Monday 03-02 is EST (UTC-5): 09:00 local = 14:00 UTC.
        $this->assertFalse($newYork->isOpen($this->utc('2026-03-02 13:59:00')));
        $this->assertTrue($newYork->isOpen($this->utc('2026-03-02 14:00:00')));
        // Monday 03-09 is EDT (UTC-4): 09:00 local = 13:00 UTC.
        $this->assertFalse($newYork->isOpen($this->utc('2026-03-09 12:59:00')));
        $this->assertTrue($newYork->isOpen($this->utc('2026-03-09 13:00:00')));
        $this->assertTrue($newYork->isOpen($this->utc('2026-03-09 20:59:00')));
        $this->assertFalse($newYork->isOpen($this->utc('2026-03-09 21:00:00')));
    }

    public function test_the_same_wall_clock_hours_hold_across_the_us_fall_back(): void
    {
        $newYork = $this->hours('America/New_York', $this->weekdays());

        // Clocks go back on Sunday 2026-11-01. Monday 10-26 is EDT: 09:00 = 13:00 UTC. Monday 11-02 is EST: 09:00 = 14:00 UTC.
        $this->assertTrue($newYork->isOpen($this->utc('2026-10-26 13:00:00')));
        $this->assertFalse($newYork->isOpen($this->utc('2026-11-02 13:00:00')));
        $this->assertTrue($newYork->isOpen($this->utc('2026-11-02 14:00:00')));
    }

    public function test_a_range_on_the_transition_day_itself_follows_the_wall_clock(): void
    {
        // Berlin springs forward on Sunday 2026-03-29 (02:00 CET -> 03:00 CEST): a 01:00-05:00 range is only three hours long.
        $berlin = $this->hours('Europe/Berlin', [['day' => 0, 'start' => '01:00', 'end' => '05:00']]);

        $this->assertFalse($berlin->isOpen($this->utc('2026-03-29 23:59:00')->subDay()), 'Saturday night is closed');
        $this->assertTrue($berlin->isOpen($this->utc('2026-03-29 00:30:00')), '01:30 CET');
        $this->assertTrue($berlin->isOpen($this->utc('2026-03-29 02:30:00')), '04:30 CEST');
        $this->assertFalse($berlin->isOpen($this->utc('2026-03-29 03:00:00')), '05:00 CEST is the end');
    }

    public function test_holidays_close_the_whole_day(): void
    {
        $hours = $this->hours('America/New_York', $this->weekdays(), ['2026-12-25']);

        $this->assertFalse($hours->isOpen($this->utc('2026-12-25 17:00:00')), 'Friday 25 Dec 12:00 local');
        $this->assertTrue($hours->isOpen($this->utc('2026-12-24 17:00:00')), 'Thursday');

        // The holiday is a date in the widget's timezone: 2026-12-26 02:00 UTC is still Friday 25 Dec 21:00 in New York.
        $this->assertFalse($hours->isOpen($this->utc('2026-12-26 02:00:00')));
    }

    public function test_always_online_and_always_offline_ignore_the_schedule(): void
    {
        $always = $this->hours('UTC', [], [], OfflineMode::AlwaysOnline);
        $never = $this->hours('UTC', $this->weekdays(), [], OfflineMode::AlwaysOffline);

        $this->assertTrue($always->isOpen($this->utc('2026-01-11 03:00:00')));
        $this->assertFalse($never->isOpen($this->utc('2026-01-12 10:00:00')));
        $this->assertNull($always->nextOpening($this->utc('2026-01-11 03:00:00')));
        $this->assertNull($never->nextOpening($this->utc('2026-01-12 18:00:00')));
    }

    public function test_multiple_ranges_per_day_and_midnight_end(): void
    {
        $hours = $this->hours('UTC', [
            ['day' => 1, 'start' => '09:00', 'end' => '12:00'],
            ['day' => 1, 'start' => '13:00', 'end' => '17:00'],
            ['day' => 1, 'start' => '22:00', 'end' => '24:00'],
        ]);

        $this->assertTrue($hours->isOpen($this->utc('2026-01-12 11:59:00')));
        $this->assertFalse($hours->isOpen($this->utc('2026-01-12 12:30:00')), 'lunch break');
        $this->assertTrue($hours->isOpen($this->utc('2026-01-12 13:00:00')));
        $this->assertTrue($hours->isOpen($this->utc('2026-01-12 23:59:00')));
        $this->assertFalse($hours->isOpen($this->utc('2026-01-13 00:00:00')), '24:00 means midnight, Tuesday has no range');
    }

    public function test_the_next_opening_skips_weekends_and_follows_dst(): void
    {
        $newYork = $this->hours('America/New_York', $this->weekdays());

        // From Saturday 2026-03-07 12:00 UTC the next opening is Monday 2026-03-09 09:00 EDT = 13:00 UTC (DST began in between).
        $this->assertEquals($this->utc('2026-03-09 13:00:00'), $newYork->nextOpening($this->utc('2026-03-07 12:00:00')));
        // From Friday 2026-03-06 23:00 UTC (18:00 EST) too.
        $this->assertEquals($this->utc('2026-03-09 13:00:00'), $newYork->nextOpening($this->utc('2026-03-06 23:00:00')));
        // From Monday 08:00 local it is the same day at 09:00 local.
        $this->assertEquals($this->utc('2026-03-02 14:00:00'), $newYork->nextOpening($this->utc('2026-03-02 13:00:00')));
    }

    public function test_the_next_opening_skips_holidays(): void
    {
        $hours = $this->hours('UTC', $this->weekdays(), ['2026-01-12']);

        // Sunday 11 Jan -> Monday is a holiday -> Tuesday 13 Jan 09:00.
        $this->assertEquals($this->utc('2026-01-13 09:00:00'), $hours->nextOpening($this->utc('2026-01-11 12:00:00')));
    }

    public function test_there_is_no_next_opening_for_an_empty_schedule(): void
    {
        $this->assertNull($this->hours('UTC', [])->nextOpening($this->utc('2026-01-12 10:00:00')));
    }

    public function test_an_unknown_timezone_falls_back_to_utc(): void
    {
        $hours = $this->hours('Mars/Olympus', $this->weekdays());

        $this->assertTrue($hours->isOpen($this->utc('2026-01-12 09:00:00')));
    }
}
