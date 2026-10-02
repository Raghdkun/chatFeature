<?php

namespace App\Domain\Analytics\Support;

use Carbon\CarbonImmutable;
use DateTimeZone;

/**
 * The time zone days are counted in: the application's `app.timezone` setting (not `config('app.timezone')`, which is the zone the
 * database stores timestamps in: UTC). Rollup rows remember the zone they were counted in.
 */
final class AnalyticsTimezone
{
    public static function current(): string
    {
        return self::valid(settings()->string('app.timezone', 'UTC')) ?? 'UTC';
    }

    /** The name when PHP knows it as a time zone, else `null`. */
    public static function valid(?string $name): ?string
    {
        if ($name === null || $name === '' || strlen($name) > 64) {
            return null;
        }

        return in_array($name, DateTimeZone::listIdentifiers(DateTimeZone::ALL_WITH_BC), true) ? $name : null;
    }

    /** Today's date (`Y-m-d`) in `$timezone`. */
    public static function today(?string $timezone = null): string
    {
        return CarbonImmutable::now($timezone ?? self::current())->format('Y-m-d');
    }
}
