<?php

namespace App\Domain\Widgets\Availability;

use App\Domain\Widgets\Data\HoursConfigData;
use App\Domain\Widgets\Enums\OfflineMode;
use Carbon\CarbonImmutable;
use DateTimeZone;
use Throwable;

/**
 * Opening-hours maths for one widget: weekly schedule plus holidays, evaluated in the widget's timezone.
 *
 * Wall-clock semantics: `09:00` always means 09:00 local time, so a range keeps its local hours across a
 * DST change while its UTC instants move. A local time that does not exist (spring-forward gap) resolves to the
 * first valid instant after the gap; an ambiguous one (fall-back overlap) to its first occurrence.
 * Ranges never wrap past midnight; end `24:00` means midnight at the end of that day.
 */
final class OpeningHours
{
    /** How far ahead the next opening is searched. */
    private const LOOKAHEAD_DAYS = 14;

    /** @var array<int, list<array{0: string, 1: string}>> day of week => sorted [start, end] pairs */
    private array $ranges = [];

    /** @var array<string, true> */
    private array $holidays = [];

    private readonly DateTimeZone $zone;

    /**
     * @param  array<int, array{day: int, start: string, end: string}>  $schedule
     * @param  list<string>  $holidayDates  `YYYY-MM-DD` in the widget's timezone
     */
    public function __construct(
        private readonly OfflineMode $mode,
        string $timezone,
        array $schedule,
        array $holidayDates = [],
    ) {
        try {
            $this->zone = new DateTimeZone($timezone);
        } catch (Throwable) {
            $this->zone = new DateTimeZone('UTC');
        }

        foreach ($schedule as $range) {
            $this->ranges[$range['day']][] = [$range['start'], $range['end']];
        }

        foreach ($this->ranges as $day => $ranges) {
            usort($ranges, static fn (array $a, array $b): int => strcmp($a[0], $b[0]));
            $this->ranges[$day] = $ranges;
        }

        foreach ($holidayDates as $date) {
            $this->holidays[$date] = true;
        }
    }

    public static function fromConfig(HoursConfigData $hours, OfflineMode $mode, string $timezone): self
    {
        return new self(
            $mode,
            $timezone,
            array_map(static fn ($range): array => ['day' => $range->day, 'start' => $range->start, 'end' => $range->end], $hours->schedule),
            array_values(array_map(static fn ($holiday): string => $holiday->date, $hours->holidays)),
        );
    }

    public function isOpen(CarbonImmutable $at): bool
    {
        if ($this->mode === OfflineMode::AlwaysOnline) {
            return true;
        }

        if ($this->mode === OfflineMode::AlwaysOffline) {
            return false;
        }

        $local = $at->setTimezone($this->zone);

        if (isset($this->holidays[$local->format('Y-m-d')])) {
            return false;
        }

        foreach ($this->ranges[$local->dayOfWeek] ?? [] as [$start, $end]) {
            if ($at >= $this->at($local, $start) && $at < $this->at($local, $end)) {
                return true;
            }
        }

        return false;
    }

    /**
     * The first opening instant strictly after `$from` (within two weeks), or null when the schedule never opens
     * or the widget does not follow its hours.
     */
    public function nextOpening(CarbonImmutable $from): ?CarbonImmutable
    {
        if ($this->mode !== OfflineMode::AutoHours) {
            return null;
        }

        $local = $from->setTimezone($this->zone);

        for ($offset = 0; $offset <= self::LOOKAHEAD_DAYS; $offset++) {
            $day = $local->startOfDay()->addDays($offset);

            if (isset($this->holidays[$day->format('Y-m-d')])) {
                continue;
            }

            foreach ($this->ranges[$day->dayOfWeek] ?? [] as [$start, $end]) {
                $opens = $this->at($day, $start);

                if ($opens > $from && $opens < $this->at($day, $end)) {
                    return $opens->utc();
                }
            }
        }

        return null;
    }

    /**
     * Wall-clock `HH:MM` on the calendar day of `$day` (`24:00` = midnight at the end of that day), in the widget's zone.
     */
    private function at(CarbonImmutable $day, string $clock): CarbonImmutable
    {
        [$hour, $minute] = array_map('intval', explode(':', $clock));
        $midnight = $day->setTimezone($this->zone)->startOfDay();

        if ($hour === 24) {
            return $midnight->addDay();
        }

        return $midnight->setTime($hour, $minute);
    }
}
