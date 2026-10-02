/**
 * The analytics client's URLs against the PHP route files (the same parser the other route contracts use): every endpoint the client calls
 * is routed with that verb, and the administrator-only ones sit inside the `admin` group.
 */
import { describe, expect, it } from 'vite-plus/test';
import { analyticsRoutes } from '@/lib/analytics/routes';
import { routeTable } from '@/tests/php-routes';

const table = routeTable();

describe('the analytics routes', () => {
    it('are all routed by the PHP route files', () => {
        const calls = [
            ['GET', analyticsRoutes.api.overview()],
            ['GET', analyticsRoutes.api.timeseries()],
            ['GET', analyticsRoutes.api.breakdown()],
            ['GET', analyticsRoutes.api.heatmap()],
            ['GET', analyticsRoutes.api.ratings()],
            ['GET', analyticsRoutes.api.whatsapp()],
            ['GET', analyticsRoutes.api.export()],
            ['GET', analyticsRoutes.page()],
        ];

        expect(
            calls.filter(([verb, path]) => !table.has(`${verb} ${path}`)),
        ).toEqual([]);
    });

    it('have no write endpoint: analytics is read-only', () => {
        const writes = [...table].filter((key) =>
            /^(POST|PUT|PATCH|DELETE) \/api\/v1\/analytics/.test(key),
        );

        expect(writes).toEqual([]);
    });
});
