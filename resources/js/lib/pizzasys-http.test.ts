import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createPortalClient,
    fieldErrorsOf,
    isKnownCheckKey,
    parseTestResult,
} from '@/lib/pizzasys-http';

type Reply = { status?: number; body?: unknown; raw?: string };

function clientWith(reply: Reply | (() => Promise<Response>)) {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) => {
        if (typeof reply === 'function') {
            return reply();
        }

        return new Response(reply.raw ?? JSON.stringify(reply.body ?? {}), {
            status: reply.status ?? 200,
        });
    });

    return {
        fetchImpl,
        client: createPortalClient({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            xsrfToken: () => 'xsrf-token',
        }),
    };
}

const okResult = {
    ok: true,
    checks: [
        { key: 'reachable', label: 'Portal reachable', ok: true },
        { key: 'latency', label: 'Latency', ok: true, message: '212 ms' },
    ],
};

describe('testConnection', () => {
    it('posts JSON with the XSRF header and returns the parsed result', async () => {
        const { client, fetchImpl } = clientWith({ body: okResult });
        const outcome = await client.testConnection('/setup/pizzasys/test', {
            env: 'production',
        });

        expect(outcome).toEqual({ status: 'done', result: okResult });

        const [url, init] = fetchImpl.mock.calls[0];
        const headers = init?.headers as Record<string, string>;

        expect(url).toBe('/setup/pizzasys/test');
        expect(init?.method).toBe('POST');
        expect(init?.body).toBe(JSON.stringify({ env: 'production' }));
        expect(headers['X-XSRF-TOKEN']).toBe('xsrf-token');
        expect(headers.Accept).toBe('application/json');
        expect(headers['Content-Type']).toBe('application/json');
    });

    it('carries failing checks through unchanged so the UI can explain them', async () => {
        const failing = {
            ok: false,
            checks: [
                { key: 'reachable', label: 'Reachable', ok: true },
                {
                    key: 'service_credential',
                    label: 'Service credential',
                    ok: false,
                    message: 'HTTP 401: Invalid service token.',
                },
            ],
        };
        const { client } = clientWith({ body: failing });
        const outcome = await client.testConnection('/x');

        expect(outcome).toEqual({ status: 'done', result: failing });
    });

    it('never echoes anything it was not given: the request body is only what the caller sent', async () => {
        const { client, fetchImpl } = clientWith({ body: okResult });

        await client.testConnection('/settings/auth/environments/testing/test');

        // The settings test has no body at all (it tests the saved values).
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify({}));
    });

    it('maps transport and HTTP failures onto codes', async () => {
        const cases: [number, string][] = [
            [403, 'forbidden'],
            [401, 'session_expired'],
            [419, 'session_expired'],
            [404, 'not_found'],
            [429, 'throttled'],
            [500, 'server'],
            [502, 'server'],
        ];

        for (const [status, code] of cases) {
            const { client } = clientWith({ status, body: {} });

            expect(await client.testConnection('/x')).toMatchObject({
                status: 'error',
                code,
            });
        }

        const offline = clientWith(async () => {
            throw new TypeError('Failed to fetch');
        });

        expect(await offline.client.testConnection('/x')).toEqual({
            status: 'error',
            code: 'network',
        });
    });

    it('reports a 422 as a validation failure with the server message', async () => {
        const { client } = clientWith({
            status: 422,
            body: {
                message: 'The testing environment is not configured.',
                errors: { env: ['The testing environment is not configured.'] },
            },
        });

        expect(await client.testConnection('/x', { env: 'testing' })).toEqual({
            status: 'error',
            code: 'validation',
            message: 'The testing environment is not configured.',
            fieldErrors: { env: 'The testing environment is not configured.' },
        });
    });

    it('rejects an answer that is not a PortalTestResult', async () => {
        for (const body of [
            {},
            { ok: true },
            { ok: 'yes', checks: [] },
            null,
        ]) {
            const { client } = clientWith({ body });

            expect(await client.testConnection('/x')).toMatchObject({
                status: 'error',
                code: 'invalid_response',
            });
        }

        const html = clientWith({ raw: '<html>oops</html>' });

        expect(await html.client.testConnection('/x')).toMatchObject({
            code: 'invalid_response',
        });
    });
});

describe('parseTestResult', () => {
    it('drops malformed checks and defaults a missing label to the key', () => {
        expect(
            parseTestResult({
                ok: false,
                checks: [
                    { key: 'nats', ok: false },
                    { label: 'no key', ok: true },
                    { key: 'latency', label: 5, ok: true },
                    'junk',
                ],
            }),
        ).toEqual({
            ok: false,
            checks: [
                { key: 'nats', label: 'nats', ok: false },
                { key: 'latency', label: 'latency', ok: true },
            ],
        });
    });

    it('knows the contract keys', () => {
        expect(isKnownCheckKey('service_credential')).toBe(true);
        expect(isKnownCheckKey('tls')).toBe(false);
    });
});

describe('portalAdminLogin', () => {
    const credentials = { email: 'admin@example.com', password: 'pw' };

    it('returns the verified admin', async () => {
        const { client, fetchImpl } = clientWith({
            body: {
                ok: true,
                user: { name: 'Mina Haddad', email: 'admin@example.com' },
                isAdmin: true,
            },
        });

        expect(
            await client.portalAdminLogin('/setup/portal-admin', credentials),
        ).toEqual({
            status: 'ok',
            user: { name: 'Mina Haddad', email: 'admin@example.com' },
        });
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(
            JSON.stringify(credentials),
        );
    });

    it('treats isAdmin:false as "not an admin" even if the server said ok', async () => {
        const { client } = clientWith({
            body: {
                ok: true,
                user: { name: 'A', email: 'a@b.c' },
                isAdmin: false,
            },
        });

        expect(await client.portalAdminLogin('/x', credentials)).toEqual({
            status: 'rejected',
            code: 'not_admin',
            message: undefined,
        });
    });

    it('keeps each rejection code distinct (HTTP 200 and 422 alike)', async () => {
        for (const code of [
            'invalid',
            'unavailable',
            'no_chat_access',
            'not_admin',
        ]) {
            for (const status of [200, 422]) {
                const { client } = clientWith({
                    status,
                    body: { ok: false, message: `m-${code}`, code },
                });

                expect(
                    await client.portalAdminLogin('/x', credentials),
                ).toEqual({
                    status: 'rejected',
                    code,
                    message: `m-${code}`,
                });
            }
        }
    });

    it('falls back to "unknown" for a code this UI does not know', async () => {
        const { client } = clientWith({
            status: 422,
            body: { ok: false, message: 'Nope', code: 'banned' },
        });

        expect(await client.portalAdminLogin('/x', credentials)).toMatchObject({
            status: 'rejected',
            code: 'unknown',
        });
    });

    it('surfaces Laravel validation errors per field', async () => {
        const { client } = clientWith({
            status: 422,
            body: {
                message: 'The email field is required.',
                errors: { email: ['The email field is required.'] },
            },
        });

        expect(await client.portalAdminLogin('/x', credentials)).toEqual({
            status: 'error',
            code: 'validation',
            message: 'The email field is required.',
            fieldErrors: { email: 'The email field is required.' },
        });
    });

    it('maps throttling, an expired session and a dropped connection', async () => {
        expect(
            await clientWith({ status: 429 }).client.portalAdminLogin(
                '/x',
                credentials,
            ),
        ).toMatchObject({ code: 'throttled' });
        expect(
            await clientWith({ status: 419 }).client.portalAdminLogin(
                '/x',
                credentials,
            ),
        ).toMatchObject({ code: 'session_expired' });
        expect(
            await clientWith(async () => {
                throw new Error('offline');
            }).client.portalAdminLogin('/x', credentials),
        ).toEqual({ status: 'error', code: 'network' });
    });
});

describe('switchEnvironment', () => {
    const payload = {
        env: 'testing' as const,
        email: 'admin@example.com',
        password: 'pw',
        confirm: true as const,
    };

    it('follows the redirect the server names', async () => {
        const { client, fetchImpl } = clientWith({
            body: { ok: true, redirect: '/login' },
        });

        expect(
            await client.switchEnvironment(
                '/settings/auth/active-environment',
                payload,
            ),
        ).toEqual({ status: 'ok', redirect: '/login' });
        expect(fetchImpl.mock.calls[0][1]?.body).toBe(JSON.stringify(payload));
    });

    it('only ever follows same-origin paths', async () => {
        for (const redirect of [
            'https://evil.example/login',
            '//evil.example',
            '/\\evil',
        ]) {
            const { client } = clientWith({ body: { ok: true, redirect } });

            expect(await client.switchEnvironment('/x', payload)).toEqual({
                status: 'ok',
                redirect: '/login',
            });
        }
    });

    it('reports a refused switch with the server message', async () => {
        const { client } = clientWith({
            status: 422,
            body: {
                ok: false,
                message: 'That account is not an admin on Testing.',
            },
        });

        expect(await client.switchEnvironment('/x', payload)).toEqual({
            status: 'rejected',
            message: 'That account is not an admin on Testing.',
        });
    });

    it('distinguishes validation, permission and server failures', async () => {
        expect(
            await clientWith({
                status: 422,
                body: { message: 'm', errors: { password: ['Required.'] } },
            }).client.switchEnvironment('/x', payload),
        ).toMatchObject({
            status: 'error',
            code: 'validation',
            fieldErrors: { password: 'Required.' },
        });
        expect(
            await clientWith({ status: 403 }).client.switchEnvironment(
                '/x',
                payload,
            ),
        ).toMatchObject({ code: 'forbidden' });
        expect(
            await clientWith({ status: 500 }).client.switchEnvironment(
                '/x',
                payload,
            ),
        ).toMatchObject({ code: 'server' });
    });
});

describe('fieldErrorsOf', () => {
    it('takes the first message per field and ignores non-validation bodies', () => {
        expect(
            fieldErrorsOf({ errors: { a: ['one', 'two'], b: 'plain', c: [] } }),
        ).toEqual({ a: 'one', b: 'plain' });
        expect(fieldErrorsOf({ message: 'x' })).toBeUndefined();
        expect(fieldErrorsOf(null)).toBeUndefined();
    });
});
