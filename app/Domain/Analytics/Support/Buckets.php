<?php

namespace App\Domain\Analytics\Support;

use Carbon\CarbonImmutable;

/**
 * Calendar buckets of a series: the first day of the day / ISO week (Monday) / month a date falls in. Pure date arithmetic on `Y-m-d`
 * strings (the days are already counted in the application time zone).
 */
final class Buckets
{
    public const INTERVALS = ['day', 'week', 'month'];

    public static function start(string $date, string $interval): string
    {
        $day = CarbonImmutable::createFromFormat('!Y-m-d', $date, 'UTC');

        return match ($interval) {
            'week' => $day->startOfWeek(CarbonImmutable::MONDAY)->format('Y-m-d'),
            'month' => $day->startOfMonth()->format('Y-m-d'),
            default => $date,
        };
    }

    /**
     * The interval that keeps a chart readable: a bucket per day up to about two months, per week up to about a year and a half, else per month.
     */
    public static function automatic(int $days): string
    {
        return match (true) {
            $days <= 62 => 'day',
            $days <= 540 => 'week',
            default => 'month',
        };
    }
}
