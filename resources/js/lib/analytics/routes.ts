/**
 * Every URL of the analytics client and page, in one place (the Wayfinder output is git-ignored, so these are plain strings pinned to the
 * PHP route files by `tests/analytics-routes.test.ts`). Contract: docs/rest-api.md, "Analytics API (P7)".
 */
const API = '/api/v1/analytics';

export const analyticsRoutes = {
    page: () => '/analytics',
    api: {
        overview: () => `${API}/overview`,
        timeseries: () => `${API}/timeseries`,
        breakdown: () => `${API}/breakdown`,
        heatmap: () => `${API}/heatmap`,
        ratings: () => `${API}/ratings`,
        whatsapp: () => `${API}/whatsapp`,
        export: () => `${API}/export`,
    },
} as const;
