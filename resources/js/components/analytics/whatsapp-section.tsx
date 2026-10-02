import { useMemo } from 'react';
import {
    EmptyReport,
    Panel,
    ReportError,
    SkeletonBlock,
} from '@/components/analytics/states';
import { TimeSeriesChart } from '@/components/analytics/time-series-chart';
import { useTrans } from '@/hooks/use-trans';
import { analyticsApi } from '@/lib/analytics/client';
import {
    formatCount,
    formatDuration,
    formatPercent,
} from '@/lib/analytics/format';
import { intervalFor, spanDays } from '@/lib/analytics/ranges';
import type { ReportParams, SeriesData } from '@/lib/analytics/types';
import { useReport } from '@/lib/analytics/use-report';

/**
 * WhatsApp numbers: ADMINISTRATORS ONLY. The page never mounts this section for an agent (and the API answers 403 to one), so no request
 * for these numbers is even made from an agent's screen.
 */
export function WhatsAppSection({ params }: { params: ReportParams }) {
    const { t, locale } = useTrans();
    const interval = intervalFor(spanDays(params.from, params.to));
    const report = useReport(
        `whatsapp:${params.from}:${params.to}:${params.compare ? 1 : 0}`,
        (signal) => analyticsApi.whatsapp(params, interval, signal),
    );
    const data = report.data;

    const series = useMemo<SeriesData[]>(
        () =>
            data
                ? [
                      {
                          metric: 'wa_inbound',
                          unit: 'count',
                          points: data.series.map((point) => ({
                              date: point.date,
                              value: point.inbound,
                              days: 1,
                          })),
                      },
                      {
                          metric: 'wa_outbound',
                          unit: 'count',
                          points: data.series.map((point) => ({
                              date: point.date,
                              value: point.outbound,
                              days: 1,
                          })),
                      },
                  ]
                : [],
        [data],
    );

    const cards = data
        ? [
              ['chats', formatCount(data.current.chats, locale)],
              [
                  'linked',
                  `${formatCount(data.current.linkedChats, locale)}${
                      data.current.linkedShare === null
                          ? ''
                          : ` (${formatPercent(data.current.linkedShare, locale)})`
                  }`,
              ],
              ['inbound', formatCount(data.current.inbound, locale)],
              ['outbound', formatCount(data.current.outbound, locale)],
              [
                  'response',
                  formatDuration(data.current.averageResponseSeconds, locale),
              ],
          ]
        : [];

    return (
        <Panel
            id="analytics-whatsapp"
            title={t('analytics.whatsapp.title')}
            description={t('analytics.whatsapp.description')}
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
                    <SkeletonBlock className="h-48" />
                ) : null
            ) : data.current.chats +
                  data.current.inbound +
                  data.current.outbound ===
              0 ? (
                <EmptyReport title={t('analytics.whatsapp.empty')} />
            ) : (
                <div className="grid gap-5">
                    <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
                        {cards.map(([id, value]) => (
                            <div
                                key={id}
                                data-testid={`wa-kpi-${id}`}
                                className="grid gap-0.5 rounded-lg border p-3"
                            >
                                <dt className="text-xs text-muted-foreground">
                                    {t(`analytics.whatsapp.kpi.${id}`)}
                                </dt>
                                <dd className="text-xl font-semibold tracking-tight">
                                    {value}
                                </dd>
                            </div>
                        ))}
                    </dl>
                    <TimeSeriesChart
                        id="analytics-whatsapp-chart"
                        label={t('analytics.whatsapp.chart')}
                        series={series}
                        unit="count"
                        interval={interval}
                        labels={{
                            wa_inbound: t('analytics.whatsapp.series.inbound'),
                            wa_outbound: t(
                                'analytics.whatsapp.series.outbound',
                            ),
                        }}
                        height={200}
                    />
                </div>
            )}
        </Panel>
    );
}
