<?php

namespace Tests\Unit\Notifications;

use App\Domain\Notifications\Support\QuietHours;
use Carbon\CarbonImmutable;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class QuietHoursTest extends TestCase
{
    /**
     * @return array<string, array{0: string, 1: string, 2: string, 3: string, 4: bool}>
     */
    public static function windows(): array
    {
        return [
            'inside a same-day window' => ['09:00', '17:00', 'UTC', '2026-11-20 12:00:00', true],
            'start is inclusive' => ['09:00', '17:00', 'UTC', '2026-11-20 09:00:00', true],
            'end is exclusive' => ['09:00', '17:00', 'UTC', '2026-11-20 17:00:00', false],
            'before a same-day window' => ['09:00', '17:00', 'UTC', '2026-11-20 08:59:00', false],
            'overnight: late evening' => ['22:00', '07:00', 'UTC', '2026-11-20 23:30:00', true],
            'overnight: after midnight' => ['22:00', '07:00', 'UTC', '2026-11-21 03:00:00', true],
            'overnight: last minute' => ['22:00', '07:00', 'UTC', '2026-11-21 06:59:00', true],
            'overnight: morning end' => ['22:00', '07:00', 'UTC', '2026-11-21 07:00:00', false],
            'overnight: afternoon' => ['22:00', '07:00', 'UTC', '2026-11-20 15:00:00', false],
            'the timezone shifts the clock (UTC 20:30 is 23:30 in Riyadh)' => ['22:00', '07:00', 'Asia/Riyadh', '2026-11-20 20:30:00', true],
            'the same instant is outside in UTC' => ['22:00', '07:00', 'UTC', '2026-11-20 20:30:00', false],
            'a zone behind UTC (UTC 03:00 is 22:00 in New York)' => ['22:00', '07:00', 'America/New_York', '2026-11-21 03:00:00', true],
            'daylight saving is the zone\'s own (summer, Berlin is UTC+2)' => ['22:00', '07:00', 'Europe/Berlin', '2026-07-01 20:30:00', true],
        ];
    }

    #[DataProvider('windows')]
    public function test_window_matrix(string $start, string $end, string $timezone, string $utcMoment, bool $expected): void
    {
        $hours = new QuietHours(true, $start, $end, $timezone);

        $this->assertSame($expected, $hours->isActiveAt(CarbonImmutable::parse($utcMoment, 'UTC')));
    }

    public function test_a_disabled_window_is_never_active(): void
    {
        $this->assertFalse((new QuietHours(false, '00:00', '23:59', 'UTC'))->isActiveAt(CarbonImmutable::parse('2026-11-20 12:00:00', 'UTC')));
    }

    public function test_equal_start_and_end_is_an_empty_window(): void
    {
        $this->assertFalse((new QuietHours(true, '08:00', '08:00', 'UTC'))->isActiveAt(CarbonImmutable::parse('2026-11-20 08:00:00', 'UTC')));
    }

    public function test_an_unknown_timezone_falls_back_to_utc_instead_of_failing(): void
    {
        $hours = new QuietHours(true, '22:00', '07:00', 'Mars/Olympus');

        $this->assertTrue($hours->isActiveAt(CarbonImmutable::parse('2026-11-20 23:00:00', 'UTC')));
    }

    public function test_reading_the_stored_column_is_lenient(): void
    {
        $this->assertEquals(new QuietHours(false, '22:00', '07:00', 'Asia/Riyadh'), QuietHours::fromArray(null, 'Asia/Riyadh'));
        $this->assertEquals(new QuietHours(true, '21:30', '06:15', 'Europe/Paris'), QuietHours::fromArray(['enabled' => true, 'start' => '21:30', 'end' => '06:15', 'timezone' => 'Europe/Paris'], 'UTC'));
        $this->assertEquals(new QuietHours(true, '22:00', '07:00', 'UTC'), QuietHours::fromArray(['enabled' => true, 'start' => '25:99', 'end' => 'late', 'timezone' => 'Nowhere/Land'], 'UTC'));
    }

    public function test_it_round_trips_through_an_array(): void
    {
        $hours = new QuietHours(true, '23:00', '06:30', 'Asia/Dubai');

        $this->assertEquals($hours, QuietHours::fromArray($hours->toArray()));
    }
}
