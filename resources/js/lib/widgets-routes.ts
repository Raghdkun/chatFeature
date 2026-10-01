/**
 * Every URL the catalog / widgets / agents screens use, as typed plain strings per
 * docs/contracts/dashboard-pages-p3.md.
 *
 * Wayfinder cannot generate the controllers until the backend (track 3A) is merged. Afterwards
 * swap the bodies below for the generated functions (`import { index } from '@/actions/...'`
 * -> `index.url()`); no caller changes because they only ever see this module.
 */

const API = '/api/v1';

const enc = encodeURIComponent;

export const widgetsRoutes = {
    pages: {
        widgets: () => '/widgets',
        widget: (ulid: string) => `/widgets/${enc(ulid)}`,
        categories: () => '/categories',
        agents: () => '/agents',
        supportCategories: () => '/settings/support-categories',
    },

    api: {
        categories: {
            index: () => `${API}/categories`,
            show: (ulid: string) => `${API}/categories/${enc(ulid)}`,
        },
        me: {
            categories: () => `${API}/me/categories`,
        },
        agents: {
            index: () => `${API}/agents`,
            show: (id: number) => `${API}/agents/${id}`,
            categories: (id: number) => `${API}/agents/${id}/categories`,
        },
        widgets: {
            index: () => `${API}/widgets`,
            show: (ulid: string) => `${API}/widgets/${enc(ulid)}`,
            draft: (ulid: string) => `${API}/widgets/${enc(ulid)}/draft`,
            publish: (ulid: string) => `${API}/widgets/${enc(ulid)}/publish`,
            domains: (ulid: string) => `${API}/widgets/${enc(ulid)}/domains`,
            greetings: (ulid: string) =>
                `${API}/widgets/${enc(ulid)}/greetings`,
            categories: (ulid: string) =>
                `${API}/widgets/${enc(ulid)}/categories`,
            rotateSecret: (ulid: string) =>
                `${API}/widgets/${enc(ulid)}/rotate-secret`,
            snippet: (ulid: string) => `${API}/widgets/${enc(ulid)}/snippet`,
        },
    },

    /** Public, unauthenticated endpoints the builder preview and the embed snippets point at. */
    public: {
        /** Generic loader: reads `data-widget-key` (or a pre-registered boot config). */
        loader: () => '/widget/v1/loader.js',
        script: (key: string) => `/w/${enc(key)}.js`,
        embed: (key: string) => `/embed/${enc(key)}`,
        hosted: (key: string) => `/c/${enc(key)}`,
        publicApiBase: () => `${API}/public`,
    },

    /** Sanctum's CSRF cookie endpoint (used to recover from a 419). */
    csrfCookie: () => '/sanctum/csrf-cookie',
} as const;

export type WidgetsRoutes = typeof widgetsRoutes;
