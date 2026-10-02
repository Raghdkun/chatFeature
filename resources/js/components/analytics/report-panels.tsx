import { useMemo, useState } from 'react';
import { Heatmap } from '@/components/analytics/heatmap';
import { KpiCard } from '@/components/analytics/kpi-card';
import { RatingsPanel } from '@/components/analytics/ratings-panel';
import {
    Panel,
    ReportError,
    SkeletonBlock,
} from '@/components/analytics/states';
import { useTrans } from '@/hooks/use-trans';
import { analyticsApi } from '@/lib/analytics/client';
import { ADMIN_KPIS, AGENT_KPIS } from '@/lib/analytics/kpis';
import type {
    AnalyticsRole,
    HeatmapMetric,
    OverviewData,
    ReportParams,
} from '@/lib/analytics/types';
import { useReport, type ReportState } from '@/lib/analytics/use-report';
import { cn } from '@/lib/utils';

/** The headline cards, from the overview the page already loaded. */
export function KpiSection({
    overview,
    agentView,
}: {
    overview: ReportState<OverviewData>;
    /** One agent's numbers (an agent's own view, or an administrator filtering by an agent): the cards that cannot belong to one agent are left out. */
    agentView: boolean;
}) {
    const { t } = useTrans();
    const definitions = agentView ? AGENT_KPIS : ADMIN_KPIS;
    const data = overview.data;

    return (
        <section
            aria-labelledby="analytics-kpis-title"
            aria-busy={overview.loading ? 'true' : undefined}
            data-testid="analytics-kpis"
        >
            <h2 id="analytics-kpis-title" className="sr-only">
                {t('analytics.kpi.title')}
            </h2>
            {overview.error !== null && (
                <ReportError
                    error={overview.error}
                    onRetry={overview.retry}
                    className="mb-3"
                />
            )}
            {data === null ? (
                overview.loading && (
                    <div className="grid grid-cols-1 gap-3 min-[420px]:grid-cols-2 lg:grid-cols-4">
                        {definitions.map((definition) => (
                            <SkeletonBlock
                                key={definition.id}
                                className="h-28 rounded-xl border bg-card p-4"
                            />
                        ))}
                    </div>
                )
            ) : (
                <div
                    className={cn(
                        'grid grid-cols-1 gap-3 transition-opacity motion-reduce:transition-none min-[420px]:grid-cols-2 lg:grid-cols-4',
                        overview.loading && 'opacity-60',
                    )}
                >
                    {definitions.map((definition) => (
                        <KpiCard
                            key={definition.id}
                            def={definition}
                            current={data.current}
                            previous={data.previous}
                            compare={data.previous !== null}
                            previousDays={
                                data.previousRange?.days ?? data.range.days
                            }
                        />
                    ))}
                </div>
            )}
        </section>
    );
}

/** Busiest hours: weekday x hour in the VIEWER's time zone (the browser's). Administrators may switch between chats started and chats accepted. */
export function HeatmapPanel({
    params,
    role,
    appTimezone,
}: {
    params: ReportParams;
    role: AnalyticsRole;
    appTimezone: string;
}) {
    const { t } = useTrans();
    const [metric, setMetric] = useState<HeatmapMetric>(
        role === 'admin' ? 'started' : 'claimed',
    );
    const viewerZone = useMemo(() => {
        try {
            return (
                Intl.DateTimeFormat().resolvedOptions().timeZone || appTimezone
            );
        } catch {
            return appTimezone;
        }
    }, [appTimezone]);
    // An agent only has chats accepted; so does an administrator filtering by one agent (a chat start belongs to no agent).
    const agentFiltered = params.agent !== null && params.agent !== undefined;
    const effective: HeatmapMetric =
        role === 'agent' || agentFiltered ? 'claimed' : metric;
    const key = [
        'heatmap',
        params.from,
        params.to,
        params.widget,
        params.category,
        params.agent,
        effective,
        viewerZone,
    ].join('|');
    const report = useReport(key, (signal) =>
        analyticsApi.heatmap({ ...params, tz: viewerZone }, effective, signal),
    );

    return (
        <Panel
            id="analytics-heatmap-panel"
            title={t('analytics.heatmap.title')}
            description={t('analytics.heatmap.description', {
                timezone: viewerZone,
            })}
            busy={report.loading && report.data !== null}
            actions={
                role === 'admin' && !agentFiltered ? (
                    <div
                        role="group"
                        aria-label={t('analytics.heatmap.metric_label')}
                        className="flex gap-1.5"
                    >
                        {(['started', 'claimed'] as const).map((option) => (
                            <button
                                key={option}
                                type="button"
                                aria-pressed={metric === option}
                                data-testid={`heatmap-metric-${option}`}
                                onClick={() => setMetric(option)}
                                className={cn(
                                    'rounded-md border px-2.5 py-1 text-xs outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                    metric === option
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-card hover:bg-accent',
                                )}
                            >
                                {t(`analytics.heatmap.metric.${option}`)}
                            </button>
                        ))}
                    </div>
                ) : undefined
            }
        >
            {report.error !== null && (
                <ReportError
                    error={report.error}
                    onRetry={report.retry}
                    className="mb-3"
                />
            )}
            {report.data === null ? (
                report.loading ? (
                    <SkeletonBlock className="h-56" />
                ) : null
            ) : (
                <Heatmap
                    matrix={report.data.matrix}
                    max={report.data.max}
                    total={report.data.total}
                    label={t(`analytics.heatmap.label_${effective}`)}
                    unitKey={`analytics.heatmap.cell_${effective}`}
                />
            )}
        </Panel>
    );
}

/** The rating distribution (and, for administrators, the latest comments). */
export function RatingsCard({
    params,
    role,
}: {
    params: ReportParams;
    role: AnalyticsRole;
}) {
    const { t } = useTrans();
    const key = [
        'ratings',
        params.from,
        params.to,
        params.widget,
        params.category,
        params.agent,
    ].join('|');
    const report = useReport(key, (signal) =>
        analyticsApi.ratings(params, signal),
    );

    return (
        <Panel
            id="analytics-ratings-panel"
            title={t('analytics.ratings.title')}
            busy={report.loading && report.data !== null}
        >
            {report.error !== null && (
                <ReportError
                    error={report.error}
                    onRetry={report.retry}
                    className="mb-3"
                />
            )}
            {report.data === null ? (
                report.loading ? (
                    <SkeletonBlock className="h-48" />
                ) : null
            ) : (
                <RatingsPanel
                    ratings={report.data.ratings}
                    recent={report.data.recent}
                    admin={role === 'admin'}
                />
            )}
        </Panel>
    );
}
