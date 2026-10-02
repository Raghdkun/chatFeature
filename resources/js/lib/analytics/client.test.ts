import { describe, expect, it, vi } from 'vite-plus/test';
import { createApiClient } from '@/lib/api-client';
import {
    createAnalyticsClient,
    exportUrl,
    reportQuery,
} from '@/lib/analytics/client';

function clientWith(answer: unknown = { data: {} }) {
    const fetchImpl = vi.fn(
        async () => new Response(JSON.stringify(answer), { status: 200 }),
    );
    const api = createApiClient({
        fetchImpl: fetchImpl as unknown as typeof fetch,
        xsrfToken: () => null,
        csrfCookieUrl: null,
    });

    return { analytics: createAnalyticsClient(api), fetchImpl };
}

const urlOf = (fetchImpl: ReturnType<typeof vi.fn>) =>
    new URL(String(fetchImpl.mock.calls[0][0]), 'http://x.test');

describe('reportQuery', () => {
    it('sends the range, the one filter and only a truthy compare', () => {
        expect(
            reportQuery({ from: '2026-03-01', to: '2026-03-27' }),
        ).toMatchObject({
            from: '2026-03-01',
            to: '2026-03-27',
            compare: undefined,
        });
        expect(
            reportQuery({ from: 'a', to: 'b', compare: true, agent: 7 }),
        ).toMatchObject({ compare: 1, agent: 7 });
        expect(
            reportQuery({ from: 'a', to: 'b', widget: null, category: 'C' }),
        ).toMatchObject({ widget: undefined, category: 'C' });
    });
});

describe('the client', () => {
    it('asks the overview with the filters and unwraps { data }', async () => {
        const { analytics, fetchImpl } = clientWith({
            data: { range: { days: 3 } },
        });

        await expect(
            analytics.overview({
                from: '2026-03-01',
                to: '2026-03-03',
                compare: true,
                widget: 'W',
            }),
        ).resolves.toEqual({ range: { days: 3 } });

        const url = urlOf(fetchImpl);

        expect(url.pathname).toBe('/api/v1/analytics/overview');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            from: '2026-03-01',
            to: '2026-03-03',
            compare: '1',
            widget: 'W',
        });
    });

    it('asks a timeseries for named metrics and an interval, never a comparison', async () => {
        const { analytics, fetchImpl } = clientWith();

        await analytics.timeseries(
            { from: 'a', to: 'b', compare: true },
            ['started', 'handled'],
            'week',
        );

        expect(Object.fromEntries(urlOf(fetchImpl).searchParams)).toEqual({
            from: 'a',
            to: 'b',
            metric: 'started,handled',
            interval: 'week',
        });
    });

    it('asks the breakdown for the whole account (no filter, no comparison)', async () => {
        const { analytics, fetchImpl } = clientWith();

        await analytics.breakdown(
            { from: 'a', to: 'b', widget: 'W', compare: true },
            'agent',
        );

        expect(Object.fromEntries(urlOf(fetchImpl).searchParams)).toEqual({
            from: 'a',
            to: 'b',
            by: 'agent',
        });
    });

    it("asks the heatmap with the viewer's zone and the metric", async () => {
        const { analytics, fetchImpl } = clientWith();

        await analytics.heatmap(
            { from: 'a', to: 'b', tz: 'Europe/Berlin', agent: 3 },
            'claimed',
        );

        expect(Object.fromEntries(urlOf(fetchImpl).searchParams)).toEqual({
            from: 'a',
            to: 'b',
            tz: 'Europe/Berlin',
            agent: '3',
            metric: 'claimed',
        });
    });

    it('asks the whatsapp report for the range and its comparison only', async () => {
        const { analytics, fetchImpl } = clientWith();

        await analytics.whatsapp(
            { from: 'a', to: 'b', compare: true, widget: 'W' },
            'day',
        );

        expect(Object.fromEntries(urlOf(fetchImpl).searchParams)).toEqual({
            from: 'a',
            to: 'b',
            compare: '1',
            interval: 'day',
        });
    });

    it('builds the export link with the filter and no comparison', () => {
        const url = new URL(
            exportUrl({
                from: '2026-03-01',
                to: '2026-03-27',
                compare: true,
                category: 'C',
            }),
            'http://x.test',
        );

        expect(url.pathname).toBe('/api/v1/analytics/export');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            from: '2026-03-01',
            to: '2026-03-27',
            category: 'C',
            format: 'csv',
        });
    });
});
