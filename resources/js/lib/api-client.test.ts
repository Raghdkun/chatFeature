import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ApiError,
    createApiClient,
    describeApiError,
    isApiError,
    readXsrfToken,
} from '@/lib/api-client';

type Reply = {
    status?: number;
    json?: unknown;
    headers?: Record<string, string>;
};

/** A `fetch` that answers from a queue and remembers what it was asked. */
function fakeFetch(...replies: (Reply | Error | DOMException)[]) {
    const calls: { url: string; init: RequestInit }[] = [];
    const queue = [...replies];
    const impl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push({
            url:
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input.href
                      : input.url,
            init: init ?? {},
        });

        const next = queue.shift() ?? { status: 200, json: { data: null } };

        if (next instanceof Error || next instanceof DOMException) {
            throw next;
        }

        if (next.status === 204) {
            return new Response(null, { status: 204 });
        }

        return new Response(
            next.json === undefined ? 'not json' : JSON.stringify(next.json),
            {
                status: next.status ?? 200,
                headers: {
                    'Content-Type': 'application/json',
                    ...next.headers,
                },
            },
        );
    });

    return { impl, calls };
}

const client = (
    fetcher: ReturnType<typeof fakeFetch>,
    extra: Parameters<typeof createApiClient>[0] = {},
) =>
    createApiClient({
        fetchImpl: fetcher.impl as unknown as typeof fetch,
        xsrfToken: () => 'tok/en=',
        onUnauthenticated: () => {},
        csrfCookieUrl: '/sanctum/csrf-cookie',
        ...extra,
    });

describe('readXsrfToken', () => {
    it('decodes the cookie Laravel sets', () => {
        expect(readXsrfToken('a=1; XSRF-TOKEN=ab%3D%2Fc; b=2')).toBe('ab=/c');
    });

    it('is null without the cookie or with a broken encoding', () => {
        expect(readXsrfToken('a=1')).toBeNull();
        expect(readXsrfToken('XSRF-TOKEN=%E0%A4%A')).toBeNull();
        expect(readXsrfToken('')).toBeNull();
    });
});

describe('requests', () => {
    it('sends the session cookie, the XSRF header and JSON, and unwraps { data }', async () => {
        const f = fakeFetch({ json: { data: { ulid: 'w1' } } });
        const result = await client(f).post<{ ulid: string }>(
            '/api/v1/widgets',
            {
                name: 'Site',
            },
        );

        expect(result).toEqual({ ulid: 'w1' });
        expect(f.calls[0].url).toBe('/api/v1/widgets');
        expect(f.calls[0].init.method).toBe('POST');
        expect(f.calls[0].init.credentials).toBe('same-origin');
        expect(f.calls[0].init.body).toBe('{"name":"Site"}');
        expect(f.calls[0].init.headers).toMatchObject({
            Accept: 'application/json',
            'Content-Type': 'application/json',
            'X-XSRF-TOKEN': 'tok/en=',
            'X-Requested-With': 'XMLHttpRequest',
        });
    });

    it('omits the XSRF header without a cookie and sends no body on GET / DELETE', async () => {
        const f = fakeFetch({ json: { data: [] } }, { status: 204 });
        const api = client(f, { xsrfToken: () => null });

        await api.get('/api/v1/agents');
        await api.delete('/api/v1/widgets/w1');

        expect(f.calls[0].init.headers).not.toHaveProperty('X-XSRF-TOKEN');
        expect(f.calls[0].init.body).toBeUndefined();
        expect(f.calls[1].init.method).toBe('DELETE');
        expect(f.calls[1].init.body).toBeUndefined();
    });

    it('appends query parameters and skips empty ones', async () => {
        const f = fakeFetch({ json: { data: [] } });

        await client(f).get('/api/v1/x', {
            query: { a: 1, b: 'two words', c: null, d: undefined },
        });

        expect(f.calls[0].url).toBe('/api/v1/x?a=1&b=two+words');
    });

    it('returns undefined for 204 answers', async () => {
        const f = fakeFetch({ status: 204 });

        await expect(
            client(f).delete('/api/v1/widgets/w1'),
        ).resolves.toBeNull();
    });

    it('returns the bare body when there is no envelope', async () => {
        const f = fakeFetch({ json: { ok: true } });

        await expect(client(f).get('/x')).resolves.toEqual({ ok: true });
    });

    it('hands over the whole body (data and meta) when asked for the envelope', async () => {
        const f = fakeFetch({
            json: { data: [{ id: 1 }], meta: { next_cursor: 'c2' } },
        });

        await expect(client(f).get('/x', { envelope: true })).resolves.toEqual({
            data: [{ id: 1 }],
            meta: { next_cursor: 'c2' },
        });
    });

    it('passes the cache mode to fetch only when one is given', async () => {
        const f = fakeFetch({ json: { data: 1 } }, { json: { data: 2 } });

        await client(f).get('/qr', { cache: 'no-store' });
        await client(f).get('/other');

        expect(f.calls[0].init.cache).toBe('no-store');
        expect('cache' in f.calls[1].init).toBe(false);
    });

    it('still unwraps by default and still throws the error envelope with the option', async () => {
        const f = fakeFetch(
            { json: { data: [1], meta: { next_cursor: null } } },
            {
                status: 403,
                json: { error: { code: 'forbidden', message: 'No.' } },
            },
        );

        await expect(client(f).get('/x')).resolves.toEqual([1]);
        await expect(
            client(f).get('/x', { envelope: true }),
        ).rejects.toMatchObject({ code: 'forbidden', status: 403 });
    });
});

describe('errors', () => {
    it('turns the error envelope into an ApiError with field details', async () => {
        const f = fakeFetch({
            status: 422,
            json: {
                error: {
                    code: 'validation_failed',
                    message: 'Invalid data',
                    details: {
                        'config.theme.primary': ['Use a hex color'],
                        name: 'Too short',
                    },
                },
            },
        });
        const error = await client(f)
            .put('/api/v1/widgets/w1/draft', {})
            .catch((e: unknown) => e);

        expect(isApiError(error)).toBe(true);

        const api = error as ApiError;

        expect(api.status).toBe(422);
        expect(api.isValidation).toBe(true);
        expect(api.code).toBe('validation_failed');
        expect(api.message).toBe('Invalid data');
        expect(api.details).toEqual({
            'config.theme.primary': ['Use a hex color'],
            name: ['Too short'],
        });
        expect(api.firstMessage('name')).toBe('Too short');
        expect(api.firstMessage()).toBe('Use a hex color');
    });

    it('keeps domain error codes such as category_in_use', async () => {
        const f = fakeFetch({
            status: 409,
            json: { error: { code: 'category_in_use', message: 'In use' } },
        });
        const error = (await client(f)
            .delete('/api/v1/categories/c1')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.status).toBe(409);
        expect(error.code).toBe('category_in_use');
    });

    it('falls back to Laravel validation errors without an envelope', async () => {
        const f = fakeFetch({
            status: 422,
            json: {
                message: 'The name field is required.',
                errors: { name: ['Required'] },
            },
        });
        const error = (await client(f)
            .post('/x', {})
            .catch((e: unknown) => e)) as ApiError;

        expect(error.details).toEqual({ name: ['Required'] });
    });

    it('classifies a non-JSON server error as server_error', async () => {
        const f = fakeFetch({ status: 502 });
        const error = (await client(f)
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.status).toBe(502);
        expect(error.code).toBe('server_error');
    });

    it('reloads on 401 (via onUnauthenticated) and still rejects', async () => {
        const onUnauthenticated = vi.fn();
        const f = fakeFetch({
            status: 401,
            json: { error: { code: 'unauthenticated', message: 'No' } },
        });
        const error = (await client(f, { onUnauthenticated })
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(onUnauthenticated).toHaveBeenCalledTimes(1);
        expect(error.code).toBe('unauthenticated');
    });

    it('does not treat a 403 as a sign-out', async () => {
        const onUnauthenticated = vi.fn();
        const f = fakeFetch({
            status: 403,
            json: { error: { code: 'forbidden', message: 'No' } },
        });

        await client(f, { onUnauthenticated })
            .get('/x')
            .catch(() => {});

        expect(onUnauthenticated).not.toHaveBeenCalled();
    });

    it('refreshes the CSRF cookie once on 419 and retries the request', async () => {
        const f = fakeFetch(
            { status: 419 },
            { status: 204 },
            { json: { data: { saved: true } } },
        );
        const result = await client(f).patch('/api/v1/widgets/w1', {
            name: 'x',
        });

        expect(result).toEqual({ saved: true });
        expect(f.calls.map((c) => c.url)).toEqual([
            '/api/v1/widgets/w1',
            '/sanctum/csrf-cookie',
            '/api/v1/widgets/w1',
        ]);
    });

    it('reports csrf_mismatch when the retry is rejected too', async () => {
        const f = fakeFetch({ status: 419 }, { status: 204 }, { status: 419 });
        const error = (await client(f)
            .post('/x', {})
            .catch((e: unknown) => e)) as ApiError;

        expect(error.status).toBe(419);
        expect(error.code).toBe('csrf_mismatch');
        expect(f.calls).toHaveLength(3);
    });

    it('does not retry a 419 when the cookie endpoint is disabled', async () => {
        const f = fakeFetch({ status: 419 });

        await client(f, { csrfCookieUrl: null })
            .post('/x', {})
            .catch(() => {});

        expect(f.calls).toHaveLength(1);
    });

    it('reads Retry-After seconds on a 429', async () => {
        const f = fakeFetch({ status: 429, headers: { 'Retry-After': '17' } });
        const error = (await client(f)
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.code).toBe('rate_limited');
        expect(error.retryAfter).toBe(17);
    });

    it('reads a Retry-After HTTP date and never goes negative', async () => {
        const past = new Date(Date.now() - 60_000).toUTCString();
        const f = fakeFetch({ status: 429, headers: { 'Retry-After': past } });
        const error = (await client(f)
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.retryAfter).toBe(0);
    });

    it('maps a rejected fetch to a network ApiError', async () => {
        const f = fakeFetch(new TypeError('Failed to fetch'));
        const error = (await client(f)
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.status).toBe(0);
        expect(error.code).toBe('network');
    });

    it('lets an aborted request surface as an AbortError, not an ApiError', async () => {
        const abort = new DOMException('aborted', 'AbortError');
        const f = fakeFetch(abort);
        const error = await client(f)
            .get('/x')
            .catch((e: unknown) => e);

        expect(error).toBe(abort);
    });

    it('rejects a 200 whose body is not JSON', async () => {
        const f = fakeFetch({ status: 200 });
        const error = (await client(f)
            .get('/x')
            .catch((e: unknown) => e)) as ApiError;

        expect(error.code).toBe('invalid_response');
    });
});

describe('describeApiError on a validation failure', () => {
    const t = (key: string) => key;
    const invalid = (details: Record<string, string[]>) =>
        new ApiError({
            status: 422,
            code: 'validation_failed',
            message: 'The given data was invalid.',
            details,
        });

    it('shows the first server message without the dotted attribute it embeds', () => {
        expect(
            describeApiError(
                invalid({
                    'config.hours.holidays.1.date': [
                        'The config.hours.holidays.1.date field has a duplicate value.',
                    ],
                }),
                t,
            ),
        ).toBe('The hours holidays #2 date field has a duplicate value.');
    });

    it('keeps messages of plain fields and custom texts as they are', () => {
        expect(
            describeApiError(
                invalid({ email: ['The email has already been taken.'] }),
                t,
            ),
        ).toBe('The email has already been taken.');
        expect(describeApiError(invalid({}), t)).toBe(
            'The given data was invalid.',
        );
    });
});

describe('describeApiError', () => {
    const t = (key: string, replacements?: Record<string, string | number>) =>
        replacements ? `${key}:${JSON.stringify(replacements)}` : key;

    it('maps transport problems to translated messages', () => {
        const make = (code: string, extra = {}) =>
            new ApiError({ status: 0, code, message: 'raw', ...extra });

        expect(describeApiError(make('network'), t)).toBe(
            'widgets.api.error.network',
        );
        expect(describeApiError(make('csrf_mismatch'), t)).toBe(
            'widgets.api.error.csrf',
        );
        expect(describeApiError(make('unauthenticated'), t)).toBe(
            'widgets.api.error.unauthenticated',
        );
        expect(
            describeApiError(make('rate_limited', { retryAfter: 9 }), t),
        ).toBe('widgets.api.error.rate_limited_after:{"seconds":9}');
        expect(describeApiError(make('rate_limited'), t)).toBe(
            'widgets.api.error.rate_limited',
        );
        expect(describeApiError(make('server_error'), t)).toBe(
            'widgets.api.error.server',
        );
    });

    it('shows the server message for domain errors and the first message for 422s', () => {
        expect(
            describeApiError(
                new ApiError({
                    status: 409,
                    code: 'managed_by_auth_portal',
                    message: 'Managed in the portal.',
                }),
                t,
            ),
        ).toBe('Managed in the portal.');
        expect(
            describeApiError(
                new ApiError({
                    status: 422,
                    code: 'validation_failed',
                    message: 'Invalid',
                    details: { email: ['Taken'] },
                }),
                t,
            ),
        ).toBe('Taken');
    });

    it('has a fallback for anything else', () => {
        expect(describeApiError(new Error('boom'), t)).toBe(
            'widgets.api.error.unknown',
        );
    });
});
