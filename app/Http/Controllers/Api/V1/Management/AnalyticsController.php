<?php

namespace App\Http\Controllers\Api\V1\Management;

use App\Domain\Analytics\AnalyticsCache;
use App\Domain\Analytics\AnalyticsColumns;
use App\Domain\Analytics\AnalyticsMetric;
use App\Domain\Analytics\AnalyticsQuery;
use App\Domain\Analytics\AnalyticsQueryFactory;
use App\Domain\Analytics\Reports\BreakdownReport;
use App\Domain\Analytics\Reports\ExportReport;
use App\Domain\Analytics\Reports\HeatmapReport;
use App\Domain\Analytics\Reports\OverviewReport;
use App\Domain\Analytics\Reports\RatingsReport;
use App\Domain\Analytics\Reports\TimeseriesReport;
use App\Domain\Analytics\Reports\WhatsAppReport;
use App\Domain\Audit\AuditLogger;
use App\Http\Requests\Analytics\AnalyticsRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Gate;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * The analytics API (`/api/v1/analytics/*`, docs/analytics.md and docs/rest-api.md). Every request is turned into an `AnalyticsQuery` by
 * `AnalyticsQueryFactory`, which scopes it by the caller's role on the server: an agent can only ever read their own row. The breakdown,
 * WhatsApp and export endpoints are administrator-only twice (route middleware and gate). Results are cached briefly per scope.
 */
class AnalyticsController extends ManagementController
{
    public function __construct(
        private readonly AnalyticsQueryFactory $queries,
        private readonly AnalyticsCache $cache,
    ) {}

    public function overview(AnalyticsRequest $request, OverviewReport $report): JsonResponse
    {
        $query = $this->query($request);

        return $this->data($this->cache->remember('overview', $query, [], fn (): array => $report->handle($query)->toArray()));
    }

    public function timeseries(AnalyticsRequest $request, TimeseriesReport $report): JsonResponse
    {
        $query = $this->query($request);
        $metrics = $request->metrics();
        $interval = $request->bucketInterval($query->days());

        foreach ($metrics as $metric) {
            if ($query->scope->isAgentDimension() && ! $metric->forAgent()) {
                throw ValidationException::withMessages(['metric' => [__('The metric :name is not available for one agent.', ['name' => $metric->value])]]);
            }
        }

        $extra = ['metrics' => array_map(static fn (AnalyticsMetric $metric): string => $metric->value, $metrics), 'interval' => $interval];

        return $this->data($this->cache->remember('timeseries', $query, $extra, fn (): array => $report->handle($query, $metrics, $interval)->toArray()));
    }

    public function breakdown(AnalyticsRequest $request, BreakdownReport $report): JsonResponse
    {
        $this->authorizeAll();
        $query = $this->query($request);
        $by = (string) $request->validated('by');

        if (! in_array($by, AnalyticsColumns::FILTERABLE, true)) {
            throw ValidationException::withMessages(['by' => [__('Choose widget, category or agent.')]]);
        }

        return $this->data($this->cache->remember('breakdown', $query, ['by' => $by], fn (): array => $report->handle($query, $by)->toArray()));
    }

    public function heatmap(AnalyticsRequest $request, HeatmapReport $report): JsonResponse
    {
        $query = $this->query($request);
        $metric = $request->validated('metric');
        $metric = is_string($metric) && $metric !== '' ? $metric : ($query->scope->isAgentDimension() ? 'claimed' : 'started');

        if (! in_array($metric, AnalyticsColumns::SLOT_COUNTERS, true) || ($metric === 'started' && $query->scope->isAgentDimension())) {
            throw ValidationException::withMessages(['metric' => [__('Choose started or claimed (an agent only has claimed).')]]);
        }

        return $this->data($this->cache->remember('heatmap', $query, ['metric' => $metric], fn (): array => $report->handle($query, $metric)->toArray()));
    }

    public function ratings(AnalyticsRequest $request, RatingsReport $report): JsonResponse
    {
        $query = $this->query($request);

        return $this->data($this->cache->remember('ratings', $query, [], fn (): array => $report->handle($query)->toArray()));
    }

    public function whatsapp(AnalyticsRequest $request, WhatsAppReport $report): JsonResponse
    {
        Gate::authorize('analytics.whatsapp');
        $query = $this->query($request);
        $interval = $request->bucketInterval($query->days());

        return $this->data($this->cache->remember('whatsapp', $query, ['interval' => $interval], fn (): array => $report->handle($query, $interval)->toArray()));
    }

    public function export(AnalyticsRequest $request, ExportReport $report, AuditLogger $audit): StreamedResponse
    {
        Gate::authorize('analytics.export');
        $query = $this->query($request);
        $export = $report->csv($query);

        $audit->record('analytics.exported', null, [
            'format' => 'csv',
            'from' => $query->from,
            'to' => $query->to,
            'dimension' => $query->scope->dimension,
        ], $this->actor($request));

        return response()->stream($export['stream'], 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="analytics-'.now()->utc()->format('Ymd-His').'.csv"',
            'Cache-Control' => 'no-store',
            'X-Accel-Buffering' => 'no',
            'X-Content-Type-Options' => 'nosniff',
            'X-Analytics-Missing-Days' => (string) $export['missing'],
        ]);
    }

    private function query(AnalyticsRequest $request): AnalyticsQuery
    {
        Gate::authorize('analytics.view');

        $user = $this->actor($request);

        if ($user === null) {
            abort(401);
        }

        return $this->queries->make($user, $request->filters());
    }

    private function authorizeAll(): void
    {
        Gate::authorize('analytics.view-all');
    }
}
