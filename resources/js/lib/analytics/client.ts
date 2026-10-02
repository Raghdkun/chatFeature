/**
 * Typed client of the analytics API (docs/rest-api.md, "Analytics API (P7)"): the shared fetch wrapper does the cookie / CSRF / envelope /
 * error mapping; this file only builds the queries. Shapes are the generated PHP Data types.
 */
import { api, type ApiClient } from '@/lib/api-client';
import { analyticsRoutes } from '@/lib/analytics/routes';
import type {
    BreakdownBy,
    BreakdownData,
    HeatmapData,
    HeatmapMetric,
    Interval,
    OverviewData,
    RatingsReport,
    ReportParams,
    SeriesMetric,
    TimeseriesData,
    WhatsAppReport,
} from '@/lib/analytics/types';

type Query = Record<string, string | number | boolean | null | undefined>;

/** The query string every report takes; `compare` is only sent when on. */
export function reportQuery(params: ReportParams): Query {
    return {
        from: params.from,
        to: params.to,
        compare: params.compare ? 1 : undefined,
        tz: params.tz,
        widget: params.widget ?? undefined,
        category: params.category ?? undefined,
        agent: params.agent ?? undefined,
    };
}

export function exportUrl(params: ReportParams): string {
    const query = new URLSearchParams();

    for (const [key, value] of Object.entries(reportQuery(params))) {
        if (value !== undefined && value !== null && key !== 'compare') {
            query.set(key, String(value));
        }
    }

    query.set('format', 'csv');

    return `${analyticsRoutes.api.export()}?${query.toString()}`;
}

export function createAnalyticsClient(client: ApiClient = api) {
    return {
        overview: (params: ReportParams, signal?: AbortSignal) =>
            client.get<OverviewData>(analyticsRoutes.api.overview(), {
                query: reportQuery(params),
                signal,
            }),
        timeseries: (
            params: ReportParams,
            metrics: SeriesMetric[],
            interval: Interval,
            signal?: AbortSignal,
        ) =>
            client.get<TimeseriesData>(analyticsRoutes.api.timeseries(), {
                query: {
                    ...reportQuery(params),
                    compare: undefined,
                    metric: metrics.join(','),
                    interval,
                },
                signal,
            }),
        breakdown: (
            params: ReportParams,
            by: BreakdownBy,
            signal?: AbortSignal,
        ) =>
            client.get<BreakdownData>(analyticsRoutes.api.breakdown(), {
                // The breakdown is the whole account: no filter, no comparison.
                query: { from: params.from, to: params.to, by },
                signal,
            }),
        heatmap: (
            params: ReportParams,
            metric: HeatmapMetric,
            signal?: AbortSignal,
        ) =>
            client.get<HeatmapData>(analyticsRoutes.api.heatmap(), {
                query: { ...reportQuery(params), compare: undefined, metric },
                signal,
            }),
        ratings: (params: ReportParams, signal?: AbortSignal) =>
            client.get<RatingsReport>(analyticsRoutes.api.ratings(), {
                query: { ...reportQuery(params), compare: undefined },
                signal,
            }),
        whatsapp: (
            params: ReportParams,
            interval: Interval,
            signal?: AbortSignal,
        ) =>
            client.get<WhatsAppReport>(analyticsRoutes.api.whatsapp(), {
                query: {
                    from: params.from,
                    to: params.to,
                    compare: params.compare ? 1 : undefined,
                    interval,
                },
                signal,
            }),
    };
}

export type AnalyticsClient = ReturnType<typeof createAnalyticsClient>;

export const analyticsApi: AnalyticsClient = createAnalyticsClient();
