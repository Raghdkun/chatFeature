<?php

namespace App\Domain\Analytics\Support;

use App\Domain\Analytics\AnalyticsColumns;

/**
 * Helpers for a rollup row as `array<string, int>`: every column present, counters added, maxima combined with `max`.
 */
final class Rows
{
    /**
     * @return array<string, int>
     */
    public static function zero(): array
    {
        return array_fill_keys(AnalyticsColumns::all(), 0);
    }

    /**
     * @param  array<string, mixed>|object  $row  a database row (columns as strings or ints, extra columns ignored)
     * @return array<string, int>
     */
    public static function of(array|object $row): array
    {
        $row = (array) $row;
        $values = [];

        foreach (AnalyticsColumns::all() as $column) {
            $values[$column] = (int) ($row[$column] ?? 0);
        }

        return $values;
    }

    /**
     * @param  array<string, int>  $a
     * @param  array<string, int>  $b
     * @return array<string, int>
     */
    public static function merge(array $a, array $b): array
    {
        foreach ($b as $column => $value) {
            $a[$column] = AnalyticsColumns::isMaximum($column) ? max($a[$column] ?? 0, $value) : ($a[$column] ?? 0) + $value;
        }

        return $a;
    }

    /**
     * @param  iterable<array<string, int>>  $rows
     * @return array<string, int>
     */
    public static function sum(iterable $rows): array
    {
        $total = self::zero();

        foreach ($rows as $row) {
            $total = self::merge($total, $row);
        }

        return $total;
    }
}
