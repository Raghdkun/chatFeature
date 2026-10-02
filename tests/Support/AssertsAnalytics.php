<?php

namespace Tests\Support;

use App\Domain\Analytics\Actions\RollupDay;
use App\Domain\Analytics\AnalyticsColumns;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

/**
 * Compares stored rollup rows with {@see AnalyticsReference} cell by cell.
 *
 * @mixin TestCase
 */
trait AssertsAnalytics
{
    /**
     * `dimension -> key -> column -> value` of a stored day, zeros dropped (the rollup does not store them either).
     *
     * @return array<string, array<string, array<string, int>>>
     */
    protected function storedRows(string $date): array
    {
        $rows = [];

        foreach (DB::table('analytics_daily')->where('date', $date)->get() as $row) {
            $values = [];

            foreach (AnalyticsColumns::all() as $column) {
                if ((int) $row->{$column} !== 0) {
                    $values[$column] = (int) $row->{$column};
                }
            }

            $rows[$row->dimension][$row->dimension_key] = $values;
        }

        return $this->normalise($rows);
    }

    /**
     * @return array<int, array<string, array<string, array<string, int>>>>
     */
    protected function storedSlots(string $date, string $timezone): array
    {
        $start = CarbonImmutable::createFromFormat('!Y-m-d', $date, $timezone)->startOfDay();
        $end = CarbonImmutable::createFromFormat('!Y-m-d', CarbonImmutable::createFromFormat('!Y-m-d', $date, 'UTC')->addDay()->format('Y-m-d'), $timezone)->startOfDay();
        $slots = [];

        $rows = DB::table('analytics_slots')
            ->where('slot_start', '>=', $start->utc()->format('Y-m-d H:i:s'))
            ->where('slot_start', '<', $end->utc()->format('Y-m-d H:i:s'))
            ->get();

        foreach ($rows as $row) {
            $values = array_filter(['started' => (int) $row->started, 'claimed' => (int) $row->claimed]);
            $slots[CarbonImmutable::parse($row->slot_start, 'UTC')->getTimestamp()][$row->dimension][$row->dimension_key] = $values;
        }

        ksort($slots);

        return $slots;
    }

    /**
     * Roll the day up (the real action) and assert every stored cell equals the independent computation.
     */
    protected function assertRollupMatchesReference(string $date, string $timezone, bool $withWhatsApp = true): void
    {
        app(RollupDay::class)->handle($date, true, $timezone);

        $expected = AnalyticsReference::day($date, $timezone, $withWhatsApp);
        $expectedRows = $this->normalise($expected['rows']);
        $actual = $this->storedRows($date);

        if (! $withWhatsApp) {
            unset($actual['whatsapp']);
        }

        $this->assertSame([], $this->differences($expectedRows, $actual), "analytics_daily of {$date} ({$timezone}) differs from the reference");

        $expectedSlots = $this->normaliseSlots($expected['slots']);
        $this->assertEquals($expectedSlots, $this->storedSlots($date, $timezone), "analytics_slots of {$date} ({$timezone}) differs from the reference");
    }

    /**
     * @param  array<string, array<string, array<string, int>>>  $rows
     * @return array<string, array<string, array<string, int>>>
     */
    protected function normalise(array $rows): array
    {
        $clean = [];

        foreach ($rows as $dimension => $keys) {
            foreach ($keys as $key => $values) {
                $values = array_filter(array_map('intval', $values), static fn (int $value): bool => $value !== 0);

                if ($values === [] && ! ($dimension === 'total' && (string) $key === '')) {
                    continue;
                }

                ksort($values);
                $clean[(string) $dimension][(string) $key] = $values;
            }

            if (isset($clean[(string) $dimension])) {
                ksort($clean[(string) $dimension], SORT_NATURAL);
            }
        }

        ksort($clean);

        return $clean;
    }

    /**
     * @param  array<int, array<string, array<string, array<string, int>>>>  $slots
     * @return array<int, array<string, array<string, array<string, int>>>>
     */
    protected function normaliseSlots(array $slots): array
    {
        ksort($slots);

        return $slots;
    }

    /**
     * @param  array<string, array<string, array<string, int>>>  $expected
     * @param  array<string, array<string, array<string, int>>>  $actual
     * @return list<string>
     */
    protected function differences(array $expected, array $actual): array
    {
        $differences = [];

        foreach (array_unique([...array_keys($expected), ...array_keys($actual)]) as $dimension) {
            foreach (array_unique([...array_keys($expected[$dimension] ?? []), ...array_keys($actual[$dimension] ?? [])]) as $key) {
                $want = $expected[$dimension][$key] ?? [];
                $got = $actual[$dimension][$key] ?? [];

                foreach (array_unique([...array_keys($want), ...array_keys($got)]) as $column) {
                    if (($want[$column] ?? 0) !== ($got[$column] ?? 0)) {
                        $differences[] = sprintf('%s/%s %s: expected %d, stored %d', $dimension, $key === '' ? '-' : $key, $column, $want[$column] ?? 0, $got[$column] ?? 0);
                    }
                }
            }
        }

        return $differences;
    }
}
