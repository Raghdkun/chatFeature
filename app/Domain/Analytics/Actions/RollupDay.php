<?php

namespace App\Domain\Analytics\Actions;

use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\Collection\DayMetrics;
use App\Domain\Analytics\Collection\MetricCalculator;
use App\Domain\Analytics\Support\AnalyticsTimezone;
use App\Domain\Analytics\Support\DayWindow;
use App\Support\Database\DeadlockRetry;
use Illuminate\Support\Facades\DB;

/**
 * Computes one day with {@see MetricCalculator} and replaces that day's rows of `analytics_daily` and `analytics_slots` in one
 * transaction (delete + insert: a re-run gives the same rows, a number that fell to zero disappears, nothing is added twice).
 *
 * A day is SEALED once it is more than `SEAL_AFTER_DAYS` days old when computed: from then on only `$force` recomputes it, so the raw
 * tables can be pruned (retention, an erased chat, a deleted widget) without changing history. The same guard covers the WhatsApp rows
 * of a day whose messages the retention setting may already have deleted: they are kept as they are, whatever `$force` says.
 */
final class RollupDay
{
    /** A day older than this many days (at the moment it is computed) is final. */
    public const SEAL_AFTER_DAYS = 3;

    public function __construct(private readonly MetricCalculator $calculator) {}

    public function handle(string $date, bool $force = false, ?string $timezone = null): RollupOutcome
    {
        $timezone ??= AnalyticsTimezone::current();
        $window = DayWindow::forDate($date, $timezone);

        if (! $force && $this->isSealed($date)) {
            return new RollupOutcome($date, RollupOutcome::SEALED, 0);
        }

        $nowTs = now()->getTimestamp();
        $withWhatsApp = $this->whatsAppIsIntact($window, $nowTs);
        $metrics = $this->calculator->forDay($date, $timezone, $withWhatsApp);
        $sealedAt = $nowTs >= $window->endTs + self::SEAL_AFTER_DAYS * 86400 ? DayWindow::formatDb($nowTs) : null;

        $written = DeadlockRetry::transaction(fn (): int => $this->store($window, $metrics, $withWhatsApp, $sealedAt, DayWindow::formatDb($nowTs)));

        return new RollupOutcome($date, RollupOutcome::ROLLED, $written, $sealedAt !== null, ! $withWhatsApp);
    }

    public function isSealed(string $date): bool
    {
        return DB::table('analytics_daily')
            ->where('date', $date)
            ->where('dimension', AnalyticsColumns::TOTAL)
            ->where('dimension_key', '')
            ->whereNotNull('sealed_at')
            ->exists();
    }

    /**
     * Whether the day's WhatsApp messages can still be complete: with `whatsapp.retention_days` set, the daily prune deletes messages older
     * than that, so a day that starts before the cut-off may be partly gone and its stored numbers are the record.
     */
    private function whatsAppIsIntact(DayWindow $window, int $nowTs): bool
    {
        $retention = max(0, settings()->int('whatsapp.retention_days', 0));

        return $retention === 0 || $window->startTs > $nowTs - $retention * 86400;
    }

    private function store(DayWindow $window, DayMetrics $metrics, bool $withWhatsApp, ?string $sealedAt, string $computedAt): int
    {
        $delete = DB::table('analytics_daily')->where('date', $window->date);

        if (! $withWhatsApp) {
            $delete->where('dimension', '!=', AnalyticsColumns::WHATSAPP);
        }

        $delete->delete();

        $zero = array_fill_keys(AnalyticsColumns::all(), 0);
        $rows = [];

        foreach ($metrics->rows() as $row) {
            $isTotal = $row['dimension'] === AnalyticsColumns::TOTAL;

            $rows[] = ['date' => $window->date, 'dimension' => $row['dimension'], 'dimension_key' => $row['key'], 'tz' => $window->timezone]
                + array_merge($zero, $row['values'])
                + ['sealed_at' => $isTotal && $row['key'] === '' ? $sealedAt : null, 'computed_at' => $computedAt];
        }

        foreach (array_chunk($rows, 200) as $chunk) {
            DB::table('analytics_daily')->insert($chunk);
        }

        DB::table('analytics_slots')
            ->where('slot_start', '>=', $window->startDb())
            ->where('slot_start', '<', $window->endDb())
            ->delete();

        $slotZero = array_fill_keys(AnalyticsColumns::SLOT_COUNTERS, 0);
        $slots = [];

        foreach ($metrics->slotRows() as $slot) {
            $slots[] = ['slot_start' => DayWindow::formatDb($slot['slot']), 'dimension' => $slot['dimension'], 'dimension_key' => $slot['key']] + array_merge($slotZero, $slot['values']);
        }

        foreach (array_chunk($slots, 500) as $chunk) {
            DB::table('analytics_slots')->insert($chunk);
        }

        return count($rows);
    }
}
