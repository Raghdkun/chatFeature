import { Head } from '@inertiajs/react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { BreakdownTable } from '@/components/analytics/breakdown-table';
import { ChartPanel } from '@/components/analytics/chart-panel';
import { FilterBar } from '@/components/analytics/filter-bar';
import {
    HeatmapPanel,
    KpiSection,
    RatingsCard,
} from '@/components/analytics/report-panels';
import { Panel } from '@/components/analytics/states';
import { WhatsAppSection } from '@/components/analytics/whatsapp-section';
import {
    PageHeader,
    PageShell,
    usePlural,
} from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import { analyticsApi } from '@/lib/analytics/client';
import { PALETTE_CLASSES } from '@/lib/analytics/palette';
import { filtersToSearch, intervalFor, spanDays } from '@/lib/analytics/ranges';
import type { BreakdownBy, Filters, ReportParams } from '@/lib/analytics/types';
import { useReport } from '@/lib/analytics/use-report';
import { analyticsRoutes } from '@/lib/analytics/routes';
import type { AnalyticsPageProps } from '@/types/analytics';
import { cn } from '@/lib/utils';

/**
 * `/analytics`. Administrators get the whole account (key numbers, trends, busiest hours, ratings, a breakdown by topic / widget / agent and
 * the WhatsApp section); an agent gets "My performance": their own numbers only. The page is a shell: the numbers are read from the
 * analytics API, which scopes them by role on the server, so nothing here decides what an agent may see (and the admin-only sections are not
 * even mounted for one, so no request for them is made).
 */
export default function AnalyticsIndex({
    scope,
    timezone,
    today,
    filters: initial,
    options,
}: AnalyticsPageProps) {
    const { t } = useTrans();
    const plural = usePlural();
    const admin = scope.role === 'admin';
    const [filters, setFilters] = useState<Filters>(initial);

    // The URL follows the filters (a link shows the same view); Inertia's own history entry is kept.
    useEffect(() => {
        const search = filtersToSearch(filters);

        if (window.location.search !== `?${search}`) {
            window.history.replaceState(
                window.history.state,
                '',
                `${analyticsRoutes.page()}?${search}`,
            );
        }
    }, [filters]);

    const apply = useCallback((next: Filters) => setFilters(next), []);

    const params = useMemo<ReportParams>(
        () => ({
            from: filters.from,
            to: filters.to,
            compare: filters.compare,
            widget: admin ? filters.widget : null,
            category: admin ? filters.category : null,
            agent: admin ? filters.agent : null,
        }),
        [filters, admin],
    );
    const agentView = !admin || filters.agent !== null;
    const days = spanDays(filters.from, filters.to);
    const interval = intervalFor(days);
    const key = JSON.stringify(params);
    const overview = useReport(`overview:${key}`, (signal) =>
        analyticsApi.overview(params, signal),
    );
    const meta = overview.data?.meta ?? null;
    const empty =
        overview.data !== null &&
        overview.data.current.handled === 0 &&
        (overview.data.current.started ?? 0) === 0 &&
        overview.data.current.messages.agent === 0 &&
        overview.data.current.ratings.count === 0;

    const drill = useCallback(
        (by: BreakdownBy, value: string) =>
            setFilters((previous) => ({
                ...previous,
                widget: by === 'widget' ? value : null,
                category: by === 'category' ? value : null,
                agent: by === 'agent' ? Number(value) : null,
            })),
        [],
    );

    const title = admin ? t('analytics.title') : t('analytics.title_agent');

    return (
        <>
            <Head title={title} />

            <PageShell
                testId="analytics-page"
                wide
                className={cn(PALETTE_CLASSES)}
            >
                <PageHeader
                    title={title}
                    description={
                        admin
                            ? t('analytics.description', { timezone })
                            : t('analytics.description_agent', { timezone })
                    }
                />

                <FilterBar
                    filters={filters}
                    today={today}
                    options={options}
                    admin={admin}
                    onChange={apply}
                />

                {meta !== null &&
                    (meta.missingDays > 0 || meta.timezoneChanged) && (
                        <div
                            role="status"
                            data-testid="analytics-notice"
                            className="grid gap-1 rounded-lg border bg-muted/40 px-4 py-3 text-sm"
                        >
                            {meta.missingDays > 0 && (
                                <p>
                                    {plural(
                                        'analytics.notice.missing',
                                        meta.missingDays,
                                    )}
                                </p>
                            )}
                            {meta.timezoneChanged && (
                                <p>{t('analytics.notice.timezone')}</p>
                            )}
                        </div>
                    )}

                <KpiSection overview={overview} agentView={agentView} />

                {empty && (
                    <p
                        data-testid="analytics-nothing"
                        role="status"
                        className="rounded-lg border border-dashed px-4 py-3 text-sm text-muted-foreground"
                    >
                        <span className="font-medium text-foreground">
                            {t('analytics.state.empty_title')}.
                        </span>{' '}
                        {t('analytics.state.empty_body')}
                    </p>
                )}

                <div className="grid gap-4 lg:grid-cols-2">
                    {!agentView ? (
                        <>
                            <ChartPanel
                                id="analytics-volume"
                                titleKey="analytics.chart.volume"
                                metrics={['started', 'handled', 'missed']}
                                unit="count"
                                params={params}
                                interval={interval}
                            />
                            <ChartPanel
                                id="analytics-response"
                                titleKey="analytics.chart.response"
                                metrics={['wait_avg', 'frt_avg']}
                                unit="seconds"
                                params={params}
                                interval={interval}
                                colorIndex={[0, 1]}
                            />
                        </>
                    ) : (
                        <>
                            <ChartPanel
                                id="analytics-volume"
                                titleKey="analytics.chart.volume_agent"
                                metrics={['handled', 'ended']}
                                unit="count"
                                params={params}
                                interval={interval}
                            />
                            <ChartPanel
                                id="analytics-response"
                                titleKey="analytics.chart.response_agent"
                                metrics={['frt_avg']}
                                unit="seconds"
                                params={params}
                                interval={interval}
                            />
                        </>
                    )}
                    <ChartPanel
                        id="analytics-handling"
                        titleKey="analytics.chart.handling"
                        metrics={['handling_avg']}
                        unit="seconds"
                        params={params}
                        interval={interval}
                    />
                    <ChartPanel
                        id="analytics-rating"
                        titleKey="analytics.chart.rating"
                        metrics={['rating_avg']}
                        unit="score"
                        params={params}
                        interval={interval}
                        domain={[1, 5]}
                    />
                </div>

                <div className="grid gap-4 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
                    <HeatmapPanel
                        params={params}
                        role={scope.role}
                        appTimezone={timezone}
                    />
                    <RatingsCard params={params} role={scope.role} />
                </div>

                {admin && (
                    <Panel
                        id="analytics-breakdown-panel"
                        title={t('analytics.breakdown.title')}
                        description={t('analytics.breakdown.description')}
                    >
                        <BreakdownTable params={params} onFilter={drill} />
                    </Panel>
                )}

                {admin && scope.whatsapp && <WhatsAppSection params={params} />}
            </PageShell>
        </>
    );
}
