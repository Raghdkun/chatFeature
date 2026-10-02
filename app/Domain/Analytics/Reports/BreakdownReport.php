<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsBreakdownData;
use App\Data\Analytics\AnalyticsBreakdownRowData;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\Buckets;
use App\Domain\Analytics\Support\Rows;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;

/**
 * `GET /analytics/breakdown?by=widget|category|agent` (administrators only): every widget, topic or agent with activity in the range, busiest
 * first, with its KPIs and a sparkline of its volume. Names come from the live tables (soft-deleted widgets and topics keep theirs); a row whose
 * widget, topic or account is gone keeps its numbers under a generic name and `deleted: true`.
 */
final class BreakdownReport
{
    public function __construct(private readonly RowReader $reader, private readonly KpiBuilder $kpis) {}

    public function handle(AnalyticsQuery $query, string $by): AnalyticsBreakdownData
    {
        ['rows' => $byKey, 'result' => $result] = $this->reader->readAll($by, $query->from, $query->to);
        $names = $this->names($by, array_map('intval', array_keys($byKey)));
        $interval = Buckets::automatic($query->days());
        $volume = $by === AnalyticsColumns::AGENT ? ['handled', 'reclaimed'] : ['started'];
        $rows = [];

        foreach ($byKey as $key => $days) {
            $sum = Rows::sum($days);
            [$publicKey, $label, $deleted] = $names[(int) $key] ?? [(string) $key, $this->unknown($by), true];

            $rows[] = [
                'volume' => array_sum(array_map(static fn (string $column): int => $sum[$column], $volume)),
                'row' => new AnalyticsBreakdownRowData(
                    key: $publicKey,
                    label: $label,
                    deleted: $deleted,
                    kpis: $this->kpis->build($sum, $by === AnalyticsColumns::AGENT),
                    sparkline: $this->sparkline($days, $volume, $query, $interval),
                ),
            ];
        }

        usort($rows, static fn (array $a, array $b): int => $b['volume'] <=> $a['volume'] ?: strcasecmp($a['row']->label, $b['row']->label));

        return new AnalyticsBreakdownData($by, $query->range(), array_map(static fn (array $entry): AnalyticsBreakdownRowData => $entry['row'], $rows), MetaFactory::fromResult($query, $result));
    }

    /**
     * @param  array<string, array<string, int>>  $days
     * @param  list<string>  $columns
     * @return list<int>
     */
    private function sparkline(array $days, array $columns, AnalyticsQuery $query, string $interval): array
    {
        $buckets = [];

        for ($day = CarbonImmutable::createFromFormat('!Y-m-d', $query->from, 'UTC'); $day->format('Y-m-d') <= $query->to; $day = $day->addDay()) {
            $date = $day->format('Y-m-d');
            $bucket = Buckets::start($date, $interval);
            $buckets[$bucket] ??= 0;

            foreach ($columns as $column) {
                $buckets[$bucket] += $days[$date][$column] ?? 0;
            }
        }

        return array_values($buckets);
    }

    /**
     * id => [public key, label, deleted]
     *
     * @param  list<int>  $ids
     * @return array<int, array{0: string, 1: string, 2: bool}>
     */
    private function names(string $by, array $ids): array
    {
        $names = [];
        $real = array_values(array_filter($ids, static fn (int $id): bool => $id > 0));

        if ($by === AnalyticsColumns::WIDGET) {
            foreach (Widget::withTrashed()->whereIn('id', $real)->get(['id', 'ulid', 'name', 'deleted_at']) as $widget) {
                $names[$widget->id] = [$widget->ulid, $widget->name, $widget->deleted_at !== null];
            }
        } elseif ($by === AnalyticsColumns::CATEGORY) {
            foreach (Category::withTrashed()->whereIn('id', $real)->get(['id', 'ulid', 'name', 'deleted_at']) as $category) {
                $names[$category->id] = [$category->ulid, $category->name, $category->deleted_at !== null];
            }

            $names[0] = ['0', __('No topic'), false];
        } else {
            foreach (User::query()->whereIn('id', $real)->get() as $user) {
                $names[$user->id] = [(string) $user->id, $user->label, false];
            }

            $names[0] = ['0', __('Unassigned'), false];
        }

        return $names;
    }

    private function unknown(string $by): string
    {
        return match ($by) {
            AnalyticsColumns::WIDGET => __('Deleted widget'),
            AnalyticsColumns::CATEGORY => __('Deleted topic'),
            default => __('Deleted account'),
        };
    }
}
