<?php

namespace App\Domain\Analytics\Support;

use Carbon\CarbonImmutable;
use DateTimeImmutable;
use DateTimeZone;
use InvalidArgumentException;

/**
 * One calendar day of the application time zone as a half-open UTC window `[start, end)` (a DST day is 23 or 25 hours long).
 * Timestamps in the database are written in `config('app.timezone')` (UTC); `startDb()` / `endDb()` format the window the same way,
 * so a range predicate is a plain string comparison on an indexed column.
 */
final class DayWindow
{
    private static ?DateTimeZone $dbZone = null;

    private function __construct(
        public readonly string $date,
        public readonly string $timezone,
        public readonly int $startTs,
        public readonly int $endTs,
    ) {}

    public static function forDate(string $date, string $timezone): self
    {
        if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) {
            throw new InvalidArgumentException("Not a Y-m-d date: {$date}");
        }

        $zone = new DateTimeZone($timezone);
        $day = CarbonImmutable::createFromFormat('!Y-m-d', $date, $zone);

        if ($day === null || $day->format('Y-m-d') !== $date) {
            throw new InvalidArgumentException("Not a real date: {$date}");
        }

        // The next date by calendar arithmetic, then its own midnight: a DST day is not "+24 hours".
        $next = CarbonImmutable::createFromFormat('!Y-m-d', $date, 'UTC')->addDay()->format('Y-m-d');
        $end = CarbonImmutable::createFromFormat('!Y-m-d', $next, $zone);

        return new self($date, $timezone, $day->startOfDay()->getTimestamp(), $end->startOfDay()->getTimestamp());
    }

    /** The day the instant falls on in `$timezone` (`Y-m-d`). */
    public static function dateOf(int $timestamp, string $timezone): string
    {
        return (new DateTimeImmutable('@'.$timestamp))->setTimezone(new DateTimeZone($timezone))->format('Y-m-d');
    }

    public function startDb(): string
    {
        return self::formatDb($this->startTs);
    }

    public function endDb(): string
    {
        return self::formatDb($this->endTs);
    }

    public function lengthSeconds(): int
    {
        return $this->endTs - $this->startTs;
    }

    /** `Y-m-d H:i:s` in the database time zone, `$seconds` before the window starts (the look-back of the concurrency sweep). */
    public function startDbMinus(int $seconds): string
    {
        return self::formatDb($this->startTs - $seconds);
    }

    public static function formatDb(int $timestamp): string
    {
        return (new DateTimeImmutable('@'.$timestamp))->setTimezone(self::dbZone())->format('Y-m-d H:i:s');
    }

    /** A stored timestamp as a unix time (`null` for null or garbage). */
    public static function parseDb(mixed $value): ?int
    {
        if (! is_string($value) || $value === '') {
            return null;
        }

        $moment = DateTimeImmutable::createFromFormat('!Y-m-d H:i:s', substr($value, 0, 19), self::dbZone());

        return $moment === false ? null : $moment->getTimestamp();
    }

    public static function dbZone(): DateTimeZone
    {
        return self::$dbZone ??= new DateTimeZone((string) config('app.timezone', 'UTC'));
    }

    /** Test hook: the cached zone follows `config('app.timezone')` again. */
    public static function forgetZone(): void
    {
        self::$dbZone = null;
    }
}
