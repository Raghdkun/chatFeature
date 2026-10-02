<?php

namespace App\Domain\Analytics\Reports;

use App\Data\Analytics\AnalyticsRatingEntryData;
use App\Data\Analytics\AnalyticsRatingsReportData;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\Support\DayWindow;
use App\Domain\Widgets\Support\Timestamps;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Carbon\CarbonImmutable;
use Illuminate\Support\Facades\DB;

/**
 * `GET /analytics/ratings`: count, average and the 1-5 distribution of the range (anybody, within their own scope), and for administrators
 * the latest ratings with their comments. An agent gets the numbers about their own chats but never a visitor's words: ratings are an
 * administrator-only record since P4 (`ConversationPolicy::viewRating`).
 */
final class RatingsReport
{
    public function __construct(private readonly RowReader $reader, private readonly KpiBuilder $kpis) {}

    public function handle(AnalyticsQuery $query): AnalyticsRatingsReportData
    {
        $scope = $query->scope;
        $result = $this->reader->read($scope->dimension, $scope->key, $query->from, $query->to);

        return new AnalyticsRatingsReportData(
            range: $query->range(),
            ratings: $this->kpis->ratings($result->sum($query->from, $query->to)),
            recent: $scope->isAdmin() ? $this->recent($query) : [],
            meta: MetaFactory::fromResult($query, $result),
        );
    }

    /**
     * @return list<AnalyticsRatingEntryData>
     */
    private function recent(AnalyticsQuery $query): array
    {
        $scope = $query->scope;
        $from = DayWindow::forDate($query->from, $query->timezone);
        $to = DayWindow::forDate($query->to, $query->timezone);

        $rows = DB::table('ratings as r')
            ->join('conversations as c', 'c.id', '=', 'r.conversation_id')
            ->where('r.created_at', '>=', $from->startDb())
            ->where('r.created_at', '<', $to->endDb())
            ->when($scope->dimension === AnalyticsColumns::WIDGET, fn ($q) => $q->where('c.widget_id', (int) $scope->key))
            ->when($scope->dimension === AnalyticsColumns::CATEGORY, fn ($q) => $scope->key === '0' ? $q->whereNull('c.category_id') : $q->where('c.category_id', (int) $scope->key))
            ->when($scope->dimension === AnalyticsColumns::AGENT, fn ($q) => $q->where('c.assigned_agent_id', (int) $scope->key))
            ->orderByDesc('r.id')
            ->limit(max(1, (int) config('analytics.recent_ratings', 20)))
            ->get(['r.score', 'r.comment', 'r.created_at', 'c.ulid', 'c.widget_id', 'c.category_id', 'c.assigned_agent_id']);

        $widgets = Widget::withTrashed()->whereIn('id', $rows->pluck('widget_id')->unique()->all())->pluck('name', 'id');
        $categories = Category::withTrashed()->whereIn('id', $rows->pluck('category_id')->filter()->unique()->all())->pluck('name', 'id');
        $agents = User::query()->whereIn('id', $rows->pluck('assigned_agent_id')->filter()->unique()->all())->get()->keyBy('id');

        return array_values($rows->map(fn (object $row): AnalyticsRatingEntryData => new AnalyticsRatingEntryData(
            conversation: (string) $row->ulid,
            score: (int) $row->score,
            comment: $row->comment === null ? null : (string) $row->comment,
            createdAt: (string) Timestamps::iso(CarbonImmutable::parse((string) $row->created_at, DayWindow::dbZone())),
            widget: $widgets->get((int) $row->widget_id),
            category: $row->category_id === null ? null : $categories->get((int) $row->category_id),
            agent: $row->assigned_agent_id === null ? null : $agents->get((int) $row->assigned_agent_id)?->label,
        ))->all());
    }
}
