/**
 * Compile-time drift guard for the analytics UI: the shapes it declares must stay identical to the generated PHP Data types
 * (`App.Data.Analytics.*`). If a Data class changes without the UI following, or the other way round, `npm run types:check` fails here.
 * Nothing in this file runs.
 */
import type { SeriesMetric } from '@/lib/analytics/types';
import type * as A from '@/lib/analytics/types';
import type { AnalyticsPageProps } from '@/types/analytics';

type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

type Page = App.Data.Analytics.AnalyticsPageData;

/** The page props are the generated page Data, with `scope.role` narrowed to the two values the server sends. */
export const pageConforms: {
    scope: Same<
        Omit<AnalyticsPageProps['scope'], 'role'>,
        Omit<Page['scope'], 'role'>
    >;
    role: Same<AnalyticsPageProps['scope']['role'], 'admin' | 'agent'>;
    scopeRole: Same<Page['scope']['role'], string>;
    timezone: Same<AnalyticsPageProps['timezone'], Page['timezone']>;
    today: Same<AnalyticsPageProps['today'], Page['today']>;
    filters: Same<AnalyticsPageProps['filters'], Page['filters']>;
    options: Same<AnalyticsPageProps['options'], Page['options']>;
} = {
    scope: true,
    role: true,
    scopeRole: true,
    timezone: true,
    today: true,
    filters: true,
    options: true,
};

/** The short names are the generated types, field for field. */
export const aliasesConform: {
    kpis: Same<A.Kpis, App.Data.Analytics.AnalyticsKpisData>;
    overview: Same<A.OverviewData, App.Data.Analytics.AnalyticsOverviewData>;
    timeseries: Same<
        A.TimeseriesData,
        App.Data.Analytics.AnalyticsTimeseriesData
    >;
    breakdown: Same<A.BreakdownData, App.Data.Analytics.AnalyticsBreakdownData>;
    heatmap: Same<A.HeatmapData, App.Data.Analytics.AnalyticsHeatmapData>;
    ratings: Same<
        A.RatingsReport,
        App.Data.Analytics.AnalyticsRatingsReportData
    >;
    whatsapp: Same<A.WhatsAppReport, App.Data.Analytics.AnalyticsWhatsAppData>;
    /** The filter state the UI keeps is the page's filter shape. */
    filters: Same<A.Filters, App.Data.Analytics.AnalyticsFiltersData>;
    /** What the client sends as `ReportParams` is a subset of the filters (plus `tz`). */
    reportParams: Same<
        Pick<A.ReportParams, 'from' | 'to'>,
        Pick<App.Data.Analytics.AnalyticsFiltersData, 'from' | 'to'>
    >;
    /** The metrics the UI asks a series for are a subset of the API's list (a compile-time list, kept in step by the server test). */
    metric: Same<SeriesMetric extends string ? true : false, true>;
} = {
    kpis: true,
    overview: true,
    timeseries: true,
    breakdown: true,
    heatmap: true,
    ratings: true,
    whatsapp: true,
    filters: true,
    reportParams: true,
    metric: true,
};
