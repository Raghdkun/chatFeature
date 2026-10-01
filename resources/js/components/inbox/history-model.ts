/**
 * The history page's filters as a query string and back: what the controls hold -> the URL (`GET /history?...`, also the Inertia
 * partial-reload request) -> the export link. Empty filters and page 1 never appear in a URL.
 */
import { staffRoutes } from '@/lib/chat-api/staff';
import type { HistoryFilters } from '@/types/chat-staff';

export const NO_FILTERS: HistoryFilters = {
    status: '',
    type: '',
    category: '',
    widget: '',
    agent: '',
    from: '',
    to: '',
    q: '',
};

export const FILTER_KEYS = Object.keys(NO_FILTERS) as (keyof HistoryFilters)[];

/** The query parameters of a filter set (and a page), without empty values. */
export function historyQuery(
    filters: HistoryFilters,
    page = 1,
): Record<string, string> {
    const query: Record<string, string> = {};

    for (const key of FILTER_KEYS) {
        const value = filters[key].trim();

        if (value !== '') {
            query[key] = value;
        }
    }

    if (page > 1) {
        query.page = String(page);
    }

    return query;
}

export function hasActiveFilters(filters: HistoryFilters): boolean {
    return FILTER_KEYS.some((key) => filters[key].trim() !== '');
}

/** The management API's export of exactly this filter set (`GET /api/v1/conversations/export`; admin only). */
export function exportUrl(filters: HistoryFilters): string {
    const params = new URLSearchParams(historyQuery(filters));
    const query = params.toString();

    return query === ''
        ? staffRoutes.api.export()
        : `${staffRoutes.api.export()}?${query}`;
}

/** "26-50 of 312" pieces for the pager text. */
export function pageWindow(pagination: {
    from: number | null;
    to: number | null;
    total: number;
}): { from: number; to: number; total: number } | null {
    return pagination.from === null || pagination.to === null
        ? null
        : { from: pagination.from, to: pagination.to, total: pagination.total };
}
