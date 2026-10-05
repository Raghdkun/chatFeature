<?php

namespace App\Domain\Analytics\Reports;

use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\Support\AnalyticsTimezone;
use App\Domain\Analytics\Support\Rows;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * Reads rollup rows for a range and completes them: today (and, when asked, days nobody rolled up yet, up to `analytics.live_fill_days`) are
 * computed with the same code as the rollup, so a report is right even before the next scheduled run. Nothing here writes.
 */
final class RowReader
{
    /** The first recorded activity (memoised per reader): false = not read yet, null = nothing ever recorded. */
    private string|false|null $firstActivity = false;

    public function __construct(private readonly LiveDay $live) {}

    public function read(string $dimension, string $key, string $from, string $to): ReadResult
    {
        $stored = [];

        foreach (DB::table('analytics_daily')
            ->where('dimension', $dimension)
            ->where('dimension_key', $key)
            ->whereBetween('date', [$from, $to])
            ->get(['date', ...AnalyticsColumns::all()]) as $row) {
            $stored[substr((string) $row->date, 0, 10)] = Rows::of($row);
        }

        $completion = $this->completion($from, $to);

        foreach ($completion['live'] as $date => $payload) {
            $row = $payload['rows'][$dimension][$key] ?? null;

            if ($row !== null) {
                $stored[$date] = Rows::of($row);
            } else {
                unset($stored[$date]);
            }
        }

        return new ReadResult($stored, $completion['today'], $completion['rolledUpTo'], $completion['missing'], $completion['timezoneChanged']);
    }

    /**
     * Every row of a dimension (all widgets, all topics, all agents), grouped by key.
     *
     * @return array{rows: array<string, array<string, array<string, int>>>, result: ReadResult}
     */
    public function readAll(string $dimension, string $from, string $to): array
    {
        $byKey = [];

        foreach (DB::table('analytics_daily')
            ->where('dimension', $dimension)
            ->whereBetween('date', [$from, $to])
            ->get(['date', 'dimension_key', ...AnalyticsColumns::all()]) as $row) {
            $byKey[(string) $row->dimension_key][substr((string) $row->date, 0, 10)] = Rows::of($row);
        }

        $completion = $this->completion($from, $to);

        foreach ($completion['live'] as $date => $payload) {
            foreach ($byKey as $key => $days) {
                unset($byKey[$key][$date]);
            }

            foreach ($payload['rows'][$dimension] ?? [] as $key => $row) {
                $byKey[(string) $key][$date] = Rows::of($row);
            }
        }

        return [
            'rows' => $byKey,
            'result' => new ReadResult([], $completion['today'], $completion['rolledUpTo'], $completion['missing'], $completion['timezoneChanged']),
        ];
    }

    /**
     * What the stored rows of a range lack: the days to compute on the spot (today, and past days nobody rolled up yet, up to
     * `analytics.live_fill_days`), and how fresh the rest is.
     *
     * @return array{live: array<string, array{rows: array<string, array<string, array<string, int>>>, slots: list<array{slot: int, dimension: string, key: string, values: array<string, int>}>}>, today: bool, rolledUpTo: string|null, missing: int, timezoneChanged: bool}
     */
    public function completion(string $from, string $to): array
    {
        $timezone = AnalyticsTimezone::current();
        $today = AnalyticsTimezone::today($timezone);
        $rolled = [];
        $changed = false;
        $rolledUpTo = null;

        foreach (DB::table('analytics_daily')
            ->where('dimension', AnalyticsColumns::TOTAL)
            ->where('dimension_key', '')
            ->whereBetween('date', [$from, $to])
            ->get(['date', 'tz']) as $row) {
            $date = substr((string) $row->date, 0, 10);
            $rolled[$date] = true;
            $changed = $changed || $row->tz !== $timezone;
            $rolledUpTo = $rolledUpTo === null || $date > $rolledUpTo ? $date : $rolledUpTo;
        }

        $live = [];
        $todayInRange = $from <= $today && $today <= $to;

        if ($todayInRange) {
            $live[$today] = $this->live->get($today, $timezone);
        }

        $missing = [];
        $last = min($to, CarbonImmutable::createFromFormat('!Y-m-d', $today, 'UTC')->subDay()->format('Y-m-d'));
        // Nothing can have happened before the first chat: those days are empty by definition, not "still being prepared". A fresh
        // installation (no chat at all) has no missing day, instead of announcing a month of numbers that are not there.
        $first = $this->firstActivityDay();

        if ($first !== null) {
            for ($day = CarbonImmutable::createFromFormat('!Y-m-d', max($from, $first), 'UTC'); $day->format('Y-m-d') <= $last; $day = $day->addDay()) {
                if (! isset($rolled[$day->format('Y-m-d')])) {
                    $missing[] = $day->format('Y-m-d');
                }
            }
        }

        $fill = max(0, (int) config('analytics.live_fill_days', 14));
        $unfilled = 0;

        foreach ($missing as $index => $date) {
            if ($index < $fill) {
                $live[$date] = $this->live->get($date, $timezone, 300);
            } else {
                $unfilled++;
            }
        }

        return ['live' => $live, 'today' => $todayInRange, 'rolledUpTo' => $rolledUpTo, 'missing' => $unfilled, 'timezoneChanged' => $changed];
    }

    /** The day before the first chat or WhatsApp chat (a day of margin for the time zone), or null when nothing was ever recorded. */
    private function firstActivityDay(): ?string
    {
        if ($this->firstActivity === false) {
            $times = array_filter([
                DB::table('conversations')->min('created_at'),
                DB::table('wa_chats')->min('created_at'),
            ]);

            $this->firstActivity = $times === [] ? null : CarbonImmutable::parse(min($times), 'UTC')->subDay()->format('Y-m-d');
        }

        return $this->firstActivity;
    }
}
