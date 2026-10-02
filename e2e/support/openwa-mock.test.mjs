/* oxlint-disable typescript/no-floating-promises, typescript/require-array-sort-compare -- node:test's describe()/test() return promises the runner collects itself */
/**
 * The test of the OpenWA mock itself (`node --test e2e/support/openwa-mock.test.mjs`, no dependencies, no browser, no Docker).
 *
 * Two things are proved: the mock really behaves like the OpenWA the fixtures were recorded from (status codes and bodies compared with
 * `tests/fixtures/openwa/*.json`, delivery headers / signature / idempotency keys / retries, the documented message shapes), and its control
 * API does what the specs rely on. Ports: the mock 8379, a local webhook receiver 8378, the CLI check 8377 (all inside the 6C range).
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { after, before, beforeEach, describe, test } from 'node:test';
import {
    DEFAULT_API_KEY,
    fakeQrDataUrl,
    sign,
    startOpenWaMock,
    WEBHOOK_EVENTS,
} from './openwa-mock.mjs';

const MOCK_PORT = 8379;
const RECEIVER_PORT = 8378;
const CLI_PORT = 8377;
const FIXTURES = new URL('../../tests/fixtures/openwa/', import.meta.url);
const fixture = (name) =>
    JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

/** UUIDs and the recorder's `rec-...` names differ per recording: compare everything else exactly. */
const normalise = (value) =>
    JSON.parse(
        JSON.stringify(value)
            .replace(
                /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
                '<uuid>',
            )
            .replace(/rec-[a-z]+-[a-z0-9]+/g, '<name>'),
    );

/** The structure of a value: keys and types, not the values. */
function shape(value) {
    if (value === null) {
        return 'null';
    }

    if (Array.isArray(value)) {
        return [value.length === 0 ? 'empty' : shape(value[0])];
    }

    if (typeof value === 'object') {
        return Object.fromEntries(
            Object.keys(value)
                .sort()
                .map((key) => [key, shape(value[key])]),
        );
    }

    return typeof value;
}

let mock;
let hits;
let receiverStatus;
let receiver;

async function api(
    method,
    path,
    { body, key = DEFAULT_API_KEY, raw, contentType } = {},
) {
    const headers = key === null ? {} : { 'X-API-Key': key };
    const payload =
        raw ?? (body === undefined ? undefined : JSON.stringify(body));

    if (payload !== undefined) {
        headers['Content-Type'] = contentType ?? 'application/json';
    }

    const response = await fetch(`${mock.url}${path}`, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: 'manual',
    });
    const text = await response.text();
    let parsed = text;

    try {
        parsed = text === '' ? null : JSON.parse(text);
    } catch {
        // bytes or plain text
    }

    return {
        status: response.status,
        body: parsed,
        text,
        headers: response.headers,
    };
}

const control = (method, path, body) => api(method, path, { body, key: null });
const ok = (result, status = 200) => {
    assert.equal(
        result.status,
        status,
        `HTTP ${result.status}: ${result.text.slice(0, 300)}`,
    );

    return result.body;
};

/** The recorded fixture's status and body (names / ids normalised) equal what the mock answered. */
function assertSame(name, actual) {
    const expected = fixture(name).response;

    assert.equal(actual.status, expected.status, `${name}: status`);
    assert.deepEqual(
        normalise(actual.body),
        normalise(expected.body),
        `${name}: body`,
    );
}

/** Same status and same structure (keys and types). */
function assertShape(name, actual) {
    const expected = fixture(name).response;

    assert.equal(actual.status, expected.status, `${name}: status`);
    assert.deepEqual(
        shape(actual.body),
        shape(expected.body),
        `${name}: shape`,
    );
}

async function createSession(
    name = `rec-test-${Math.random().toString(36).slice(2, 7)}`,
) {
    return ok(await api('POST', '/api/sessions', { body: { name } }), 201);
}

async function readySession(name) {
    const session = await createSession(name);

    await control('POST', `/__mock/sessions/${session.id}/status`, {
        status: 'ready',
        phone: '4915100000000',
    });

    return session;
}

async function hook(
    session,
    {
        events = ['*'],
        retryCount,
        path = '/hook',
        secret = 'test-webhook-secret-0123456789abcdef',
    } = {},
) {
    return ok(
        await api('POST', `/api/sessions/${session.id}/webhooks`, {
            body: {
                url: `http://127.0.0.1:${RECEIVER_PORT}${path}`,
                secret,
                events,
                ...(retryCount === undefined ? {} : { retryCount }),
            },
        }),
        201,
    );
}

async function waitFor(predicate, what, timeoutMs = 3000) {
    const until = Date.now() + timeoutMs;

    for (;;) {
        const found = predicate();

        if (found) {
            return found;
        }

        assert.ok(
            Date.now() < until,
            `timed out waiting for ${what} (hits so far: ${hits.map((hit) => hit.headers['x-openwa-event']).join(', ')})`,
        );
        await sleep(15);
    }
}

before(async () => {
    mock = await startOpenWaMock({ port: MOCK_PORT, retryBaseMs: 40 });
    hits = [];
    receiverStatus = () => 200;
    receiver = createServer((request, response) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', () => {
            const hit = {
                at: Date.now(),
                path: request.url,
                headers: request.headers,
                raw: Buffer.concat(chunks).toString('utf8'),
            };

            hits.push(hit);

            const status = receiverStatus(hit);

            response.writeHead(
                status,
                status === 302 ? { location: '/hook' } : {},
            );
            response.end();
        });
    });
    await new Promise((done) =>
        receiver.listen(RECEIVER_PORT, '127.0.0.1', done),
    );
});

after(async () => {
    await mock.close();
    await new Promise((done) => {
        receiver.closeAllConnections?.();
        receiver.close(() => done());
    });
});

beforeEach(async () => {
    await control('POST', '/__mock/reset');
    hits.length = 0;
    receiverStatus = () => 200;
});

describe('fixtures', () => {
    test('index.json lists every fixture, each is recorded or documented, and no file holds a key', () => {
        const files = readdirSync(FIXTURES).filter(
            (file) => file.endsWith('.json') && file !== 'index.json',
        );
        const index = fixture('index').fixtures;

        assert.deepEqual(
            index.map((entry) => entry.file),
            [...files].sort(),
            'run `node scripts/openwa-record.mjs --index-only`',
        );

        for (const entry of index) {
            assert.ok(
                ['recorded', 'documented'].includes(entry.source),
                `${entry.file}: source`,
            );
        }

        assert.ok(
            index.filter((entry) => entry.source === 'recorded').length >= 60,
        );
        assert.ok(
            index.filter((entry) => entry.source === 'documented').length >= 20,
        );

        for (const file of files) {
            const text = readFileSync(new URL(file, FIXTURES), 'utf8');

            assert.doesNotMatch(
                text,
                /owa_k1_(?!REDACTED)/,
                `${file} holds something that looks like an API key`,
            );
        }
    });

    test('the recorded deliveries verify with the rule the mock signs by: sha256= + HMAC-SHA256 over the raw body', () => {
        const recorded = readdirSync(FIXTURES).filter(
            (file) =>
                file.startsWith('webhook-delivery-') &&
                file !== 'webhook-delivery-retries.json',
        );
        let verified = 0;

        for (const file of recorded) {
            const content = JSON.parse(
                readFileSync(new URL(file, FIXTURES), 'utf8'),
            );

            if (!content.verification.reverifiableFromThisFile) {
                continue;
            }

            assert.equal(
                sign(content.verification.secret, content.request.rawBody),
                content.request.headers['x-openwa-signature'],
                file,
            );
            verified += 1;
        }

        assert.ok(
            verified >= 4,
            'at least the status and test deliveries re-verify',
        );
    });
});

describe('API key rules', () => {
    test('validate, missing key, invalid key, bearer', async () => {
        assertShape(
            'auth-validate-ok',
            await api('POST', '/api/auth/validate'),
        );
        assertSame(
            'auth-validate-missing-key',
            await api('POST', '/api/auth/validate', { key: null }),
        );
        assertSame(
            'auth-validate-invalid-key',
            await api('POST', '/api/auth/validate', { key: 'owa_k1_nope' }),
        );

        const bearer = await fetch(`${mock.url}/api/auth/validate`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${DEFAULT_API_KEY}` },
        });

        assert.equal(bearer.status, 200);
    });

    test('roles and scoped keys answer like the real image (a scoped key outside its session is a 401, not a 403)', async () => {
        const viewer = ok(
            await control('POST', '/__mock/keys', { role: 'viewer' }),
            201,
        );
        const own = await createSession('rec-own-session');
        const other = await createSession('rec-other-session');
        const scoped = ok(
            await control('POST', '/__mock/keys', {
                role: 'operator',
                allowedSessions: [own.id],
            }),
            201,
        );

        assertSame(
            'auth-viewer-create-session-forbidden',
            await api('POST', '/api/sessions', {
                body: { name: 'rec-viewer-try' },
                key: viewer.key,
            }),
        );
        assertSame(
            'auth-scoped-create-session-forbidden',
            await api('POST', '/api/sessions', {
                body: { name: 'rec-scoped-try' },
                key: scoped.key,
            }),
        );
        assert.equal(
            (await api('GET', `/api/sessions/${own.id}`, { key: scoped.key }))
                .status,
            200,
        );
        assertSame(
            'auth-scoped-other-session',
            await api('GET', `/api/sessions/${other.id}`, { key: scoped.key }),
        );
        assert.equal(
            (await api('GET', '/api/sessions', { key: scoped.key })).body
                .length,
            1,
            'a scoped key lists only its sessions',
        );
        assert.equal(
            (
                await api('POST', `/api/sessions/${own.id}/webhooks`, {
                    key: viewer.key,
                    body: { url: 'https://example.com/x' },
                })
            ).status,
            403,
        );
    });

    test('health is public and shows the version only to a key; unknown routes are NestJS 404s before any key check', async () => {
        assert.deepEqual(
            Object.keys(
                (await api('GET', '/api/health', { key: null })).body,
            ).sort(),
            ['status', 'timestamp'],
        );
        assert.equal((await api('GET', '/api/health')).body.version, '0.23.7');
        assert.deepEqual(
            (await api('GET', '/api/health/ready', { key: null })).body,
            fixture('system-health-ready').response.body,
        );
        assert.deepEqual(
            (await api('GET', '/api/nothing-here', { key: null })).body,
            {
                message: 'Cannot GET /api/nothing-here',
                error: 'Not Found',
                statusCode: 404,
            },
        );
    });
});

describe('sessions', () => {
    test('create, validation, duplicate, malformed body (production wording) equal the recordings', async () => {
        assertShape(
            'sessions-create',
            await api('POST', '/api/sessions', {
                body: { name: 'rec-plain-aaaaa' },
            }),
        );
        assertSame(
            'sessions-create-duplicate',
            await api('POST', '/api/sessions', {
                body: { name: 'rec-plain-aaaaa' },
            }),
        );
        assertSame(
            'sessions-create-name-too-short',
            await api('POST', '/api/sessions', { body: { name: 'ab' } }),
        );
        assertSame(
            'sessions-create-name-characters',
            await api('POST', '/api/sessions', { body: { name: 'has space' } }),
        );
        assertSame(
            'sessions-create-name-too-long',
            await api('POST', '/api/sessions', {
                body: { name: 'x'.repeat(51) },
            }),
        );
        assertSame(
            'sessions-create-missing-name',
            await api('POST', '/api/sessions', { body: {} }),
        );
        assertSame(
            'sessions-create-unknown-property',
            await api('POST', '/api/sessions', {
                body: { name: 'rec-extra-bbbbb', surprise: 1 },
            }),
        );
        assertSame(
            'sessions-create-malformed-json',
            await api('POST', '/api/sessions', { raw: '{bad json' }),
        );
    });

    test('VALIDATION_ERROR_DETAIL gives the array bodies of the strict recordings', async () => {
        await control('POST', '/__mock/config', { validationDetail: true });
        assertSame(
            'strict-sessions-create-name-too-short',
            await api('POST', '/api/sessions', { body: { name: 'ab' } }),
        );
        assertSame(
            'strict-sessions-create-name-characters',
            await api('POST', '/api/sessions', { body: { name: 'has space' } }),
        );
        assertSame(
            'strict-sessions-create-missing-name',
            await api('POST', '/api/sessions', { body: {} }),
        );
    });

    test('list, name filter, get, not found, not a UUID, delete', async () => {
        const session = await createSession('rec-plain-ccccc');

        assertShape('sessions-list', await api('GET', '/api/sessions'));
        assertShape(
            'sessions-list-name-filter',
            await api('GET', '/api/sessions?name=rec-plain-ccccc'),
        );
        assertSame(
            'sessions-list-name-miss',
            await api('GET', '/api/sessions?name=rec-no-such-session'),
        );
        assertShape(
            'sessions-get',
            await api('GET', `/api/sessions/${session.id}`),
        );
        assertSame(
            'sessions-get-not-found',
            await api(
                'GET',
                '/api/sessions/00000000-0000-4000-8000-000000000000',
            ),
        );
        assertSame(
            'sessions-get-not-uuid',
            await api('GET', '/api/sessions/not-a-uuid'),
        );
        assertSame(
            'sessions-delete',
            await api('DELETE', `/api/sessions/${session.id}`),
        );
        assertSame(
            'sessions-delete-twice',
            await api('DELETE', `/api/sessions/${session.id}`),
        );
    });

    test('start BLOCKS until the QR waits, then stop / restart / QR / delete follow the recorded rules', async () => {
        await control('POST', '/__mock/config', { startDelayMs: 150 });

        const session = await createSession('rec-life-ddddd');

        assertSame(
            'sessions-qr-before-start',
            await api('GET', `/api/sessions/${session.id}/qr`),
        );
        assertShape(
            'sessions-stop-never-started',
            await api('POST', `/api/sessions/${session.id}/stop`),
        );

        const started = api('POST', `/api/sessions/${session.id}/start`);

        await sleep(50);
        // While the engine starts: `initializing`, no QR yet, a second start is refused.
        assertShape(
            'sessions-get-initializing',
            await api('GET', `/api/sessions/${session.id}`),
        );
        assert.equal(
            ok(await api('GET', `/api/sessions/${session.id}`)).status,
            'initializing',
        );
        assertSame(
            'sessions-qr-initializing',
            await api('GET', `/api/sessions/${session.id}/qr`),
        );
        assertSame(
            'sessions-start-twice',
            await api('POST', `/api/sessions/${session.id}/start`),
        );
        assertShape('sessions-start', await started);
        assert.equal(
            ok(await api('GET', `/api/sessions/${session.id}`)).status,
            'qr_ready',
        );

        const qr = await api('GET', `/api/sessions/${session.id}/qr`);

        assert.equal(qr.status, 200);
        assert.deepEqual(Object.keys(qr.body).sort(), ['qrCode', 'status']);
        assert.equal(qr.body.status, 'qr_ready');

        const png = Buffer.from(
            qr.body.qrCode.replace(/^data:image\/png;base64,/, ''),
            'base64',
        );

        assert.match(qr.body.qrCode, /^data:image\/png;base64,/);
        assert.deepEqual(
            [...png.subarray(0, 8)],
            [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
        );
        assert.equal(png.readUInt32BE(16), 276);
        assert.equal(png.readUInt32BE(20), 276);
        assert.ok(
            qr.body.qrCode.length < 200_000,
            'the app accepts a QR up to 200 kB',
        );
        assert.equal(
            fakeQrDataUrl('a') === fakeQrDataUrl('a'),
            true,
            'deterministic per seed',
        );

        assertShape(
            'sessions-stop',
            await api('POST', `/api/sessions/${session.id}/stop`),
        );
        assertSame(
            'sessions-qr-after-stop',
            await api('GET', `/api/sessions/${session.id}/qr`),
        );
        assertShape(
            'sessions-stop-twice',
            await api('POST', `/api/sessions/${session.id}/stop`),
        );

        // A paired session starts straight to ready (credentials are kept).
        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'ready',
            phone: '4915100000000',
        });
        await api('POST', `/api/sessions/${session.id}/stop`);

        const again = ok(
            await api('POST', `/api/sessions/${session.id}/start`),
        );

        assert.equal(again.status, 'ready');
        assert.equal(again.phone, '4915100000000');
        assertSame(
            'sessions-delete-running',
            await api('DELETE', `/api/sessions/${session.id}`),
        );
    });

    test('a deleted PAIRED session keeps its name for teardownPendingMs: 409 SESSION_NAME_TEARDOWN_PENDING', async () => {
        await control('POST', '/__mock/config', { teardownPendingMs: 200 });

        const session = await readySession('support-main');

        ok(await api('DELETE', `/api/sessions/${session.id}`), 204);

        const refused = await api('POST', '/api/sessions', {
            body: { name: 'support-main' },
        });

        assert.equal(
            refused.status,
            fixture('error-session-name-teardown-pending').response.status,
        );
        assert.equal(refused.body.code, 'SESSION_NAME_TEARDOWN_PENDING');
        assert.deepEqual(
            Object.keys(refused.body).sort(),
            Object.keys(
                fixture('error-session-name-teardown-pending').response.body,
            ).sort(),
        );
        await sleep(220);
        ok(
            await api('POST', '/api/sessions', {
                body: { name: 'support-main' },
            }),
            201,
        );
    });
});

describe('webhook registration', () => {
    test('create / list / get / update / delete answer in the recorded shapes and never return the secret', async () => {
        const session = await createSession();
        const created = await api(
            'POST',
            `/api/sessions/${session.id}/webhooks`,
            {
                body: {
                    url: `http://127.0.0.1:${RECEIVER_PORT}/hook`,
                    secret: 'test-webhook-secret-0123456789abcdef',
                    events: ['session.status', 'message.received'],
                },
            },
        );

        assertShape('webhooks-create', created);
        assert.equal(
            created.body.sessionId,
            session.id,
            'sessionId is the session UUID',
        );
        assert.equal(created.body.retryCount, 3);
        assert.equal(JSON.stringify(created.body).includes('secret'), false);
        assertShape(
            'webhooks-list',
            await api('GET', `/api/sessions/${session.id}/webhooks`),
        );
        assertShape(
            'webhooks-get',
            await api(
                'GET',
                `/api/sessions/${session.id}/webhooks/${created.body.id}`,
            ),
        );
        assertShape(
            'webhooks-update',
            await api(
                'PUT',
                `/api/sessions/${session.id}/webhooks/${created.body.id}`,
                { body: { retryCount: 4 } },
            ),
        );
        assertShape(
            'webhooks-list-all-sessions',
            await api('GET', '/api/webhooks'),
        );
        assertSame(
            'webhooks-get-not-found',
            await api(
                'GET',
                `/api/sessions/${session.id}/webhooks/00000000-0000-4000-8000-000000000000`,
            ),
        );
        assertSame(
            'webhooks-delete',
            await api(
                'DELETE',
                `/api/sessions/${session.id}/webhooks/${created.body.id}`,
            ),
        );
        assertSame(
            'webhooks-get-after-delete',
            await api(
                'GET',
                `/api/sessions/${session.id}/webhooks/${created.body.id}`,
            ),
        );

        // Deleting the session takes its webhooks along; the list of a deleted session is a 404 (the real image answers 404 too).
        await api('DELETE', `/api/sessions/${session.id}`);
        assert.equal(
            (await api('GET', `/api/sessions/${session.id}/webhooks`)).status,
            404,
        );
    });

    test('defaults and the rules of the real image: events, secret length, credentials, unknown event, limit of 16', async () => {
        const session = await createSession();
        const url = (path = '/hook') =>
            `http://127.0.0.1:${RECEIVER_PORT}${path}`;
        const post = (body) =>
            api('POST', `/api/sessions/${session.id}/webhooks`, { body });

        assert.deepEqual(
            (
                await post({
                    url: url(),
                    secret: 'test-webhook-secret-0123456789abcdef',
                })
            ).body.events,
            ['message.received'],
        );
        assertSame(
            'webhooks-create-secret-too-short',
            await post({ url: 'https://example.com/hook', secret: 'short' }),
        );
        assertSame(
            'webhooks-create-unknown-event',
            await post({
                url: 'https://example.com/hook',
                secret: 'test-webhook-secret-0123456789abcdef',
                events: ['nope.event'],
            }),
        );
        assertSame(
            'webhooks-create-url-credentials',
            await post({
                url: 'https://user:pass@example.com/hook',
                secret: 'test-webhook-secret-0123456789abcdef',
            }),
        );
        assertSame(
            'webhooks-create-unknown-session',
            await api(
                'POST',
                '/api/sessions/00000000-0000-4000-8000-000000000000/webhooks',
                {
                    body: {
                        url: url(),
                        secret: 'test-webhook-secret-0123456789abcdef',
                    },
                },
            ),
        );

        let last;

        for (let index = 1; index < 17; index += 1) {
            last = await post({
                url: url(`/hook?n=${index}`),
                secret: 'test-webhook-secret-0123456789abcdef',
            });
        }

        assertSame('webhooks-create-limit', last);
        assert.ok(
            WEBHOOK_EVENTS.includes('*') &&
                WEBHOOK_EVENTS.includes('session.reconnect_loop'),
        );
    });

    test('SSRF: loopback is allowed by default (the e2e app needs it), `strict` refuses private hosts like a real OpenWA without an allow-list', async () => {
        const session = await createSession();
        const post = (address) =>
            api('POST', `/api/sessions/${session.id}/webhooks`, {
                body: {
                    url: address,
                    secret: 'test-webhook-secret-0123456789abcdef',
                },
            });

        assert.equal((await post('http://localhost:8368/hook')).status, 201);
        await control('POST', '/__mock/config', { ssrf: 'strict' });
        assertSame(
            'webhooks-create-ssrf-loopback',
            await post('http://127.0.0.1:8368/hook'),
        );
        assertSame(
            'webhooks-create-ssrf-localhost',
            await post('http://localhost:8368/hook'),
        );
        assertSame(
            'webhooks-create-ssrf-private-ip',
            await post('http://10.0.0.5/hook'),
        );
        assertSame(
            'webhooks-create-ssrf-metadata-ip',
            await post('http://169.254.169.254/latest'),
        );
        assertSame(
            'strict-webhooks-create-ssrf-no-allowlist',
            await post('http://host.docker.internal:8368/hook'),
        );
        assert.equal(
            (await post('https://example.com/hook')).status,
            201,
            'a public host is fine',
        );
    });
});

describe('signed deliveries', () => {
    test('a status change is delivered with the headers, body, signature and idempotency key of the recorded deliveries', async () => {
        const session = await createSession('rec-hook-eeeee');
        const registered = await hook(session);

        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'qr_ready',
        });

        const delivery = await waitFor(
            () =>
                hits.find(
                    (hit) => hit.headers['x-openwa-event'] === 'session.status',
                ),
            'session.status',
        );
        const recorded = fixture(
            'webhook-delivery-session-status-qr-ready',
        ).request;
        const body = JSON.parse(delivery.raw);

        assert.deepEqual(
            Object.keys(delivery.headers)
                .filter(
                    (name) =>
                        name.startsWith('x-openwa') ||
                        ['content-type', 'user-agent'].includes(name),
                )
                .sort(),
            Object.keys(recorded.headers).sort(),
        );
        assert.equal(delivery.headers['content-type'], 'application/json');
        assert.equal(delivery.headers['user-agent'], 'OpenWA-Webhook/1.0.0');
        assert.equal(delivery.headers['x-openwa-retry-count'], '0');
        assert.match(
            delivery.headers['x-openwa-delivery-id'],
            /^dlv_[0-9a-f-]{36}$/,
        );
        assert.match(
            delivery.headers['x-openwa-idempotency-key'],
            new RegExp(
                `^sess_${session.id}_qr_ready_\\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z_${registered.id}$`,
            ),
        );
        assert.deepEqual(
            Object.keys(body),
            Object.keys(JSON.parse(recorded.rawBody)),
            'body keys and their order',
        );
        assert.deepEqual(body.data, {
            sessionId: session.id,
            status: 'qr_ready',
        });
        assert.equal(
            body.idempotencyKey,
            delivery.headers['x-openwa-idempotency-key'],
        );
        assert.equal(body.deliveryId, delivery.headers['x-openwa-delivery-id']);
        // Independent of the mock's own sign(): the rule of the reference, computed here.
        assert.equal(
            delivery.headers['x-openwa-signature'],
            `sha256=${createHmac('sha256', 'test-webhook-secret-0123456789abcdef').update(delivery.raw).digest('hex')}`,
        );

        // The QR event carries the PNG data URL, like the recorded session.qr.
        const qrDelivery = await waitFor(
            () =>
                hits.find(
                    (hit) => hit.headers['x-openwa-event'] === 'session.qr',
                ),
            'session.qr',
        );

        assert.deepEqual(Object.keys(JSON.parse(qrDelivery.raw).data).sort(), [
            'qr',
            'sessionId',
        ]);
        assert.match(
            JSON.parse(qrDelivery.raw).data.qr,
            /^data:image\/png;base64,/,
        );
        assert.match(qrDelivery.headers['x-openwa-idempotency-key'], /^qr_/);
    });

    test('an API stop sends session.status disconnected but NOT session.disconnected; a phone-side drop sends both', async () => {
        const session = await readySession('rec-stop-fffff');

        await hook(session, {
            events: ['session.status', 'session.disconnected'],
        });
        await api('POST', `/api/sessions/${session.id}/stop`);
        await waitFor(() => hits.length >= 1, 'the stop delivery');
        await sleep(60);
        assert.deepEqual(
            hits.map((hit) => hit.headers['x-openwa-event']),
            ['session.status'],
        );

        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'disconnected',
            reason: 'LOGOUT',
        });
        await waitFor(
            () =>
                hits.some(
                    (hit) =>
                        hit.headers['x-openwa-event'] ===
                        'session.disconnected',
                ),
            'session.disconnected',
        );
    });

    test('a webhook only receives the events it subscribed to; `*` receives all; default is message.received only', async () => {
        const session = await readySession('rec-subs-ggggg');

        await hook(session, {
            events: ['message.received'],
            path: '/only-received',
        });
        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'qr_ready',
        });
        await control('POST', `/__mock/sessions/${session.id}/inbound`, {
            from: '4915112345678',
            body: 'hi',
        });
        await waitFor(() => hits.length >= 1, 'the message');
        await sleep(50);
        assert.deepEqual(
            hits.map((hit) => hit.headers['x-openwa-event']),
            ['message.received'],
        );
    });

    test('a receiver that answers 500: retryCount attempts (0..n-1), doubling back-off, same delivery id and idempotency key, then the failure list', async () => {
        const session = await readySession('rec-fail-hhhhh');

        receiverStatus = () => 500;
        await hook(session, {
            events: ['session.status'],
            retryCount: 3,
            path: '/fail',
        });
        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'qr_ready',
        });

        const attempts = await waitFor(
            () =>
                hits.filter((hit) => hit.path === '/fail').length >= 3
                    ? hits.filter((hit) => hit.path === '/fail').slice(0, 3)
                    : null,
            '3 attempts',
            4000,
        );

        assert.deepEqual(
            attempts.map((hit) => hit.headers['x-openwa-retry-count']),
            ['0', '1', '2'],
        );
        assert.equal(
            new Set(attempts.map((hit) => hit.headers['x-openwa-delivery-id']))
                .size,
            1,
        );
        assert.equal(
            new Set(
                attempts.map((hit) => hit.headers['x-openwa-idempotency-key']),
            ).size,
            1,
        );
        assert.equal(
            new Set(attempts.map((hit) => hit.raw)).size,
            1,
            'the same bytes on every attempt',
        );
        assert.ok(
            attempts[1].at - attempts[0].at >= 35,
            'first back-off about retryBaseMs (40 ms)',
        );
        assert.ok(
            attempts[2].at - attempts[1].at >= 70,
            'second back-off doubles',
        );

        await sleep(60);
        assert.equal(
            hits.filter((hit) => hit.path === '/fail').length,
            3,
            'no fourth attempt',
        );

        const failures = ok(
            await api('GET', '/api/webhooks/delivery-failures'),
        );

        assert.deepEqual(
            shape(failures),
            shape(fixture('webhooks-delivery-failures').response.body),
        );
        assert.equal(failures[0].attempts, 3);
        assert.equal(failures[0].lastStatusCode, 500);
        assert.equal(failures[0].lastError, 'HTTP 500: Internal Server Error');
        assert.equal(
            fixture('webhook-delivery-retries').attempts.length,
            3,
            'the recording saw three attempts too',
        );
    });

    test('a 2xx stops the retries; a redirect is not followed and counts as a failure', async () => {
        const session = await readySession('rec-redir-iiiii');
        let calls = 0;

        receiverStatus = () => (++calls === 1 ? 503 : 200);
        await hook(session, {
            events: ['session.status'],
            retryCount: 3,
            path: '/flaky',
        });
        await control('POST', `/__mock/sessions/${session.id}/status`, {
            status: 'qr_ready',
        });
        await waitFor(
            () => hits.filter((hit) => hit.path === '/flaky').length >= 2,
            'the retry',
        );
        await sleep(150);
        assert.equal(
            hits.filter((hit) => hit.path === '/flaky').length,
            2,
            'delivered on the second attempt, then nothing more',
        );

        hits.length = 0;
        receiverStatus = () => 302;
        await hook(session, {
            events: ['session.qr'],
            retryCount: 1,
            path: '/redirect',
        });
        await control('POST', `/__mock/sessions/${session.id}/qr`);
        await waitFor(
            () => hits.some((hit) => hit.path === '/redirect'),
            'the redirecting receiver',
        );
        await sleep(100);
        assert.equal(
            hits.filter((hit) => hit.path === '/hook').length,
            0,
            'the redirect target is never requested',
        );
        assert.equal(hits.filter((hit) => hit.path === '/redirect').length, 1);
    });

    test('the webhook test route delivers a signed `test` event and reports the receiver status', async () => {
        const session = await createSession();
        const registered = await hook(session);

        assertShape(
            'webhooks-test',
            await api(
                'POST',
                `/api/sessions/${session.id}/webhooks/${registered.id}/test`,
            ),
        );

        const delivery = await waitFor(
            () => hits.find((hit) => hit.headers['x-openwa-event'] === 'test'),
            'the test delivery',
        );

        assert.match(
            delivery.headers['x-openwa-idempotency-key'],
            /^evt_test_[0-9a-f]{12}$/,
        );
        assert.deepEqual(
            Object.keys(JSON.parse(delivery.raw).data).sort(),
            Object.keys(
                JSON.parse(fixture('webhook-delivery-test').request.rawBody)
                    .data,
            ).sort(),
        );

        receiverStatus = () => 500;
        assert.deepEqual(
            (
                await api(
                    'POST',
                    `/api/sessions/${session.id}/webhooks/${registered.id}/test`,
                )
            ).body,
            { success: false, statusCode: 500 },
        );
    });

    test('deliveries to one webhook arrive in the order the events happened', async () => {
        const session = await createSession();

        await hook(session, { events: ['session.status'] });

        for (const status of [
            'initializing',
            'qr_ready',
            'authenticating',
            'ready',
            'disconnected',
        ]) {
            await control('POST', `/__mock/sessions/${session.id}/status`, {
                status,
            });
        }

        await waitFor(
            () =>
                hits.filter(
                    (hit) => hit.headers['x-openwa-event'] === 'session.status',
                ).length >= 5,
            'five status deliveries',
        );
        assert.deepEqual(
            hits
                .filter(
                    (hit) => hit.headers['x-openwa-event'] === 'session.status',
                )
                .map((hit) => JSON.parse(hit.raw).data.status),
            [
                'initializing',
                'qr_ready',
                'authenticating',
                'ready',
                'disconnected',
            ],
        );
    });

    test('control: bad signatures, a missing one, a tampered body, and replays (same idempotency key, new delivery id)', async () => {
        const session = await readySession('rec-forge-jjjjj');

        await hook(session);

        const sendBad = async (signature) => {
            hits.length = 0;
            ok(
                await control('POST', '/__mock/deliver', {
                    session: session.id,
                    event: 'message.received',
                    data: { id: 'x' },
                    signature,
                }),
            );

            return hits[0];
        };

        assert.equal(
            (await sendBad('bad')).headers['x-openwa-signature'],
            `sha256=${'0'.repeat(64)}`,
        );
        assert.equal(
            (await sendBad('missing')).headers['x-openwa-signature'],
            undefined,
        );

        const wrong = await sendBad('wrong-secret');

        assert.notEqual(
            wrong.headers['x-openwa-signature'],
            sign('test-webhook-secret-0123456789abcdef', wrong.raw),
        );

        const tampered = await sendBad('tampered');

        assert.notEqual(
            tampered.headers['x-openwa-signature'],
            sign('test-webhook-secret-0123456789abcdef', tampered.raw),
        );

        const valid = await sendBad('valid');

        assert.equal(
            valid.headers['x-openwa-signature'],
            sign('test-webhook-secret-0123456789abcdef', valid.raw),
        );

        // Replay: a new delivery of the same occurrence.
        const log = ok(
            await control('GET', '/__mock/deliveries?event=message.received'),
        );
        const first = log.at(-1);

        hits.length = 0;
        ok(await control('POST', '/__mock/replay', { delivery: first.n }));
        assert.equal(
            hits[0].headers['x-openwa-idempotency-key'],
            first.idempotencyKey,
        );
        assert.notEqual(
            hits[0].headers['x-openwa-delivery-id'],
            first.deliveryId,
        );
        assert.equal(
            hits[0].headers['x-openwa-signature'],
            sign('test-webhook-secret-0123456789abcdef', hits[0].raw),
            'a replay is signed over its own bytes',
        );

        hits.length = 0;
        ok(
            await control('POST', '/__mock/replay', {
                delivery: first.n,
                sameBody: true,
            }),
        );
        assert.equal(
            hits[0].raw,
            first.rawBody,
            'sameBody sends the very same bytes',
        );
        assert.equal(hits[0].headers['x-openwa-delivery-id'], first.deliveryId);
        assert.equal(hits[0].headers['x-openwa-retry-count'], '1');
    });
});

describe('messages', () => {
    test('send-text refusals equal the recordings: not started (400), engine not ready (409), validation (400)', async () => {
        const session = await createSession('rec-send-kkkkk');
        const send = (body = { chatId: '4915112345678@c.us', text: 'hello' }) =>
            api('POST', `/api/sessions/${session.id}/messages/send-text`, {
                body,
            });

        assertSame('messages-send-text-session-not-started', await send());
        assertSame(
            'messages-send-text-empty-text',
            await send({ chatId: '4915112345678@c.us', text: '' }),
        );
        assertSame(
            'messages-send-text-too-long',
            await send({
                chatId: '4915112345678@c.us',
                text: 'x'.repeat(4097),
            }),
        );
        assertSame(
            'messages-send-text-unknown-property',
            await send({
                chatId: '4915112345678@c.us',
                text: 'hi',
                surprise: true,
            }),
        );

        await api('POST', `/api/sessions/${session.id}/start`);
        assertSame('messages-send-text-session-not-ready', await send());
        assertSame(
            'messages-media-not-found',
            await api(
                'GET',
                `/api/sessions/${session.id}/messages/4915112345678@c.us/3EB0DOESNOTEXIST/media`,
            ),
        );
    });

    test('a send is accepted (201 {messageId, timestamp}), echoed as message.sent and acked sent -> delivered in order', async () => {
        const session = await readySession('rec-ack-lllll');

        await hook(session, {
            events: ['message.sent', 'message.ack', 'message.failed'],
        });
        await control('POST', '/__mock/config', { acks: { delayMs: 10 } });

        const sent = await api(
            'POST',
            `/api/sessions/${session.id}/messages/send-text`,
            { body: { chatId: '4915112345678@c.us', text: 'Hi Vera' } },
        );
        const documented = fixture('messages-send-text-ok').response.body;

        assert.equal(sent.status, 201);
        assert.deepEqual(shape(sent.body), shape(documented));
        assert.match(
            sent.body.messageId,
            /^true_4915112345678@c\.us_[0-9A-F]{16}$/,
        );
        assert.ok(
            Math.abs(sent.body.timestamp - Date.now() / 1000) < 5,
            'epoch seconds',
        );

        await waitFor(() => hits.length >= 3, 'echo + two acks');
        assert.deepEqual(
            hits.map((hit) => hit.headers['x-openwa-event']),
            ['message.sent', 'message.ack', 'message.ack'],
        );

        const acks = hits.slice(1).map((hit) => JSON.parse(hit.raw).data);

        assert.deepEqual(
            acks.map((ack) => [ack.status, ack.ack]),
            [
                ['sent', 1],
                ['delivered', 2],
            ],
        );
        assert.deepEqual(
            Object.keys(acks[0]).sort(),
            Object.keys(
                fixture('delivery-message-ack-sent').delivery.payload.data,
            ).sort(),
        );
        assert.equal(acks[0].messageId, sent.body.messageId);
        assert.match(
            hits[1].headers['x-openwa-idempotency-key'],
            new RegExp(`^ack_${session.id}_.+_sent_`),
        );
        assert.equal(JSON.parse(hits[0].raw).data.fromMe, true);
    });

    test('control acks: read, a late sent, and failed (message.ack AND message.failed); manual mode sends none by itself', async () => {
        const session = await readySession('rec-manual-mmmmm');

        await hook(session, { events: ['message.ack', 'message.failed'] });
        await control('POST', '/__mock/config', {
            acks: { mode: 'manual' },
            sentEcho: false,
        });

        const sent = await api(
            'POST',
            `/api/sessions/${session.id}/messages/send-text`,
            { body: { chatId: '4915112345678@c.us', text: 'Hi' } },
        );

        await sleep(80);
        assert.equal(hits.length, 0);

        for (const status of ['read', 'sent', 'failed']) {
            ok(
                await control('POST', `/__mock/sessions/${session.id}/ack`, {
                    messageId: sent.body.messageId,
                    status,
                }),
            );
        }

        await waitFor(() => hits.length >= 4, 'three acks and the failure');
        assert.deepEqual(
            hits.map(
                (hit) =>
                    `${hit.headers['x-openwa-event']}:${JSON.parse(hit.raw).data.status}`,
            ),
            [
                'message.ack:read',
                'message.ack:sent',
                'message.ack:failed',
                'message.failed:failed',
            ],
        );
        assert.deepEqual(JSON.parse(hits[3].raw).data, {
            id: sent.body.messageId,
            messageId: sent.body.messageId,
            status: 'failed',
            ack: -1,
        });
    });

    test('a session can carry its own ack plan (manual here) while the others keep the default', async () => {
        const manual = await readySession('rec-plan-aaaaa');
        const auto = await readySession('rec-plan-bbbbb');

        await hook(manual, { events: ['message.ack'] });
        await hook(auto, { events: ['message.ack'] });
        ok(
            await control('POST', `/__mock/sessions/${manual.id}/acks`, {
                mode: 'manual',
            }),
        );

        for (const session of [manual, auto]) {
            await api(
                'POST',
                `/api/sessions/${session.id}/messages/send-text`,
                {
                    body: { chatId: '4915112345678@c.us', text: 'Hi' },
                },
            );
        }

        // The default plan acks `sent` then `delivered` by itself; the manual session stays silent.
        await waitFor(() => hits.length >= 2, 'the default plan acks');
        await sleep(120);
        assert.equal(hits.length, 2);
        assert.ok(
            hits.every((hit) => JSON.parse(hit.raw).sessionId === auto.id),
            'only the session on the default plan was acked',
        );
    });

    test('SEND_PACING_LIMITED (daily cap) and the throttler 429 are different: the first has a code and retryAfterSeconds, the second clears in a second', async () => {
        const session = await readySession('rec-pace-nnnnn');
        const send = () =>
            api('POST', `/api/sessions/${session.id}/messages/send-text`, {
                body: { chatId: '4915112345678@c.us', text: 'Hi' },
            });

        await control('POST', '/__mock/config', { pacing: { dailyCap: 1 } });
        assert.equal((await send()).status, 201);

        const limited = await send();

        assert.equal(limited.status, 429);
        assert.equal(limited.body.code, 'SEND_PACING_LIMITED');
        assert.equal(typeof limited.body.retryAfterSeconds, 'number');
        assert.deepEqual(
            Object.keys(limited.body).sort(),
            Object.keys(
                fixture('error-send-pacing-limited').response.body,
            ).sort(),
        );

        await control('POST', '/__mock/throttle', { next: 1 });

        const throttled = await api('GET', '/api/sessions');

        assertSame('ratelimit-throttled', throttled);
        assert.equal(throttled.headers.get('retry-after'), '1');
        assert.equal(throttled.body.code, undefined);
        assert.equal(
            (await api('GET', '/api/sessions')).status,
            200,
            'only the next call was throttled',
        );
    });

    test('a scripted response answers the next matching call once (and a request log records what was called)', async () => {
        await control('POST', '/__mock/script', {
            method: 'POST',
            path: '/api/sessions',
            status: 504,
            body: fixture('error-session-start-timeout').response.body,
        });

        const first = await api('POST', '/api/sessions', {
            body: { name: 'rec-script-ooooo' },
        });

        assert.equal(first.status, 504);
        assert.equal(first.body.error, 'Gateway Timeout');
        assert.equal(
            (
                await api('POST', '/api/sessions', {
                    body: { name: 'rec-script-ooooo' },
                })
            ).status,
            201,
        );

        const log = ok(
            await control(
                'GET',
                '/__mock/requests?method=POST&path=/api/sessions',
            ),
        );

        assert.deepEqual(
            log.map((entry) => entry.status),
            [504, 201],
        );
        assert.equal(log[0].apiKey, DEFAULT_API_KEY);
        assert.deepEqual(log[0].body, { name: 'rec-script-ooooo' });
        assert.deepEqual(
            ok(await control('GET', `/__mock/requests?since=${log[0].n}`)).map(
                (entry) => entry.n,
            ),
            [log[1].n],
        );
        ok(await control('DELETE', '/__mock/requests'));
        assert.deepEqual(ok(await control('GET', '/__mock/requests')), []);
    });
});

describe('injected inbound messages', () => {
    const inbound = async (session, body) =>
        ok(
            await control(
                'POST',
                `/__mock/sessions/${session.id}/inbound`,
                body,
            ),
            201,
        ).message;
    const documented = (name) => fixture(name).delivery.payload.data;

    test("text, Baileys dialect is the caller's choice, group, @lid, the phone's own send, a story: the documented keys", async () => {
        const session = await readySession('rec-in-pppp1');
        const text = await inbound(session, {
            from: '4915112345678',
            body: 'Hi! My support code is K7M2QX4P',
            pushName: 'Vera Visitor',
        });

        assert.deepEqual(
            Object.keys(text).sort(),
            Object.keys(documented('delivery-message-received-text')).sort(),
        );
        assert.equal(text.chatId, '4915112345678@c.us');
        assert.equal(text.to, '4915100000000@c.us');
        assert.deepEqual(
            [text.fromMe, text.isGroup, text.kind, text.type],
            [false, false, 'individual', 'text'],
        );
        assert.match(text.id, /^false_4915112345678@c\.us_[0-9A-F]{16}$/);
        assert.equal(Number.isInteger(text.timestamp), true, 'epoch seconds');

        const group = await inbound(session, {
            chatId: '120363000000000001@g.us',
            kind: 'group',
            author: '4915198765432@c.us',
            body: 'hello all',
        });

        assert.deepEqual(
            Object.keys(group).sort(),
            Object.keys(documented('delivery-message-received-group')).sort(),
        );
        assert.deepEqual(
            [group.isGroup, group.kind, group.author, group.from],
            [true, 'group', '4915198765432@c.us', '120363000000000001@g.us'],
        );

        const lid = await inbound(session, { lid: true, body: 'privacy id' });

        assert.deepEqual(
            Object.keys(lid).sort(),
            Object.keys(documented('delivery-message-received-lid')).sort(),
        );
        assert.equal(lid.isLidSender, true);
        assert.match(lid.chatId, /@lid$/);
        assert.equal(lid.senderPhone, '4915112345678');

        await control('POST', '/__mock/config', { resolveLid: false });
        assert.equal(
            'senderPhone' in
                (await inbound(session, { lid: true, body: 'privacy id' })),
            false,
            'senderPhone only with RESOLVE_LID_TO_PHONE',
        );

        const mine = await inbound(session, {
            from: '4915112345678',
            body: 'from the phone',
            fromMe: true,
        });

        assert.deepEqual(
            Object.keys(mine).sort(),
            Object.keys(documented('delivery-message-received-from-me')).sort(),
        );
        assert.deepEqual(
            [mine.fromMe, mine.from, mine.to],
            [true, '4915100000000@c.us', '4915112345678@c.us'],
        );
        assert.match(mine.id, /^true_/);

        const story = await inbound(session, {
            chatId: 'status@broadcast',
            kind: 'status',
            author: '4915112345678@c.us',
            body: 'my story',
        });

        assert.equal(story.kind, 'status');
        assert.deepEqual(
            Object.keys(story).sort(),
            Object.keys(documented('delivery-message-received-status')).sort(),
        );
    });

    test('an image small enough is inlined as base64 and downloadable; a big one is the omitted marker; stored:false is a 404', async () => {
        const session = await readySession('rec-img-qqqq1');
        const small = await inbound(session, {
            from: '4915112345678',
            body: 'receipt',
            type: 'image',
            media: { mimetype: 'image/png', filename: 'receipt.png' },
        });

        assert.deepEqual(
            Object.keys(small).sort(),
            Object.keys(
                documented('delivery-message-received-image-inline'),
            ).sort(),
        );
        assert.deepEqual(Object.keys(small.media).sort(), [
            'data',
            'filename',
            'mimetype',
        ]);
        assert.deepEqual(
            [...Buffer.from(small.media.data, 'base64').subarray(0, 4)],
            [0x89, 0x50, 0x4e, 0x47],
        );

        const download = await api(
            'GET',
            `/api/sessions/${session.id}/messages/${encodeURIComponent(small.chatId)}/${small.id}/media`,
        );

        assert.equal(download.status, 200);
        assert.equal(download.headers.get('content-type'), 'image/png');
        assert.equal(download.headers.get('content-disposition'), 'attachment');
        assert.equal(download.headers.get('x-content-type-options'), 'nosniff');

        const big = await inbound(session, {
            from: '4915112345678',
            body: '',
            type: 'image',
            media: {
                mimetype: 'image/jpeg',
                filename: 'IMG_0042.jpg',
                sizeBytes: 2_457_600,
                stored: true,
            },
        });

        assert.deepEqual(big.media, {
            mimetype: 'image/jpeg',
            filename: 'IMG_0042.jpg',
            omitted: true,
            sizeBytes: 2_457_600,
        });
        assert.deepEqual(
            Object.keys(big).sort(),
            Object.keys(
                documented('delivery-message-received-image-omitted'),
            ).sort(),
        );
        assert.deepEqual(
            Object.keys(big.media).sort(),
            Object.keys(
                documented('delivery-message-received-image-omitted').media,
            ).sort(),
        );
        assertSame(
            'messages-media-not-found',
            await api(
                'GET',
                `/api/sessions/${session.id}/messages/${encodeURIComponent(big.chatId)}/${big.id}/media`,
            ),
        );

        // A real decoded image above the cap arrives omitted too (the cap is configurable).
        await control('POST', '/__mock/config', { mediaInlineMaxBytes: 100 });

        const capped = await inbound(session, {
            from: '4915112345678',
            type: 'image',
            media: { mimetype: 'image/png', size: 64 },
        });

        assert.equal(capped.media.omitted, true);
        assert.equal(capped.media.data, undefined);
        assert.equal(
            (
                await api(
                    'GET',
                    `/api/sessions/${session.id}/messages/${encodeURIComponent(capped.chatId)}/${capped.id}/media`,
                )
            ).status,
            200,
            'stored bytes stay downloadable',
        );
    });

    test('an injected message reaches the registered webhook as a signed message.received whose idempotency key is msg_<session>_<id>_<webhook>', async () => {
        const session = await readySession('rec-in-rrrr1');
        const registered = await hook(session, {
            events: ['message.received'],
        });
        const message = await inbound(session, {
            from: '4915112345678',
            body: 'hello',
        });
        const delivery = await waitFor(() => hits[0], 'message.received');

        assert.equal(
            delivery.headers['x-openwa-idempotency-key'],
            `msg_${session.id}_${message.id}_${registered.id}`,
        );
        assert.equal(
            delivery.headers['x-openwa-signature'],
            sign('test-webhook-secret-0123456789abcdef', delivery.raw),
        );
        assert.deepEqual(JSON.parse(delivery.raw).data, message);
    });
});

describe('control API', () => {
    test('the delivery log can be asked for one message by a part of its idempotency key', async () => {
        const session = await readySession('rec-key-kkkkk1');

        await hook(session, { events: ['message.received'] });

        const send = async (body) =>
            ok(
                await control(
                    'POST',
                    `/__mock/sessions/${session.id}/inbound`,
                    {
                        from: '4915112345678',
                        body,
                    },
                ),
                201,
            ).message;
        const first = await send('one');
        const second = await send('two');

        await waitFor(() => hits.length >= 2, 'two deliveries');

        const found = ok(
            await control(
                'GET',
                `/__mock/deliveries?event=message.received&key=${encodeURIComponent(first.id)}`,
            ),
        );

        assert.equal(found.length, 1);
        assert.ok(found[0].idempotencyKey.includes(first.id));
        assert.ok(!found[0].idempotencyKey.includes(second.id));
        assert.equal(found[0].status, 200);
    });

    test('createSession in any state without events, state, reset', async () => {
        const created = ok(
            await control('POST', '/__mock/sessions', {
                name: 'support-main',
                status: 'ready',
                phone: '4915100000000',
                pushName: 'PNE Support',
            }),
            201,
        );

        assert.deepEqual(
            [created.status, created.phone, created.engineLoaded],
            ['ready', '4915100000000', true],
        );
        assert.equal(
            ok(await control('GET', '/__mock/state')).sessions.length,
            1,
        );
        assert.equal(
            ok(await api('GET', `/api/sessions/${created.id}`)).status,
            'ready',
        );
        ok(await control('POST', '/__mock/reset'));
        assert.equal(
            ok(await control('GET', '/__mock/state')).sessions.length,
            0,
        );
        assert.equal(
            (await api('GET', `/api/sessions/${created.id}`)).status,
            404,
        );
    });

    test('the CLI starts, answers on its port, and exits on SIGTERM without leaving the port busy', async () => {
        const child = spawn(
            process.execPath,
            [
                new URL('./openwa-mock.mjs', import.meta.url).pathname,
                `--port=${CLI_PORT}`,
                '--key=owa_k1_cli-test',
            ],
            { stdio: 'ignore' },
        );
        const exited = new Promise((done) =>
            child.once('exit', (code, signal) => done({ code, signal })),
        );
        let healthy = false;

        for (let attempt = 0; attempt < 50 && !healthy; attempt += 1) {
            try {
                healthy = (
                    await fetch(`http://127.0.0.1:${CLI_PORT}/__mock/health`)
                ).ok;
            } catch {
                await sleep(100);
            }
        }

        assert.equal(healthy, true, 'the CLI never became healthy');
        assert.equal(
            (
                await fetch(`http://127.0.0.1:${CLI_PORT}/api/auth/validate`, {
                    method: 'POST',
                    headers: { 'X-API-Key': 'owa_k1_cli-test' },
                })
            ).status,
            200,
        );
        child.kill('SIGTERM');

        const result = await Promise.race([
            exited,
            sleep(3000).then(() => 'timeout'),
        ]);

        assert.notEqual(result, 'timeout', 'the mock did not exit on SIGTERM');
        await assert.rejects(
            fetch(`http://127.0.0.1:${CLI_PORT}/__mock/health`),
            'the port is free again',
        );
    });
});
