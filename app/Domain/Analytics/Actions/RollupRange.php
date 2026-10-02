<?php

namespace App\Domain\Analytics\Actions;

use App\Domain\Analytics\Support\AnalyticsTimezone;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use InvalidArgumentException;

/**
 * Runs {@see RollupDay} over days, oldest first, and moves the report cache's epoch so no dashboard serves numbers older than the run.
 * `pending()` is the self-healing default of the scheduled run: every day since `$horizonDays` ago that is not sealed yet, plus today (so
 * a scheduler that was down for a weekend catches up on its own).
 */
final class RollupRange
{
    public const CACHE_EPOCH_KEY = 'analytics:epoch';

    public const DEFAULT_HORIZON_DAYS = 35;

    public function __construct(private readonly RollupDay $day) {}

    /**
     * @param  (callable(RollupOutcome): void)|null  $progress
     * @return list<RollupOutcome>
     */
    public function handle(string $from, string $to, bool $force = false, ?callable $progress = null): array
    {
        return $this->run($this->days($from, $to), $force, $progress);
    }

    /**
     * @param  list<string>  $dates  `Y-m-d`, in the order they are rolled
     * @param  (callable(RollupOutcome): void)|null  $progress
     * @return list<RollupOutcome>
     */
    public function run(array $dates, bool $force = false, ?callable $progress = null): array
    {
        $timezone = AnalyticsTimezone::current();
        $outcomes = [];

        foreach ($dates as $date) {
            $outcome = $this->day->handle($date, $force, $timezone);
            $outcomes[] = $outcome;

            if ($progress !== null) {
                $progress($outcome);
            }
        }

        $this->bumpEpoch();

        return $outcomes;
    }

    /**
     * Every day from `$horizonDays` ago to today that is not sealed, oldest first.
     *
     * @return list<string>
     */
    public function pending(int $horizonDays = self::DEFAULT_HORIZON_DAYS): array
    {
        $today = AnalyticsTimezone::today();
        $first = CarbonImmutable::createFromFormat('!Y-m-d', $today, 'UTC')->subDays(max(1, $horizonDays))->format('Y-m-d');
        $sealed = DB::table('analytics_daily')
            ->where('dimension', 'total')
            ->where('dimension_key', '')
            ->whereNotNull('sealed_at')
            ->where('date', '>=', $first)
            ->pluck('date')
            ->map(static fn (mixed $date): string => substr((string) $date, 0, 10))
            ->flip()
            ->all();

        return array_values(array_filter($this->days($first, $today), static fn (string $date): bool => ! isset($sealed[$date])));
    }

    /**
     * @return list<string> inclusive, ascending
     */
    public function days(string $from, string $to): array
    {
        $start = $this->date($from);
        $end = $this->date($to);

        if ($start->greaterThan($end)) {
            throw new InvalidArgumentException('The start of the range is after its end.');
        }

        $days = [];

        for ($day = $start; $day->lessThanOrEqualTo($end); $day = $day->addDay()) {
            $days[] = $day->format('Y-m-d');
        }

        return $days;
    }

    public function bumpEpoch(): void
    {
        Cache::forever(self::CACHE_EPOCH_KEY, (string) Str::uuid());
    }

    private function date(string $value): CarbonImmutable
    {
        $date = preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) === 1 ? CarbonImmutable::createFromFormat('!Y-m-d', $value, 'UTC') : false;

        if ($date === false || $date->format('Y-m-d') !== $value) {
            throw new InvalidArgumentException("Not a Y-m-d date: {$value}");
        }

        return $date;
    }
}
