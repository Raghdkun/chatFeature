<?php

namespace App\Console\Commands;

use App\Domain\Analytics\Actions\RollupOutcome;
use App\Domain\Analytics\Actions\RollupRange;
use App\Domain\Analytics\Support\AnalyticsTimezone;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Cache;
use InvalidArgumentException;

/**
 * `analytics:rollup`: fills `analytics_daily` / `analytics_slots` from the raw tables (docs/analytics.md).
 *
 *   analytics:rollup                         every day since 35 days ago that is not sealed (the nightly run: catches up on its own)
 *   analytics:rollup --today                 only today (the hourly run)
 *   analytics:rollup --from=2026-01-01 --to=2026-03-31 [--force]   a backfill; sealed days are skipped unless --force
 *
 * Idempotent: a day is recomputed from scratch and replaced in one transaction, so running it twice, or twice at once, gives the same rows
 * (a lock makes a second concurrent run stop at once). Days are counted in the `app.timezone` setting.
 */
class AnalyticsRollup extends Command
{
    protected $signature = 'analytics:rollup
        {--today : Only today (the live, partial day)}
        {--from= : First day (Y-m-d, application time zone)}
        {--to= : Last day (Y-m-d); defaults to today}
        {--days= : How many days back the unsealed catch-up looks (default 35)}
        {--force : Recompute sealed days too (their WhatsApp numbers are still kept once the retention setting may have deleted the messages)}';

    protected $description = 'Roll the raw chat, rating and WhatsApp tables up into the daily analytics tables (idempotent, backfill with --from/--to)';

    public function handle(RollupRange $rollup): int
    {
        $lock = Cache::lock('analytics:rollup', 3600);

        if (! $lock->get()) {
            $this->warn('Another analytics:rollup is running; nothing to do.');

            return self::SUCCESS;
        }

        try {
            return $this->roll($rollup);
        } catch (InvalidArgumentException $exception) {
            $this->error($exception->getMessage());

            return self::INVALID;
        } finally {
            $lock->release();
        }
    }

    private function roll(RollupRange $rollup): int
    {
        $force = (bool) $this->option('force');
        $today = AnalyticsTimezone::today();
        $from = $this->option('from');
        $to = $this->option('to');

        if ($from === null && $to !== null) {
            $this->error('--to needs --from.');

            return self::INVALID;
        }

        if ($from !== null) {
            $days = $rollup->days((string) $from, (string) ($to ?? $today));
        } elseif ($this->option('today')) {
            $days = [$today];
        } else {
            $days = $rollup->pending(max(1, (int) ($this->option('days') ?: RollupRange::DEFAULT_HORIZON_DAYS)));
        }

        if ($days === []) {
            $this->info('Nothing to roll up.');

            return self::SUCCESS;
        }

        $rolled = 0;
        $skipped = 0;

        $rollup->run($days, $force, function (RollupOutcome $outcome) use (&$rolled, &$skipped): void {
            if ($outcome->wasRolled()) {
                $rolled++;
                $this->line(sprintf('%s  %d rows%s%s', $outcome->date, $outcome->rows, $outcome->sealedNow ? '  sealed' : '', $outcome->whatsAppKept ? '  (WhatsApp rows kept: retention)' : ''));
            } else {
                $skipped++;
                $this->line($outcome->date.'  '.$outcome->status);
            }
        });

        $this->info(sprintf('Rolled up %d day(s), skipped %d.', $rolled, $skipped));

        return self::SUCCESS;
    }
}
