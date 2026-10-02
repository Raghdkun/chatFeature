import {
    EmptyReport,
    Panel,
    ReportError,
    SkeletonBlock,
} from '@/components/analytics/states';
import { TimeSeriesChart } from '@/components/analytics/time-series-chart';
import { useTrans } from '@/hooks/use-trans';
import { analyticsApi } from '@/lib/analytics/client';
import type {
    Interval,
    ReportParams,
    SeriesMetric,
    SeriesUnit,
} from '@/lib/analytics/types';
import { useReport } from '@/lib/analytics/use-report';

/** A titled card with one time-series chart: it asks the API for its own metrics, keeps the old chart (dimmed) while a new range loads, and says so when it fails. */
export function ChartPanel({
    id,
    titleKey,
    metrics,
    unit,
    params,
    interval,
    domain,
    colorIndex,
}: {
    id: string;
    titleKey: string;
    metrics: SeriesMetric[];
    unit: SeriesUnit;
    params: ReportParams;
    interval: Interval;
    domain?: [number, number];
    colorIndex?: number[];
}) {
    const { t } = useTrans();
    const key = [
        id,
        params.from,
        params.to,
        params.widget,
        params.category,
        params.agent,
        interval,
    ].join('|');
    const report = useReport(key, (signal) =>
        analyticsApi.timeseries(params, metrics, interval, signal),
    );
    const data = report.data;
    const labels = Object.fromEntries(
        metrics.map((metric) => [metric, t(`analytics.series.${metric}`)]),
    );

    return (
        <Panel
            id={id}
            title={t(titleKey)}
            busy={report.loading && data !== null}
        >
            {report.error !== null && (
                <ReportError
                    error={report.error}
                    onRetry={report.retry}
                    className="mb-3"
                />
            )}
            {data === null ? (
                report.loading ? (
                    <SkeletonBlock className="h-56" />
                ) : report.error === null ? (
                    <EmptyReport title={t('analytics.chart.empty')} />
                ) : null
            ) : (
                <TimeSeriesChart
                    id={`${id}-chart`}
                    label={t(titleKey)}
                    series={data.series}
                    unit={unit}
                    interval={interval}
                    labels={labels}
                    domain={domain}
                    colorIndex={colorIndex}
                />
            )}
        </Panel>
    );
}
