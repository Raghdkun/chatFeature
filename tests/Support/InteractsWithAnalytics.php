<?php

namespace Tests\Support;

use App\Domain\Analytics\Actions\RollupRange;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\Support\Rows;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\Cache;
use Tests\TestCase;

/**
 * Shared set-up of the analytics API tests: a generated dataset, rolled up, with every cache off unless a test turns one on.
 *
 * @mixin TestCase
 */
trait InteractsWithAnalytics
{
    use AssertsAnalytics;

    protected const FIRST_DAY = '2026-03-20';

    protected const DAYS = 8;

    protected AnalyticsDataset $dataset;

    protected function disableAnalyticsCaches(): void
    {
        config(['analytics.live_ttl' => 0, 'analytics.report_ttl' => 0, 'analytics.past_report_ttl' => 0]);
        Cache::flush();
    }

    protected function seedAnalytics(int $perDay = 7, bool $rollUp = true): void
    {
        $this->disableAnalyticsCaches();
        $this->dataset = (new AnalyticsDataset)->generate(self::FIRST_DAY, self::DAYS, $perDay);

        if ($rollUp) {
            app(RollupRange::class)->handle('2026-03-10', '2026-04-05');
        }
    }

    /**
     * What the independent reference says the range adds up to, for one dimension row (`total` by default).
     *
     * @return array<string, int>
     */
    protected function expectedRow(string $from, string $to, string $dimension = 'total', string $key = '', string $timezone = 'UTC'): array
    {
        $rows = [];

        for ($day = CarbonImmutable::createFromFormat('!Y-m-d', $from, 'UTC'); $day->format('Y-m-d') <= $to; $day = $day->addDay()) {
            $reference = AnalyticsReference::day($day->format('Y-m-d'), $timezone)['rows'];
            $rows[] = Rows::of($reference[$dimension][$key] ?? []);
        }

        return Rows::sum($rows);
    }

    /** `$a / $b` or null: the way every average is defined. */
    protected function ratio(int $a, int $b): ?float
    {
        return $b > 0 ? $a / $b : null;
    }

    /**
     * @return list<string>
     */
    protected function counterColumns(): array
    {
        return AnalyticsColumns::COUNTERS;
    }
}
