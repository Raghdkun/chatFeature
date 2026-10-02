/**
 * Short names for the generated PHP Data types (`App.Data.Analytics.*`, the source of truth) plus the few narrower unions the UI relies on.
 * `types/analytics.conformance.ts` fails `npm run types:check` when these drift from the generated shapes.
 */
export type Kpis = App.Data.Analytics.AnalyticsKpisData;
export type Duration = App.Data.Analytics.AnalyticsDurationData;
export type RatingsSummary = App.Data.Analytics.AnalyticsRatingsData;
export type RangeData = App.Data.Analytics.AnalyticsRangeData;
export type MetaData = App.Data.Analytics.AnalyticsMetaData;
export type OverviewData = App.Data.Analytics.AnalyticsOverviewData;
export type TimeseriesData = App.Data.Analytics.AnalyticsTimeseriesData;
export type SeriesData = App.Data.Analytics.AnalyticsSeriesData;
export type PointData = App.Data.Analytics.AnalyticsPointData;
export type BreakdownData = App.Data.Analytics.AnalyticsBreakdownData;
export type BreakdownRow = App.Data.Analytics.AnalyticsBreakdownRowData;
export type HeatmapData = App.Data.Analytics.AnalyticsHeatmapData;
export type RatingsReport = App.Data.Analytics.AnalyticsRatingsReportData;
export type RatingEntry = App.Data.Analytics.AnalyticsRatingEntryData;
export type WhatsAppReport = App.Data.Analytics.AnalyticsWhatsAppData;
export type WhatsAppTotals = App.Data.Analytics.AnalyticsWhatsAppTotalsData;
export type FilterOption = App.Data.Analytics.AnalyticsOptionData;

export type AnalyticsRole = 'admin' | 'agent';
export type BreakdownBy = 'widget' | 'category' | 'agent';
export type Interval = 'day' | 'week' | 'month';
export type HeatmapMetric = 'started' | 'claimed';

/** The metrics a time series can show (the `AnalyticsMetric` cases the UI asks for). */
export type SeriesMetric =
    | 'started'
    | 'handled'
    | 'missed'
    | 'ended'
    | 'wait_avg'
    | 'frt_avg'
    | 'handling_avg'
    | 'rating_avg'
    | 'rating_count'
    | 'messages_visitor'
    | 'messages_agent'
    | 'peak_concurrent';

export type SeriesUnit = 'count' | 'seconds' | 'score' | 'ratio';

/** What the filter row holds (and the URL): the range, the one optional filter and the comparison switch. */
export type Filters = {
    from: string;
    to: string;
    widget: string | null;
    category: string | null;
    agent: number | null;
    compare: boolean;
};

/** The query every report takes (the heatmap also uses `tz`). */
export type ReportParams = {
    from: string;
    to: string;
    compare?: boolean;
    tz?: string;
    widget?: string | null;
    category?: string | null;
    agent?: number | null;
};
