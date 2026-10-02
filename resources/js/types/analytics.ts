/**
 * Inertia props of `/analytics` (docs/rest-api.md, "Analytics API (P7)"). Every nested shape is a generated PHP Data type
 * (`App.Data.Analytics.*`); the compile-time guard in `analytics.conformance.ts` fails `npm run types:check` when they drift. `role` is
 * narrowed from the generated `string` to the two values the server sends.
 */
import type {
    AnalyticsRole,
    FilterOption,
    Filters,
} from '@/lib/analytics/types';

export type AnalyticsPageProps = {
    scope: { role: AnalyticsRole; userId: number; whatsapp: boolean };
    /** The application time zone: the days of every number are counted in it. */
    timezone: string;
    /** Today in that zone (`Y-m-d`): the presets are built from it, never from the browser's clock. */
    today: string;
    filters: Filters;
    options: {
        widgets: FilterOption[];
        categories: FilterOption[];
        agents: FilterOption[];
    };
};
