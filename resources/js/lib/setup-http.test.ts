import { describe, expect, it, vi } from 'vite-plus/test';
import { executeRun } from '@/lib/setup-flow';
import {
    createRunStepClient,
    interpretRunResponse,
    readXsrfToken,
} from '@/lib/setup-http';
import { setupRoutes } from '@/lib/setup-routes';

const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });

describe('setupRoutes', () => {
    it('matches docs/contracts/setup-wizard.md', () => {
        expect(setupRoutes.index.url).toBe('/setup');
        expect(setupRoutes.token.url).toBe('/setup/token');
        expect(setupRoutes.mode.url).toBe('/setup/mode');
        expect(setupRoutes.admin.url).toBe('/setup/admin');
        expect(setupRoutes.basics.url).toBe('/setup/basics');
        expect(setupRoutes.state.url).toBe('/setup/state');
        expect(setupRoutes.run('run-migrations')).toBe(
            '/setup/run/run-migrations',
        );
    });

    it('exposes Wayfinder-shaped form definitions', () => {
        expect(setupRoutes.token.form()).toEqual({
            action: '/setup/token',
            method: 'post',
        });
    });
});

describe('readXsrfToken', () => {
    it('reads and decodes the XSRF-TOKEN cookie', () => {
        expect(readXsrfToken('a=1; XSRF-TOKEN=abc%3D%3D; b=2')).toBe('abc==');
    });

    it('returns null when the cookie is missing', () => {
        expect(readXsrfToken('a=1; b=2')).toBeNull();
        expect(readXsrfToken('')).toBeNull();
    });
});

describe('interpretRunResponse', () => {
    it('maps ok, failed and redirect answers', async () => {
        expect(
            await interpretRunResponse(
                json({ status: 'ok', next: 'seed-defaults' }),
            ),
        ).toEqual({ status: 'ok', next: 'seed-defaults', redirect: null });
        expect(
            await interpretRunResponse(
                json({ status: 'ok', next: null, redirect: '/login' }),
            ),
        ).toEqual({ status: 'ok', next: null, redirect: '/login' });
        expect(
            await interpretRunResponse(
                json({ status: 'failed', message: 'Could not connect' }),
            ),
        ).toEqual({ status: 'failed', message: 'Could not connect' });
    });

    it('does not report a plain 404 as "already installed"', async () => {
        expect(
            await interpretRunResponse(json({ message: 'Not Found' }, 404)),
        ).toEqual({
            status: 'failed',
            code: 'server',
        });
        expect(
            await interpretRunResponse(
                new Response('<html>nope</html>', { status: 404 }),
            ),
        ).toEqual({ status: 'failed', code: 'server' });
    });

    it('maps the documented HTTP statuses', async () => {
        expect(await interpretRunResponse(json({}, 409))).toEqual({
            status: 'failed',
            code: 'conflict',
        });
        expect(await interpretRunResponse(json({}, 403))).toEqual({
            status: 'failed',
            code: 'forbidden',
        });
        expect(
            await interpretRunResponse(json({ status: 'installed' }, 404)),
        ).toEqual({ status: 'installed' });
        expect(await interpretRunResponse(json({}, 419))).toEqual({
            status: 'failed',
            code: 'session_expired',
        });
        expect(await interpretRunResponse(json({}, 429))).toEqual({
            status: 'failed',
            code: 'throttled',
        });
    });

    it('falls back to per-field errors when a failed step has no message', async () => {
        expect(
            await interpretRunResponse(
                json({
                    status: 'failed',
                    fields: {
                        email: ['The email is invalid.'],
                        name: 'Required.',
                    },
                }),
            ),
        ).toEqual({
            status: 'failed',
            message: 'The email is invalid. Required.',
        });
    });

    it('surfaces a server error message and flags unexpected bodies', async () => {
        expect(
            await interpretRunResponse(json({ message: 'Server Error' }, 500)),
        ).toEqual({
            status: 'failed',
            message: 'Server Error',
            code: 'server',
        });
        expect(
            await interpretRunResponse(new Response('<html>', { status: 200 })),
        ).toMatchObject({ status: 'failed', code: 'invalid_response' });
    });
});

describe('createRunStepClient', () => {
    it('POSTs JSON with the XSRF header to the run endpoint', async () => {
        const fetchImpl = vi.fn(async () =>
            json({ status: 'ok', next: 'seed-defaults' }),
        );
        const client = createRunStepClient({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            xsrfToken: () => 'token-123',
        });

        await client('run-migrations');

        expect(fetchImpl).toHaveBeenCalledWith('/setup/run/run-migrations', {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'X-Requested-With': 'XMLHttpRequest',
                'X-XSRF-TOKEN': 'token-123',
            },
            credentials: 'same-origin',
        });
    });

    it('omits the XSRF header when there is no cookie', async () => {
        const fetchImpl = vi.fn(async () => json({ status: 'ok', next: null }));
        const client = createRunStepClient({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            xsrfToken: () => null,
        });

        await client('write-lock');

        const [, init] = fetchImpl.mock.calls[0] as unknown as [
            string,
            RequestInit,
        ];

        expect(init.headers).not.toHaveProperty('X-XSRF-TOKEN');
    });

    it('drives a full run against a fake server, including a failure and resume', async () => {
        let migrationsCalls = 0;
        const fetchImpl = vi.fn(async (url: string) => {
            if (url.endsWith('run-migrations')) {
                return ++migrationsCalls === 1
                    ? json({ status: 'failed', message: 'No database' })
                    : json({ status: 'ok', next: 'write-lock' });
            }

            return json({ status: 'ok', next: null, redirect: '/login' });
        });
        const runStep = createRunStepClient({
            fetchImpl: fetchImpl as unknown as typeof fetch,
            xsrfToken: () => null,
        });
        const rows = [
            { key: 'run-migrations', label: 'm', status: 'pending' as const },
            { key: 'write-lock', label: 'l', status: 'pending' as const },
        ];

        const first = await executeRun({ rows, runStep });
        const second = await executeRun({ rows: first.rows, runStep });

        expect(first.outcome).toBe('failed');
        expect(first.rows[0].message).toBe('No database');
        expect(second).toMatchObject({
            outcome: 'completed',
            redirect: '/login',
        });
    });
});
