/**
 * The URLs the catalog / widgets / agents screens call, as plain strings (the paths of
 * docs/contracts/dashboard-pages-p3.md), in one place so no screen spells a path itself. Only what
 * a screen actually uses is listed here.
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
        },
    },

    /** Public, unauthenticated endpoint the builder preview loads the real widget from. */
    public: {
        /** Generic loader: reads `data-widget-key` (or a pre-registered boot config). */
        loader: () => '/widget/v1/loader.js',
    },

    /** Sanctum's CSRF cookie endpoint (used to recover from a 419). */
    csrfCookie: () => '/sanctum/csrf-cookie',
} as const;
