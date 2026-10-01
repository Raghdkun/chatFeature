/**
 * A scriptable stand-in for `fetch` so screens are tested against the real api-client (headers,
 * envelope unwrapping, error mapping) without a server:
 *
 *   const api = fakeApi({ 'PATCH /api/v1/widgets/w1': { json: { data: {...} } } });
 *   ...
 *   expect(api.calls[0].body).toEqual({...});
 */
import { vi } from 'vite-plus/test';

export type FakeReply = {
    status?: number;
    json?: unknown;
    /** A plain-text body (scripts, ...): wins over `json`. */
    text?: string;
    headers?: Record<string, string>;
};

export type FakeCall = {
    method: string;
    path: string;
    query: string;
    body: unknown;
    headers: Record<string, string>;
};

type Route = FakeReply | ((call: FakeCall) => FakeReply | Promise<FakeReply>);

function urlOf(input: RequestInfo | URL): string {
    if (typeof input === 'string') {
        return input;
    }

    return input instanceof URL ? input.href : input.url;
}

function toResponse(reply: FakeReply): Response {
    const status = reply.status ?? 200;

    if (status === 204) {
        return new Response(null, { status });
    }

    if (reply.text !== undefined) {
        return new Response(reply.text, {
            status,
            headers: {
                'Content-Type': 'application/javascript; charset=utf-8',
                ...reply.headers,
            },
        });
    }

    return new Response(JSON.stringify(reply.json ?? {}), {
        status,
        headers: { 'Content-Type': 'application/json', ...reply.headers },
    });
}

export function fakeApi(initial: Record<string, Route> = {}) {
    const routes = new Map<string, Route>(Object.entries(initial));
    const calls: FakeCall[] = [];
    const unhandled: string[] = [];

    const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(urlOf(input), 'http://localhost');
        const method = (init?.method ?? 'GET').toUpperCase();
        const key = `${method} ${url.pathname}`;
        const call: FakeCall = {
            method,
            path: url.pathname,
            query: url.search,
            body:
                typeof init?.body === 'string'
                    ? (JSON.parse(init.body) as unknown)
                    : undefined,
            headers: (init?.headers ?? {}) as Record<string, string>,
        };

        calls.push(call);

        const route = routes.get(key);

        if (!route) {
            unhandled.push(key);

            return toResponse({
                status: 404,
                json: {
                    error: { code: 'not_found', message: `No fake for ${key}` },
                },
            });
        }

        return toResponse(
            typeof route === 'function' ? await route(call) : route,
        );
    };

    const fetchMock = vi.fn(impl);

    vi.stubGlobal('fetch', fetchMock);

    return {
        calls,
        unhandled,
        fetchMock,
        /** Add or replace a route after creation. */
        on(key: string, route: Route) {
            routes.set(key, route);
        },
        /** Calls to `METHOD /path` in order. */
        to(method: string, path: string): FakeCall[] {
            return calls.filter(
                (call) => call.method === method && call.path === path,
            );
        },
        /** Last call body of `METHOD /path`. */
        bodyOf(method: string, path: string): unknown {
            return this.to(method, path).at(-1)?.body;
        },
    };
}
