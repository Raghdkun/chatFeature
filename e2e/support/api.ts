/**
 * The management API (`/api/v1/*`, Sanctum cookie + XSRF) as a test fixture: cheap setup and API-level assertions without
 * clicking through the UI. It uses the cookies of a browser context (`page.request`) or of a saved login
 * (`request.newContext({ storageState })`), exactly like the dashboard's own fetch wrapper does.
 */
import type { APIRequestContext } from '@playwright/test';

export type ApiResult<T = any> = {
    status: number;
    ok: boolean;
    /** The parsed JSON body (`undefined` for an empty or non-JSON answer). */
    body: T;
    headers: Record<string, string>;
    /** `body.data` for a `{ data }` success envelope. */
    data: any;
    /** `body.error` for an `{ error: { code, message, details } }` failure. */
    error:
        | { code: string; message: string; details?: Record<string, string[]> }
        | undefined;
};

export class Api {
    constructor(
        private readonly context: APIRequestContext,
        private readonly origin: string,
    ) {}

    private async xsrf(): Promise<string | undefined> {
        const state = await this.context.storageState();
        const cookie = state.cookies.find(
            (entry) =>
                entry.name === 'XSRF-TOKEN' &&
                this.origin.includes(entry.domain.replace(/^\./, '')),
        );

        return cookie ? decodeURIComponent(cookie.value) : undefined;
    }

    async request(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<ApiResult> {
        const token = await this.xsrf();
        const response = await this.context.fetch(`${this.origin}${path}`, {
            method,
            data: body === undefined ? undefined : JSON.stringify(body),
            failOnStatusCode: false,
            maxRedirects: 0,
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                // Sanctum treats a request as the SPA's when it comes from a "stateful" origin.
                Origin: this.origin,
                Referer: `${this.origin}/`,
                ...(token ? { 'X-XSRF-TOKEN': token } : {}),
            },
        });
        const text = await response.text();
        let parsed: any;

        try {
            parsed = text === '' ? undefined : JSON.parse(text);
        } catch {
            parsed = undefined;
        }

        return {
            status: response.status(),
            ok: response.ok(),
            body: parsed,
            headers: response.headers(),
            data: parsed?.data,
            error: parsed?.error,
        };
    }

    get = (path: string) => this.request('GET', path);
    post = (path: string, body?: unknown) => this.request('POST', path, body);
    put = (path: string, body?: unknown) => this.request('PUT', path, body);
    patch = (path: string, body?: unknown) => this.request('PATCH', path, body);
    delete = (path: string) => this.request('DELETE', path);

    /** Like `request`, but a non-2xx answer throws (setup code must not continue on a failed step). */
    async ok(
        method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<ApiResult> {
        const result = await this.request(method, path, body);

        if (!result.ok) {
            throw new Error(
                `${method} ${path} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
            );
        }

        return result;
    }
}

export type Category = {
    ulid: string;
    slug: string;
    name: string;
    sort_order: number;
    is_active: boolean;
    [key: string]: unknown;
};

export type WidgetPlan = {
    name: string;
    /** Allowed host entries (`localhost:8242`, `*.localhost:8242`, `http://...`). */
    domains?: string[];
    /** Category slugs to offer (in order). */
    categories?: string[];
    greetings?: {
        body: string;
        agent_name?: string | null;
        agent_avatar_url?: string | null;
        locale?: string | null;
        weight?: number;
        is_active?: boolean;
    }[];
    /** Merged into the default config and saved as the draft (then published when `publish` is not false). */
    config?: Record<string, unknown>;
    /** Widget settings (PATCH): `locale`, `timezone`, `allow_non_browser_clients`, ... */
    settings?: Record<string, unknown>;
    /** Default true. */
    enabled?: boolean;
    /** Default true: publish the draft. */
    publish?: boolean;
};

/**
 * Creates a widget through the management API and configures it in one go: domains, categories, greetings, draft config
 * (published unless told otherwise), enabled. Returns the final `WidgetData` plus the identity of the widget.
 */
export async function createWidget(
    api: Api,
    plan: WidgetPlan,
): Promise<{ ulid: string; key: string; widget: any }> {
    const created = await api.ok('POST', '/api/v1/widgets', {
        name: plan.name,
    });
    const { ulid, public_key: key } = created.data;

    if (plan.domains) {
        await api.ok('PUT', `/api/v1/widgets/${ulid}/domains`, {
            domains: plan.domains,
        });
    }

    if (plan.categories) {
        const all = (await api.ok('GET', '/api/v1/categories'))
            .data as Category[];
        const ulids = plan.categories.map((slug) => {
            const found = all.find((category) => category.slug === slug);

            if (!found) {
                throw new Error(`Unknown category slug "${slug}"`);
            }

            return found.ulid;
        });

        await api.ok('PUT', `/api/v1/widgets/${ulid}/categories`, {
            category_ulids: ulids,
        });
    }

    if (plan.greetings) {
        await api.ok('PUT', `/api/v1/widgets/${ulid}/greetings`, {
            greetings: plan.greetings.map((greeting, position) => ({
                weight: 1,
                is_active: true,
                sort_order: position,
                ...greeting,
            })),
        });
    }

    if (plan.settings) {
        await api.ok('PATCH', `/api/v1/widgets/${ulid}`, plan.settings);
    }

    if (plan.config) {
        await api.ok('PUT', `/api/v1/widgets/${ulid}/draft`, {
            config: plan.config,
        });

        if (plan.publish !== false) {
            await api.ok('POST', `/api/v1/widgets/${ulid}/publish`);
        }
    }

    if (plan.enabled !== false) {
        await api.ok('PATCH', `/api/v1/widgets/${ulid}`, { is_enabled: true });
    }

    const widget = (await api.ok('GET', `/api/v1/widgets/${ulid}`)).data;

    return { ulid, key, widget };
}
