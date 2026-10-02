<?php

namespace App\Domain\Analytics\Reports;

use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\CsvCell;
use App\Domain\Analytics\Support\Rows;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Closure;
use Illuminate\Support\Facades\DB;

/**
 * `GET /analytics/export?format=csv` (administrators only): the daily rollup rows of the range as a spreadsheet, one line per day, dimension
 * and key, raw sums and maxima (an average is `*_sum_s / *_count`: the file never carries a figure that cannot be added up). Today is the live
 * computation; past days nobody rolled up yet are NOT in the file (the response says how many in `X-Analytics-Missing-Days`). Streamed in a
 * single pass over a cursor, so memory stays flat for two years of data. Names are the only free text: cells that start like a formula are
 * quoted.
 */
final class ExportReport
{
    public const META_COLUMNS = ['date', 'dimension', 'key', 'label', 'timezone'];

    public function __construct(private readonly RowReader $reader) {}

    /**
     * @return array{stream: Closure(): void, missing: int}
     */
    public function csv(AnalyticsQuery $query): array
    {
        $completion = $this->reader->completion($query->from, $query->to);
        // Only today is added to the file; a missing past day is reported, not computed (an export must not turn into a two-year recount).
        $today = $completion['live'][$query->today] ?? null;
        $skip = $today === null ? [] : [$query->today => true];
        $scope = $query->scope;

        $stream = function () use ($query, $today, $skip, $scope): void {
            if (function_exists('set_time_limit')) {
                @set_time_limit(0);
            }

            $out = fopen('php://output', 'wb');

            if ($out === false) {
                return;
            }

            $labels = $this->labels();
            fputcsv($out, [...self::META_COLUMNS, ...AnalyticsColumns::all()], ',', '"', '');

            $rows = DB::table('analytics_daily')
                ->whereBetween('date', [$query->from, $query->to])
                ->when($scope->dimension !== AnalyticsColumns::TOTAL, fn ($q) => $q->where('dimension', $scope->dimension)->where('dimension_key', $scope->key))
                ->orderBy('date')
                ->orderBy('dimension')
                ->orderBy('dimension_key');

            foreach ($rows->cursor() as $row) {
                $date = substr((string) $row->date, 0, 10);

                if (isset($skip[$date])) {
                    continue;
                }

                $this->line($out, $date, (string) $row->dimension, (string) $row->dimension_key, (string) $row->tz, Rows::of($row), $labels);
            }

            foreach ($today['rows'] ?? [] as $dimension => $keys) {
                if ($scope->dimension !== AnalyticsColumns::TOTAL && $dimension !== $scope->dimension) {
                    continue;
                }

                foreach ($keys as $key => $values) {
                    if ($scope->dimension !== AnalyticsColumns::TOTAL && (string) $key !== $scope->key) {
                        continue;
                    }

                    $this->line($out, $query->today, (string) $dimension, (string) $key, $query->timezone, Rows::of($values), $labels);
                }
            }

            fclose($out);
        };

        // Past days computed live for a report are still not in the file: they count as missing, like the ones beyond the live-fill limit.
        $liveOnlyPast = count($completion['live']) - ($today === null ? 0 : 1);

        return ['stream' => $stream, 'missing' => $completion['missing'] + $liveOnlyPast];
    }

    /**
     * @param  resource  $out
     * @param  array<string, int>  $values
     * @param  array<string, array<int, string>>  $labels
     */
    private function line($out, string $date, string $dimension, string $key, string $timezone, array $values, array $labels): void
    {
        $label = match ($dimension) {
            AnalyticsColumns::WIDGET => $labels['widget'][(int) $key] ?? __('Deleted widget'),
            AnalyticsColumns::CATEGORY => $key === '0' ? __('No topic') : ($labels['category'][(int) $key] ?? __('Deleted topic')),
            AnalyticsColumns::AGENT => $key === '0' ? __('Unassigned') : ($labels['agent'][(int) $key] ?? __('Deleted account')),
            AnalyticsColumns::WHATSAPP => 'WhatsApp',
            default => '',
        };

        fputcsv($out, array_map(CsvCell::safe(...), [$date, $dimension, $key, $label, $timezone, ...array_values($values)]), ',', '"', '');
    }

    /**
     * @return array<string, array<int, string>>
     */
    private function labels(): array
    {
        return [
            'widget' => Widget::withTrashed()->pluck('name', 'id')->all(),
            'category' => Category::withTrashed()->pluck('name', 'id')->all(),
            'agent' => User::query()->get()->mapWithKeys(fn (User $user): array => [$user->id => $user->label])->all(),
        ];
    }
}
