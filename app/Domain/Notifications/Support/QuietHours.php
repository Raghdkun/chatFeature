<?php

namespace App\Domain\Notifications\Support;

use Carbon\CarbonInterface;
use DateTimeZone;
use Throwable;

/**
 * A member of staff's "do not push me" window: wall-clock `HH:MM` times in an IANA timezone. `start` after `end` is an overnight window
 * (22:00 to 07:00 covers the night and ends the next morning); `start` equal to `end` is no window at all. The end is exclusive.
 * It only silences OS pushes: the in-page toast and sound follow the sound setting.
 */
final readonly class QuietHours
{
    public const TIME_PATTERN = '/^([01]\d|2[0-3]):([0-5]\d)$/';

    public function __construct(
        public bool $enabled,
        public string $start,
        public string $end,
        public string $timezone,
    ) {}

    /**
     * @param  array<string, mixed>|null  $stored  the `quiet_hours` column
     */
    public static function fromArray(?array $stored, string $fallbackTimezone = 'UTC'): self
    {
        $stored ??= [];
        $start = self::validTime($stored['start'] ?? null) ?? '22:00';
        $end = self::validTime($stored['end'] ?? null) ?? '07:00';
        $timezone = is_string($stored['timezone'] ?? null) && self::validTimezone($stored['timezone']) ? $stored['timezone'] : $fallbackTimezone;

        return new self(($stored['enabled'] ?? false) === true, $start, $end, $timezone);
    }

    /** Whether `$moment` falls inside the window. */
    public function isActiveAt(CarbonInterface $moment): bool
    {
        $start = self::minutes($this->start);
        $end = self::minutes($this->end);

        if (! $this->enabled || $start === null || $end === null || $start === $end) {
            return false;
        }

        $local = $moment->clone()->setTimezone(self::validTimezone($this->timezone) ? $this->timezone : 'UTC');
        $now = $local->hour * 60 + $local->minute;

        return $start < $end ? ($now >= $start && $now < $end) : ($now >= $start || $now < $end);
    }

    /**
     * @return array{enabled: bool, start: string, end: string, timezone: string}
     */
    public function toArray(): array
    {
        return ['enabled' => $this->enabled, 'start' => $this->start, 'end' => $this->end, 'timezone' => $this->timezone];
    }

    public static function validTimezone(string $timezone): bool
    {
        try {
            new DateTimeZone($timezone);

            return $timezone !== '';
        } catch (Throwable) {
            return false;
        }
    }

    private static function validTime(mixed $value): ?string
    {
        return is_string($value) && preg_match(self::TIME_PATTERN, $value) === 1 ? $value : null;
    }

    private static function minutes(string $time): ?int
    {
        return preg_match(self::TIME_PATTERN, $time, $parts) === 1 ? ((int) $parts[1]) * 60 + (int) $parts[2] : null;
    }
}
