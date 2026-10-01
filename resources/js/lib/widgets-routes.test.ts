import { describe, expect, it } from 'vite-plus/test';
import { widgetsRoutes } from '@/lib/widgets-routes';

describe('page routes (docs/contracts/dashboard-pages-p3.md)', () => {
    it('matches the contract table', () => {
        expect(widgetsRoutes.pages.widgets()).toBe('/widgets');
        expect(widgetsRoutes.pages.widget('01HX')).toBe('/widgets/01HX');
        expect(widgetsRoutes.pages.categories()).toBe('/categories');
        expect(widgetsRoutes.pages.agents()).toBe('/agents');
        expect(widgetsRoutes.pages.supportCategories()).toBe(
            '/settings/support-categories',
        );
    });
});

describe('management API routes', () => {
    const { api } = widgetsRoutes;

    it('builds the category and self-service endpoints', () => {
        expect(api.categories.index()).toBe('/api/v1/categories');
        expect(api.categories.show('c1')).toBe('/api/v1/categories/c1');
        expect(api.me.categories()).toBe('/api/v1/me/categories');
    });

    it('builds the agent endpoints with numeric ids', () => {
        expect(api.agents.index()).toBe('/api/v1/agents');
        expect(api.agents.show(7)).toBe('/api/v1/agents/7');
        expect(api.agents.categories(7)).toBe('/api/v1/agents/7/categories');
    });

    it('builds every widget endpoint of the contract', () => {
        expect(api.widgets.index()).toBe('/api/v1/widgets');
        expect(api.widgets.show('w1')).toBe('/api/v1/widgets/w1');
        expect(api.widgets.draft('w1')).toBe('/api/v1/widgets/w1/draft');
        expect(api.widgets.publish('w1')).toBe('/api/v1/widgets/w1/publish');
        expect(api.widgets.domains('w1')).toBe('/api/v1/widgets/w1/domains');
        expect(api.widgets.greetings('w1')).toBe(
            '/api/v1/widgets/w1/greetings',
        );
        expect(api.widgets.categories('w1')).toBe(
            '/api/v1/widgets/w1/categories',
        );
        expect(api.widgets.rotateSecret('w1')).toBe(
            '/api/v1/widgets/w1/rotate-secret',
        );
        expect(api.widgets.snippet('w1')).toBe('/api/v1/widgets/w1/snippet');
    });

    it('url-encodes identifiers so they cannot escape the path', () => {
        expect(api.widgets.show('a/b?c')).toBe('/api/v1/widgets/a%2Fb%3Fc');
        expect(widgetsRoutes.pages.widget('../x')).toBe('/widgets/..%2Fx');
    });

    it('points the public helpers at the loader and embed routes', () => {
        expect(widgetsRoutes.public.loader()).toBe('/widget/v1/loader.js');
        expect(widgetsRoutes.public.script('wk_1')).toBe('/w/wk_1.js');
        expect(widgetsRoutes.public.embed('wk_1')).toBe('/embed/wk_1');
        expect(widgetsRoutes.public.hosted('wk_1')).toBe('/c/wk_1');
        expect(widgetsRoutes.public.publicApiBase()).toBe('/api/v1/public');
        expect(widgetsRoutes.csrfCookie()).toBe('/sanctum/csrf-cookie');
    });
});
