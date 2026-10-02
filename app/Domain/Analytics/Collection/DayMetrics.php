<?php

namespace App\Domain\Analytics\Collection;

use App\Domain\Analytics\AnalyticsColumns;

/**
 * The numbers of one day, in memory: `dimension -> key -> column -> int` plus the 15-minute slots. The collectors write into it;
 * the rollup stores it and the live path (today) reads it directly, so there is one implementation of every number.
 */
final class DayMetrics
{
    /** @var array<string, array<string, array<string, int>>> */
    private array $rows = [];

    /** @var array<int, array<string, array<string, array<string, int>>>> slot start (unix) -> dimension -> key -> column */
    private array $slots = [];

    public function add(Attribution $to, string $column, int $by = 1): void
    {
        foreach ($to->targets() as [$dimension, $key]) {
            $this->bump($dimension, $key, $column, $by);
        }
    }

    /** Raise a maximum in every row the fact belongs to. */
    public function max(Attribution $to, string $column, int $value): void
    {
        foreach ($to->targets() as [$dimension, $key]) {
            $current = $this->rows[$dimension][$key][$column] ?? 0;

            if ($value > $current) {
                $this->rows[$dimension][$key][$column] = $value;
            }
        }
    }

    public function bump(string $dimension, string $key, string $column, int $by = 1): void
    {
        $this->rows[$dimension][$key][$column] = ($this->rows[$dimension][$key][$column] ?? 0) + $by;
    }

    public function raise(string $dimension, string $key, string $column, int $value): void
    {
        if ($value > ($this->rows[$dimension][$key][$column] ?? 0)) {
            $this->rows[$dimension][$key][$column] = $value;
        }
    }

    /** Count a fact in the 15-minute slot holding `$timestamp`, in every row the fact belongs to. */
    public function slot(int $timestamp, Attribution $to, string $column): void
    {
        $start = intdiv($timestamp, AnalyticsColumns::SLOT_SECONDS) * AnalyticsColumns::SLOT_SECONDS;

        foreach ($to->targets() as [$dimension, $key]) {
            $this->slots[$start][$dimension][$key][$column] = ($this->slots[$start][$dimension][$key][$column] ?? 0) + 1;
        }
    }

    /**
     * Rows with something in them, `total` always (a day that was rolled up but quiet is a row of zeros: that is how "rolled" differs from "not yet").
     *
     * @return list<array{dimension: string, key: string, values: array<string, int>}>
     */
    public function rows(): array
    {
        $rows = [];
        $rowsByDimension = $this->rows;
        $rowsByDimension[AnalyticsColumns::TOTAL][''] ??= [];

        foreach ($rowsByDimension as $dimension => $keys) {
            ksort($keys, SORT_NATURAL);

            foreach ($keys as $key => $values) {
                $values = array_filter($values, static fn (int $value): bool => $value !== 0);

                if ($values === [] && ! ($dimension === AnalyticsColumns::TOTAL && $key === '')) {
                    continue;
                }

                $rows[] = ['dimension' => (string) $dimension, 'key' => (string) $key, 'values' => $values];
            }
        }

        return $rows;
    }

    /**
     * @return list<array{slot: int, dimension: string, key: string, values: array<string, int>}>
     */
    public function slotRows(): array
    {
        $rows = [];
        ksort($this->slots);

        foreach ($this->slots as $slot => $dimensions) {
            foreach ($dimensions as $dimension => $keys) {
                foreach ($keys as $key => $values) {
                    $rows[] = ['slot' => $slot, 'dimension' => (string) $dimension, 'key' => (string) $key, 'values' => $values];
                }
            }
        }

        return $rows;
    }

    /**
     * @return array<string, int>
     */
    public function row(string $dimension, string $key = ''): array
    {
        return $this->rows[$dimension][$key] ?? [];
    }

    /**
     * @return list<string>
     */
    public function keys(string $dimension): array
    {
        return array_map('strval', array_keys($this->rows[$dimension] ?? []));
    }
}
