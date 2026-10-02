#!/usr/bin/env node
/**
 * Records the REAL OpenWA API into `tests/fixtures/openwa/*.json` (P6, track 6C). Developer tool: nothing in the app or the
 * test suites runs it. Needs Node 20+ (global fetch), Docker (only to read the API key / the image digest) and no npm packages.
 *
 *   docker compose -f docker/compose.dev.yml --profile whatsapp up -d openwa
 *   node scripts/openwa-record.mjs                       # records everything against http://127.0.0.1:2785
 *   node scripts/openwa-record.mjs --only=sessions,webhooks
 *
 * Optional second instance (no SSRF allow-list, validation detail on), for the two rejections the first one cannot show:
 *   docker run -d --rm --name pne-chat-dev-openwa-probe -p 127.0.0.1:8370:2785 -e VALIDATION_ERROR_DETAIL=true ghcr.io/rmyndharis/openwa:latest
 *   node scripts/openwa-record.mjs --strict-base=http://127.0.0.1:8370 --strict-container=pne-chat-dev-openwa-probe --only=strict
 *
 * Re-generate only tests/fixtures/openwa/index.json (also lists the hand-written documented fixtures): `node scripts/openwa-record.mjs --index-only`.
 *
 * Options (all optional): --base, --container (default pne-chat-dev-openwa-1), --key-env (name of an env var holding the API key,
 * default OPENWA_API_KEY; otherwise `docker exec <container> cat /app/data/.api-key`), --out (default tests/fixtures/openwa),
 * --receiver-port (default 8368: a local webhook receiver on 127.0.0.1), --receiver-host (how the OpenWA CONTAINER reaches this
 * machine, default host.docker.internal: it must be in the container's SSRF_ALLOWED_HOSTS), --strict-base, --strict-container, --only.
 *
 * What it does: creates throw-away sessions / webhooks / API keys whose names start with `rec-`, calls the API (paced under OpenWA's
 * own rate limit: 10/s, 100/min), writes request + response (+ the signed webhook deliveries it receives) and deletes everything it
 * created. It prints file names and a summary, never a key. Every fixture is scrubbed: API keys become `owa_k1_REDACTED`, QR images
 * `data:image/png;base64,<REDACTED>` (a QR is a login credential while it is valid), and the script refuses to write a file that
 * still contains the key it used. The webhook secret it registers is a fixed TEST value, so the signed deliveries it stores stay
 * verifiable by the tests (HMAC-SHA256 over the raw body).
 */
import { execFileSync } from 'node:child_process';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
    process.argv
        .slice(2)
        .filter((arg) => arg.startsWith('--'))
        .map((arg) => {
            const [key, ...rest] = arg.slice(2).split('=');

            return [key, rest.length === 0 ? 'true' : rest.join('=')];
        }),
);

const BASE = String(args.base ?? 'http://127.0.0.1:2785').replace(/\/$/, '');
const CONTAINER = String(args.container ?? 'pne-chat-dev-openwa-1');
const OUT = resolve(ROOT, String(args.out ?? 'tests/fixtures/openwa'));
const RECEIVER_PORT = Number(args['receiver-port'] ?? 8368);
const RECEIVER_HOST = String(args['receiver-host'] ?? 'host.docker.internal');
const STRICT_BASE = args['strict-base']
    ? String(args['strict-base']).replace(/\/$/, '')
    : null;
const STRICT_CONTAINER = String(
    args['strict-container'] ?? 'pne-chat-dev-openwa-probe',
);
const ONLY = args.only ? String(args.only).split(',') : null;
/** A TEST secret (>= 16 characters): it only ever signs deliveries to the local receiver, and the fixtures keep it so tests can re-verify them. */
const TEST_SECRET = 'test-webhook-secret-0123456789abcdef';
const KEY_PATTERN = /owa_k1_[A-Za-z0-9_-]+/g;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readKey(container, env) {
    const fromEnv = process.env[env];

    if (fromEnv) {
        return fromEnv.trim();
    }

    try {
        return execFileSync(
            'docker',
            ['exec', container, 'cat', '/app/data/.api-key'],
            {
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
            },
        ).trim();
    } catch {
        throw new Error(
            `No API key: set ${env} or run the container "${container}" (docker exec ${container} cat /app/data/.api-key).`,
        );
    }
}

const INDEX_ONLY = args['index-only'] === 'true';
const ADMIN_KEY = INDEX_ONLY
    ? ''
    : readKey(CONTAINER, String(args['key-env'] ?? 'OPENWA_API_KEY'));
const secrets = new Set(ADMIN_KEY === '' ? [] : [ADMIN_KEY]);

// ---------------------------------------------------------------------------------------------------------------------------
// HTTP with pacing (OpenWA answers 429 above 10 requests a second / 100 a minute per client address)

const stamps = [];

async function pace() {
    for (;;) {
        const now = Date.now();

        while (stamps.length > 0 && now - stamps[0] > 60_000) {
            stamps.shift();
        }

        const lastSecond = stamps.filter((at) => now - at < 1000).length;

        if (stamps.length < 80 && lastSecond < 5) {
            stamps.push(now);

            return;
        }

        await sleep(lastSecond >= 5 ? 250 : 1000);
    }
}

/** One call. `key`: undefined = the admin key, null = none, a string = that key. Redirects are never followed. */
async function call({
    method = 'GET',
    path,
    body,
    rawBody,
    contentType,
    key,
    base = BASE,
    timeoutMs = 90_000,
    unpaced = false,
}) {
    if (!unpaced) {
        await pace();
    }

    const apiKey = key === undefined ? ADMIN_KEY : key;
    const headers = {};

    if (apiKey !== null) {
        headers['X-API-Key'] = apiKey;
    }

    const payload =
        rawBody ?? (body === undefined ? undefined : JSON.stringify(body));

    if (payload !== undefined) {
        headers['Content-Type'] = contentType ?? 'application/json';
    }

    const startedAt = Date.now();
    const response = await fetch(base + path, {
        method,
        headers,
        ...(payload === undefined ? {} : { body: payload }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = text;

    try {
        parsed = text === '' ? null : JSON.parse(text);
    } catch {
        // not JSON (media bytes, plain text): keep the text
    }

    return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: parsed,
        text,
        ms: Date.now() - startedAt,
        request: { method, path, body, rawBody, contentType, key: apiKey },
    };
}

// ---------------------------------------------------------------------------------------------------------------------------
// Fixtures

const recordedAt = new Date().toISOString();
let meta = {
    version: 'unknown',
    image: null,
    engine: 'whatsapp-web.js',
    env: {},
};

const KEPT_RESPONSE_HEADERS = [
    'content-type',
    'content-disposition',
    'retry-after',
    'retry-after-short',
    'x-ratelimit-limit-short',
    'x-ratelimit-limit-medium',
    'x-ratelimit-limit-long',
    'x-content-type-options',
    'location',
];

/** Walks a value and scrubs it: API keys, QR images. Returns the scrubbed copy; `redactions` collects what was replaced. */
function scrub(value, redactions, path = '') {
    if (typeof value === 'string') {
        let text = value;

        for (const secret of secrets) {
            text = text.split(secret).join('owa_k1_REDACTED');
        }

        text = text.replace(KEY_PATTERN, 'owa_k1_REDACTED');

        const qr = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(text);

        if (qr) {
            const png = Buffer.from(qr[1], 'base64');

            redactions.push({
                path,
                kind: 'qr-png-data-url',
                note: `PNG ${png.readUInt32BE(16)}x${png.readUInt32BE(20)}, ${png.length} bytes (${text.length} characters as a data URL)`,
            });

            return 'data:image/png;base64,<REDACTED>';
        }

        return text;
    }

    if (Array.isArray(value)) {
        return value.map((item, index) =>
            scrub(item, redactions, `${path}[${index}]`),
        );
    }

    if (value !== null && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [
                key,
                scrub(item, redactions, path === '' ? key : `${path}.${key}`),
            ]),
        );
    }

    return value;
}

function placeholders(path, ids) {
    let result = path;

    for (const [name, id] of Object.entries(ids)) {
        if (id) {
            result = result.split(id).join(`{${name}}`);
        }
    }

    return result;
}

function assertClean(name, serialized) {
    for (const secret of secrets) {
        if (secret && serialized.includes(secret)) {
            throw new Error(
                `Refusing to write ${name}: it still contains an API key.`,
            );
        }
    }

    if (/owa_k1_(?!REDACTED)/.test(serialized)) {
        throw new Error(
            `Refusing to write ${name}: it still contains something that looks like an API key.`,
        );
    }
}

function save(name, payload) {
    const serialized = `${JSON.stringify(payload, null, 4)}\n`;

    assertClean(name, serialized);
    mkdirSync(OUT, { recursive: true });
    writeFileSync(join(OUT, `${name}.json`), serialized);
    console.log(
        `  recorded ${name}.json (${payload.response?.status ?? payload.request?.method ?? ''})`,
    );
}

/** Records one REST exchange. `ids` turns real ids in the path into `{sessionId}` / `{webhookId}` placeholders. */
function rec(
    name,
    description,
    result,
    { ids = {}, notes = [], keyLabel } = {},
) {
    const redactions = [];
    const apiKey = result.request.key;
    const label =
        keyLabel ??
        (apiKey === null
            ? '(none)'
            : apiKey === ADMIN_KEY
              ? 'REDACTED (admin)'
              : apiKey.startsWith('owa_k1_')
                ? 'REDACTED'
                : apiKey);
    const headers = Object.fromEntries(
        KEPT_RESPONSE_HEADERS.filter(
            (key) => result.headers[key] !== undefined,
        ).map((key) => [key, result.headers[key]]),
    );
    const body =
        result.body !== null && typeof result.body === 'object'
            ? scrub(result.body, redactions, 'response.body')
            : typeof result.body === 'string'
              ? scrub(result.body, redactions)
              : result.body;

    save(name, {
        source: 'recorded',
        recordedAt,
        openwa: {
            version: meta.version,
            image: meta.image,
            engine: meta.engine,
        },
        description,
        request: {
            method: result.request.method,
            path: placeholders(result.request.path, ids),
            headers: {
                ...(result.request.key === undefined
                    ? {}
                    : { 'X-API-Key': label }),
                ...(result.request.body !== undefined ||
                result.request.rawBody !== undefined
                    ? {
                          'Content-Type':
                              result.request.contentType ?? 'application/json',
                      }
                    : {}),
            },
            ...(result.request.rawBody === undefined
                ? {
                      body:
                          result.request.body === undefined
                              ? null
                              : scrub(result.request.body, [], 'request.body'),
                  }
                : { rawBody: result.request.rawBody }),
        },
        response: {
            status: result.status,
            headers,
            body,
            durationMs: result.ms,
        },
        ...(redactions.length > 0 ? { redactions } : {}),
        ...(notes.length > 0 ? { notes } : {}),
    });
}

function expectStatus(result, status, what) {
    if (result.status !== status) {
        throw new Error(
            `${what}: expected HTTP ${status}, got ${result.status} ${result.text.slice(0, 200)}`,
        );
    }

    return result;
}

// ---------------------------------------------------------------------------------------------------------------------------
// The webhook receiver (a plain local server: the OpenWA container reaches it through RECEIVER_HOST)

class Receiver {
    deliveries = [];

    /** When set, `wait()` only looks at deliveries of this OpenWA session (late retries of an earlier run must not be mistaken for ours). */
    only = null;

    start() {
        return new Promise((done, fail) => {
            this.server = createServer((request, response) => {
                const chunks = [];

                request.on('data', (chunk) => chunks.push(chunk));
                request.on('end', () => {
                    this.deliveries.push({
                        at: Date.now(),
                        path: request.url,
                        headers: request.headers,
                        raw: Buffer.concat(chunks).toString('utf8'),
                    });

                    if (request.url.startsWith('/fail')) {
                        response.writeHead(500, {
                            'content-type': 'text/plain',
                        });
                        response.end('receiver says no');
                    } else if (request.url.startsWith('/redirect')) {
                        response.writeHead(302, { location: '/hook' });
                        response.end();
                    } else if (request.url.startsWith('/slow')) {
                        setTimeout(() => {
                            try {
                                response.writeHead(200);
                                response.end('too late');
                            } catch {
                                // the sender gave up already
                            }
                        }, 12_000);
                    } else {
                        response.writeHead(200, {
                            'content-type': 'application/json',
                        });
                        response.end('{"ok":true}');
                    }
                });
            });
            this.server.once('error', fail);
            this.server.listen(RECEIVER_PORT, '127.0.0.1', done);
        });
    }

    stop() {
        return new Promise((done) => this.server.close(() => done()));
    }

    /** The first delivery (not yet claimed) for which `predicate` holds, waiting up to `timeoutMs`. */
    async wait(predicate, timeoutMs = 60_000) {
        const until = Date.now() + timeoutMs;

        while (Date.now() < until) {
            const found = this.deliveries.find(
                (delivery) =>
                    !delivery.claimed &&
                    (this.only === null || sessionOf(delivery) === this.only) &&
                    predicate(delivery),
            );

            if (found) {
                found.claimed = true;

                return found;
            }

            await sleep(100);
        }

        throw new Error('A webhook delivery did not arrive in time.');
    }

    event(name, path = '/hook') {
        return (delivery) =>
            delivery.path === path &&
            delivery.headers['x-openwa-event'] === name;
    }
}

function sessionOf(delivery) {
    try {
        return JSON.parse(delivery.raw).sessionId;
    } catch {
        return null;
    }
}

function signatureOk(raw, header, secret) {
    const expected = `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

    return (
        typeof header === 'string' &&
        header.length === expected.length &&
        timingSafeEqual(Buffer.from(header), Buffer.from(expected))
    );
}

const KEPT_DELIVERY_HEADERS = [
    'content-type',
    'user-agent',
    'x-openwa-event',
    'x-openwa-idempotency-key',
    'x-openwa-delivery-id',
    'x-openwa-retry-count',
    'x-openwa-signature',
];

function recDelivery(
    name,
    description,
    delivery,
    { notes = [], secret = TEST_SECRET } = {},
) {
    const redactions = [];
    const verified = signatureOk(
        delivery.raw,
        delivery.headers['x-openwa-signature'],
        secret,
    );
    const parsed = JSON.parse(delivery.raw);
    const rawBody = JSON.stringify(scrub(parsed, redactions, 'rawBody'));
    const redacted = redactions.length > 0;

    save(name, {
        source: 'recorded',
        recordedAt,
        openwa: {
            version: meta.version,
            image: meta.image,
            engine: meta.engine,
        },
        description,
        request: {
            method: 'POST',
            url: `http://${RECEIVER_HOST}:${RECEIVER_PORT}${delivery.path}`,
            headers: Object.fromEntries(
                KEPT_DELIVERY_HEADERS.filter(
                    (key) => delivery.headers[key] !== undefined,
                ).map((key) => [key, delivery.headers[key]]),
            ),
            rawBody: redacted ? rawBody : delivery.raw,
        },
        verification: {
            rule: 'X-OpenWA-Signature = "sha256=" + hex(HMAC-SHA256(secret, rawBody)); rawBody is the exact request body',
            secret: TEST_SECRET,
            signatureMatchedWhenReceived: verified,
            reverifiableFromThisFile: !redacted,
        },
        ...(redacted ? { redactions } : {}),
        ...(notes.length > 0 ? { notes } : {}),
    });

    if (!verified) {
        throw new Error(
            `The signature of ${name} did not verify: the HMAC rule differs from the reference.`,
        );
    }
}

// ---------------------------------------------------------------------------------------------------------------------------
// Flows

/** @type {{ sessions: string[]; keys: string[] }} */
const created = { sessions: [], keys: [] };
const stamp = Math.random().toString(36).slice(2, 7);
const names = {
    lifecycle: `rec-life-${stamp}`,
    plain: `rec-plain-${stamp}`,
    limit: `rec-limit-${stamp}`,
};
const ownSession = async (name) => {
    const result = expectStatus(
        await call({ method: 'POST', path: '/api/sessions', body: { name } }),
        201,
        `create ${name}`,
    );

    created.sessions.push(result.body.id);

    return result;
};
const hook = (path = '/hook') =>
    `http://${RECEIVER_HOST}:${RECEIVER_PORT}${path}`;

async function flowSystem() {
    console.log('system');
    const health = await call({ path: '/api/health', key: null });

    rec(
        'system-health',
        'GET /api/health without a key: public, no version.',
        health,
        { keyLabel: '(none)' },
    );
    rec(
        'system-health-authenticated',
        'GET /api/health with a key: adds the running version.',
        await call({ path: '/api/health' }),
    );
    rec(
        'system-health-ready',
        'GET /api/health/ready: the readiness probe the image HEALTHCHECK uses.',
        await call({ path: '/api/health/ready', key: null }),
    );
    rec(
        'system-engine-current',
        'GET /api/infra/engines/current (admin).',
        await call({ path: '/api/infra/engines/current' }),
    );
}

async function flowAuth() {
    console.log('auth');
    rec(
        'auth-validate-ok',
        'POST /api/auth/validate with the admin key: role and engine.',
        await call({ method: 'POST', path: '/api/auth/validate' }),
    );
    rec(
        'auth-validate-missing-key',
        'POST /api/auth/validate without a key.',
        await call({ method: 'POST', path: '/api/auth/validate', key: null }),
    );
    rec(
        'auth-validate-invalid-key',
        'POST /api/auth/validate with an unknown key.',
        await call({
            method: 'POST',
            path: '/api/auth/validate',
            key: 'owa_k1_this-key-does-not-exist',
        }),
    );

    const bearer = await fetch(`${BASE}/api/auth/validate`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ADMIN_KEY}` },
    });

    console.log(
        `  (Authorization: Bearer is accepted: HTTP ${bearer.status}; not recorded as a file)`,
    );

    const viewer = expectStatus(
        await call({
            method: 'POST',
            path: '/api/auth/api-keys',
            body: { name: `rec-viewer-${stamp}`, role: 'viewer' },
        }),
        201,
        'create viewer key',
    );
    const operator = expectStatus(
        await call({
            method: 'POST',
            path: '/api/auth/api-keys',
            body: { name: `rec-operator-${stamp}`, role: 'operator' },
        }),
        201,
        'create operator key',
    );

    created.keys.push(viewer.body.id, operator.body.id);
    secrets.add(viewer.body.apiKey);
    secrets.add(operator.body.apiKey);

    rec(
        'auth-create-key-response',
        'POST /api/auth/api-keys (admin): the plaintext key is returned once, in `apiKey`.',
        viewer,
        { notes: ['The plaintext key is scrubbed (owa_k1_REDACTED).'] },
    );
    rec(
        'auth-validate-viewer',
        'POST /api/auth/validate with a viewer key.',
        await call({
            method: 'POST',
            path: '/api/auth/validate',
            key: viewer.body.apiKey,
        }),
        { keyLabel: 'REDACTED (viewer)' },
    );
    rec(
        'auth-viewer-create-session-forbidden',
        'A viewer key creating a session: 403 naming the missing role.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: `rec-viewer-try-${stamp}` },
            key: viewer.body.apiKey,
        }),
        { keyLabel: 'REDACTED (viewer)' },
    );

    const operatorSession = expectStatus(
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: `rec-operator-${stamp}` },
            key: operator.body.apiKey,
        }),
        201,
        'operator creates a session',
    );

    created.sessions.push(operatorSession.body.id);
    rec(
        'auth-operator-create-session-ok',
        'An (unscoped) operator key may create a session.',
        operatorSession,
        {
            keyLabel: 'REDACTED (operator)',
            notes: [
                'An unscoped operator key is enough; the admin role is not needed to create or start sessions.',
            ],
        },
    );

    const scoped = expectStatus(
        await call({
            method: 'POST',
            path: '/api/auth/api-keys',
            body: {
                name: `rec-scoped-${stamp}`,
                role: 'operator',
                allowedSessions: [operatorSession.body.id],
            },
        }),
        201,
        'create scoped key',
    );

    created.keys.push(scoped.body.id);
    secrets.add(scoped.body.apiKey);

    rec(
        'auth-scoped-create-session-forbidden',
        'A key scoped to some sessions cannot create sessions: 403.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: `rec-scoped-try-${stamp}` },
            key: scoped.body.apiKey,
        }),
        { keyLabel: 'REDACTED (operator, allowedSessions)' },
    );
    rec(
        'auth-scoped-own-session-ok',
        'A scoped key reading the session it is scoped to.',
        await call({
            path: `/api/sessions/${operatorSession.body.id}`,
            key: scoped.body.apiKey,
        }),
        {
            ids: { sessionId: operatorSession.body.id },
            keyLabel: 'REDACTED (operator, allowedSessions)',
        },
    );
    rec(
        'auth-scoped-other-session',
        'A scoped key naming a session outside its scope: answers 401, NOT 403 as the reference says.',
        await call({
            path: `/api/sessions/00000000-0000-4000-8000-000000000001`,
            key: scoped.body.apiKey,
        }),
        {
            keyLabel: 'REDACTED (operator, allowedSessions)',
            notes: [
                'Reference (6.1 Roles): "used outside its allowedSessions scope" is 403. The real image answers 401 "API key not authorized for this session": a client that treats 401 as "key invalid" misreads it.',
            ],
        },
    );

    for (const id of [viewer.body.id, operator.body.id, scoped.body.id]) {
        await call({ method: 'DELETE', path: `/api/auth/api-keys/${id}` });
    }

    created.keys.length = 0;
}

async function flowSessions() {
    console.log('sessions');
    const session = await ownSession(names.plain);
    const ids = { sessionId: session.body.id };

    rec(
        'sessions-create',
        'POST /api/sessions: a new session is `created` and not started.',
        session,
        { ids },
    );
    rec(
        'sessions-create-duplicate',
        'Creating the same name twice: 409.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: names.plain },
        }),
    );
    rec(
        'sessions-create-name-too-short',
        'Name shorter than 3 characters: 400 (production: no field detail).',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: 'ab' },
        }),
        {
            notes: [
                'NODE_ENV=production (the image default): the 400 body has `message: "Bad Request"` and NO `error` field and no field detail. VALIDATION_ERROR_DETAIL=true adds an array of messages (see the strict-* fixtures).',
            ],
        },
    );
    rec(
        'sessions-create-name-characters',
        'A name with a space: 400.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: 'has space' },
        }),
    );
    rec(
        'sessions-create-name-too-long',
        'A 51 character name: 400.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: 'x'.repeat(51) },
        }),
    );
    rec(
        'sessions-create-missing-name',
        'No name: 400.',
        await call({ method: 'POST', path: '/api/sessions', body: {} }),
    );
    rec(
        'sessions-create-unknown-property',
        'A body field the DTO does not declare: 400 (whitelist + forbidNonWhitelisted).',
        await call({
            method: 'POST',
            path: '/api/sessions',
            body: { name: `rec-extra-${stamp}`, surprise: 1 },
        }),
    );
    rec(
        'sessions-create-malformed-json',
        'A body that is not valid JSON.',
        await call({
            method: 'POST',
            path: '/api/sessions',
            rawBody: '{bad json',
        }),
        {
            notes: [
                'Surprise: the real image answers 404 "Cannot POST /api/sessions" for a malformed JSON body (the body parser error is rendered as a missing route), not 400.',
            ],
        },
    );
    rec(
        'sessions-list',
        'GET /api/sessions: a bare array.',
        await call({ path: '/api/sessions' }),
        {
            notes: [
                'Contains every session of the instance, including any that exist before this recording.',
            ],
        },
    );
    rec(
        'sessions-list-name-filter',
        'GET /api/sessions?name=<exact name>: the way to find a session by name.',
        await call({ path: `/api/sessions?name=${names.plain}` }),
    );
    rec(
        'sessions-list-name-miss',
        'GET /api/sessions?name=<unknown>: 200 [].',
        await call({ path: '/api/sessions?name=rec-no-such-session' }),
    );
    rec(
        'sessions-get',
        'GET /api/sessions/{id}.',
        await call({ path: `/api/sessions/${session.body.id}` }),
        { ids },
    );
    rec(
        'sessions-get-not-found',
        'An unknown (but well-formed) session id: 404.',
        await call({
            path: '/api/sessions/00000000-0000-4000-8000-000000000000',
        }),
    );
    rec(
        'sessions-get-not-uuid',
        'A session id that is not a UUID: 400 from the UUID pipe (on GET/start/stop; the messages routes do not parse it).',
        await call({ path: '/api/sessions/not-a-uuid' }),
    );
    rec(
        'sessions-qr-before-start',
        'GET .../qr on a session that was never started: 400.',
        await call({ path: `/api/sessions/${session.body.id}/qr` }),
        { ids },
    );
    rec(
        'sessions-stop-never-started',
        'POST .../stop on a session that was never started: still 200 (disconnected).',
        await call({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/stop`,
        }),
        { ids },
    );
    rec(
        'messages-send-text-session-not-started',
        'send-text on a session that is not running: 400 with no `code`.',
        await call({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/messages/send-text`,
            body: { chatId: '4915112345678@c.us', text: 'hello' },
        }),
        { ids },
    );
    rec(
        'messages-send-text-empty-text',
        'send-text with an empty text: 400.',
        await call({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/messages/send-text`,
            body: { chatId: '4915112345678@c.us', text: '' },
        }),
        { ids },
    );
    rec(
        'messages-send-text-too-long',
        'send-text with 4097 characters: 400.',
        await call({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/messages/send-text`,
            body: { chatId: '4915112345678@c.us', text: 'x'.repeat(4097) },
        }),
        { ids },
    );
    rec(
        'messages-send-text-unknown-property',
        'send-text with an undeclared field: 400.',
        await call({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/messages/send-text`,
            body: { chatId: '4915112345678@c.us', text: 'hi', surprise: true },
        }),
        { ids },
    );
    rec(
        'messages-media-not-found',
        'GET .../messages/{chatId}/{messageId}/media for a message that has no stored media: 404.',
        await call({
            path: `/api/sessions/${session.body.id}/messages/4915112345678@c.us/3EB0DOESNOTEXIST/media`,
        }),
        { ids },
    );

    const deleted = await call({
        method: 'DELETE',
        path: `/api/sessions/${session.body.id}`,
    });

    rec(
        'sessions-delete',
        'DELETE /api/sessions/{id}: 204, empty body.',
        deleted,
        { ids },
    );
    rec(
        'sessions-delete-twice',
        'Deleting it again: 404.',
        await call({
            method: 'DELETE',
            path: `/api/sessions/${session.body.id}`,
        }),
        { ids },
    );
    created.sessions = created.sessions.filter((id) => id !== session.body.id);

    const again = await ownSession(names.plain);

    rec(
        'sessions-create-after-delete',
        'Re-creating a never-paired session under a just-deleted name works at once (SESSION_NAME_TEARDOWN_PENDING needs a paired session; see error-session-name-teardown-pending).',
        again,
        { ids: { sessionId: again.body.id } },
    );
}

async function flowLifecycleAndDeliveries(receiver) {
    console.log(
        'lifecycle + signed deliveries (starting an engine takes 5-25 s)',
    );
    const session = await ownSession(names.lifecycle);
    const id = session.body.id;
    const ids = { sessionId: id };
    const hooks = `/api/sessions/${id}/webhooks`;
    const registered = {};

    receiver.only = id;

    for (const [label, path, events, retryCount] of [
        [
            'main',
            '/hook',
            [
                'session.status',
                'session.qr',
                'session.authenticated',
                'session.disconnected',
                'session.reconnect_loop',
                'message.received',
            ],
            undefined,
        ],
        ['fail', '/fail', ['session.status'], 3],
        ['redirect', '/redirect', ['session.status'], 1],
        ['slow', '/slow', ['session.status'], 1],
    ]) {
        const body = {
            url: hook(path),
            secret: TEST_SECRET,
            events,
            ...(retryCount === undefined ? {} : { retryCount }),
        };
        const result = expectStatus(
            await call({ method: 'POST', path: hooks, body }),
            201,
            `register webhook ${String(label)}`,
        );

        registered[label] = result.body;

        if (label === 'main') {
            rec(
                'webhooks-create',
                'POST .../webhooks to an address on the SSRF allow-list: 201; the response never carries the secret (write-only).',
                result,
                {
                    ids: { ...ids, webhookId: result.body.id },
                    notes: [
                        '`sessionId` in the response is the session UUID (the reference examples show a name). `retryCount` defaults to 3 (total attempts, including the first).',
                    ],
                },
            );
        }
    }

    const mainId = registered.main.id;
    const hookIds = { ...ids, webhookId: mainId };

    rec(
        'webhooks-list',
        'GET .../webhooks: a bare array, newest first; no secret, no headers.',
        await call({ path: hooks }),
        { ids },
    );
    rec(
        'webhooks-get',
        'GET .../webhooks/{id}.',
        await call({ path: `${hooks}/${mainId}` }),
        { ids: hookIds },
    );
    rec(
        'webhooks-get-not-found',
        'GET .../webhooks/{id} for an unknown id: 404.',
        await call({ path: `${hooks}/00000000-0000-4000-8000-000000000000` }),
        { ids },
    );
    rec(
        'webhooks-update',
        'PUT .../webhooks/{id}: partial update, returns the saved entity (no secret).',
        await call({
            method: 'PUT',
            path: `${hooks}/${mainId}`,
            body: { retryCount: 4 },
        }),
        { ids: hookIds },
    );
    await call({
        method: 'PUT',
        path: `${hooks}/${mainId}`,
        body: { retryCount: 3 },
    });
    rec(
        'webhooks-list-all-sessions',
        'GET /api/webhooks: the cross-session list (operator+).',
        await call({ path: '/api/webhooks' }),
    );

    // The test delivery: a synthetic `test` event signed like a real one.
    const test = await call({
        method: 'POST',
        path: `${hooks}/${mainId}/test`,
    });

    rec(
        'webhooks-test',
        'POST .../webhooks/{id}/test: delivers a synthetic event and reports the receiver status (200 even when the receiver says 500).',
        test,
        { ids: hookIds },
    );
    recDelivery(
        'webhook-delivery-test',
        'The `test` event delivery of POST .../webhooks/{id}/test.',
        await receiver.wait(receiver.event('test')),
        {
            notes: [
                'The idempotency key is `evt_test_<12 hex>` (no webhook id suffix): the reference says `test_<deliveryId>_<webhookId>`.',
                '`data` is {message, webhookId, url}.',
            ],
        },
    );

    // Status progression during the (blocking) start: poll in parallel.
    const startedAt = Date.now();
    const start = call({
        method: 'POST',
        path: `/api/sessions/${id}/start`,
        timeoutMs: 120_000,
    });
    const progress = [];
    let initializingQr = null;
    let initializingGet = null;

    while (
        !(await Promise.race([
            start.then(() => true),
            sleep(1500).then(() => false),
        ]))
    ) {
        const get = await call({ path: `/api/sessions/${id}` });
        const qr = await call({ path: `/api/sessions/${id}/qr` });

        if (get.body?.status === 'initializing' && initializingQr === null) {
            initializingQr = qr;
            initializingGet = get;
        }

        progress.push({
            atMs: Date.now() - startedAt,
            status: get.body?.status ?? null,
            qrStatus: qr.status,
        });
    }

    const started = await start;

    expectStatus(started, 200, 'start session');
    rec(
        'sessions-start',
        'POST .../start: BLOCKS until the engine is waiting for a scan, then answers 200 with status `qr_ready` (not `initializing`).',
        started,
        {
            ids,
            notes: [
                `Took ${started.ms} ms in this recording (about 20-25 s on a cold start, about 6 s when the browser cache is warm). The HTTP client needs a timeout well above 60 s; a stuck engine answers 504 after its own timeout.`,
            ],
        },
    );

    if (initializingGet !== null) {
        rec(
            'sessions-get-initializing',
            'GET /api/sessions/{id} while the (blocking) start is still running: `initializing`, engineLoaded true.',
            initializingGet,
            { ids },
        );
        rec(
            'sessions-qr-initializing',
            'GET .../qr while the engine starts: 400 "not ready yet".',
            initializingQr,
            { ids },
        );
    }

    rec(
        'sessions-start-twice',
        'POST .../start on a running session: 400 "already started".',
        await call({ method: 'POST', path: `/api/sessions/${id}/start` }),
        { ids },
    );

    const qr = await call({ path: `/api/sessions/${id}/qr` });

    rec(
        'sessions-qr',
        'GET .../qr while `qr_ready`: `{qrCode: data:image/png;base64,..., status}`.',
        qr,
        {
            ids,
            notes: [
                'The PNG is scrubbed; the real one is a 276x276 px PNG of about 4.7 KB (about 6.3 K characters as a data URL).',
            ],
        },
    );
    rec(
        'sessions-get-qr-ready',
        'GET /api/sessions/{id} once the QR is waiting.',
        await call({ path: `/api/sessions/${id}` }),
        { ids },
    );
    rec(
        'messages-send-text-session-not-ready',
        'send-text while the session waits for a scan (`qr_ready`): 400 not active.',
        await call({
            method: 'POST',
            path: `/api/sessions/${id}/messages/send-text`,
            body: { chatId: '4915112345678@c.us', text: 'hello' },
        }),
        { ids },
    );

    const first = {
        initializing: await receiver.wait(
            (delivery) =>
                delivery.headers['x-openwa-event'] === 'session.status' &&
                delivery.path === '/hook' &&
                JSON.parse(delivery.raw).data.status === 'initializing',
        ),
        qrReady: await receiver.wait(
            (delivery) =>
                delivery.headers['x-openwa-event'] === 'session.status' &&
                delivery.path === '/hook' &&
                JSON.parse(delivery.raw).data.status === 'qr_ready',
        ),
        qr: await receiver.wait(receiver.event('session.qr')),
    };

    recDelivery(
        'webhook-delivery-session-status-initializing',
        'Signed `session.status` delivery fired when the start begins.',
        first.initializing,
    );
    recDelivery(
        'webhook-delivery-session-status-qr-ready',
        'Signed `session.status` delivery when the QR is waiting.',
        first.qrReady,
    );
    recDelivery(
        'webhook-delivery-session-qr',
        'Signed `session.qr` delivery: `data: {sessionId, qr: <PNG data URL>}`.',
        first.qr,
        {
            notes: [
                'The QR image is scrubbed, so this file cannot be re-verified; the session.status deliveries can.',
                'A fresh `session.qr` follows about every 60 s while nobody scans.',
            ],
        },
    );

    rec(
        'sessions-stop',
        'POST .../stop on a running session: 200, `disconnected`, engineLoaded false.',
        await call({ method: 'POST', path: `/api/sessions/${id}/stop` }),
        { ids },
    );
    rec(
        'sessions-stop-twice',
        'Stopping a stopped session: 200 again.',
        await call({ method: 'POST', path: `/api/sessions/${id}/stop` }),
        { ids },
    );
    rec(
        'sessions-qr-after-stop',
        'GET .../qr after stop: 400 not started.',
        await call({ path: `/api/sessions/${id}/qr` }),
        { ids },
    );

    const disconnected = await receiver.wait(
        (delivery) =>
            delivery.path === '/hook' &&
            delivery.headers['x-openwa-event'] === 'session.status' &&
            JSON.parse(delivery.raw).data.status === 'disconnected',
    );

    recDelivery(
        'webhook-delivery-session-status-disconnected',
        'Signed `session.status` delivery after an API stop (OpenWA sends session.status but NOT session.disconnected for API-initiated stops).',
        disconnected,
    );

    // Retries: /fail answers 500 -> 3 attempts (+5 s, +10 s), same idempotency key and delivery id, retry count 0,1,2. Follow the `disconnected` event.
    const failing = [
        await receiver.wait(
            (delivery) =>
                delivery.path === '/fail' &&
                delivery.headers['x-openwa-event'] === 'session.status' &&
                delivery.headers['x-openwa-retry-count'] === '0' &&
                JSON.parse(delivery.raw).data.status === 'disconnected',
        ),
    ];
    const failingKey = failing[0].headers['x-openwa-idempotency-key'];

    for (const attempt of ['1', '2']) {
        failing.push(
            await receiver.wait(
                (delivery) =>
                    delivery.path === '/fail' &&
                    delivery.headers['x-openwa-idempotency-key'] ===
                        failingKey &&
                    delivery.headers['x-openwa-retry-count'] === attempt,
                60_000,
            ),
        );
    }

    const sameKey =
        new Set(
            failing.map(
                (delivery) => delivery.headers['x-openwa-idempotency-key'],
            ),
        ).size === 1;
    const sameDelivery =
        new Set(
            failing.map((delivery) => delivery.headers['x-openwa-delivery-id']),
        ).size === 1;

    save('webhook-delivery-retries', {
        source: 'recorded',
        recordedAt,
        openwa: {
            version: meta.version,
            image: meta.image,
            engine: meta.engine,
        },
        description:
            'A receiver that answers 500: OpenWA retries with exponential back-off (webhook retryCount 3 = three attempts in total).',
        attempts: failing.map((delivery) => ({
            retryCountHeader: delivery.headers['x-openwa-retry-count'],
            offsetMs: delivery.at - failing[0].at,
        })),
        sameIdempotencyKeyOnEveryAttempt: sameKey,
        sameDeliveryIdOnEveryAttempt: sameDelivery,
        notes: [
            'Delays: WEBHOOK_RETRY_DELAY (5000 ms default), doubling: the attempts arrive at about +0 s, +5 s, +15 s.',
            'A non-2xx answer, a timeout (WEBHOOK_TIMEOUT 10 s) and a network error are failures. A 302 is a failure too (lastError "Destination address is not allowed"): redirects are NOT followed, so the webhook URL must be the final one (an http -> https redirect in front of the app breaks deliveries).',
            'After the last attempt the failure is listed by GET /api/webhooks/delivery-failures; the webhook stays active.',
        ],
    });

    // The slow receiver (12 s) has been given up on after OpenWA's 10 s timeout by now; list the dead-letter trail.
    await sleep(1500);
    const failures = await call({ path: '/api/webhooks/delivery-failures' });

    if (Array.isArray(failures.body)) {
        failures.body = failures.body.filter((row) => row.sessionId === id);
    }

    rec(
        'webhooks-delivery-failures',
        "GET /api/webhooks/delivery-failures (admin): what ran out of retries (a 500, a 302, a receiver that never answered). Filtered to this recording's session; the real list is instance-wide.",
        failures,
        {
            notes: [
                '`lastStatusCode` is null for a timeout (lastError "The operation was aborted due to timeout") and for a redirect (lastError "Destination address is not allowed": a 302 is not followed and counts as a failure).',
            ],
        },
    );

    rec(
        'webhooks-delete',
        'DELETE .../webhooks/{id}: 204.',
        await call({
            method: 'DELETE',
            path: `${hooks}/${registered.fail.id}`,
        }),
        { ids: { ...ids, webhookId: registered.fail.id } },
    );
    rec(
        'webhooks-get-after-delete',
        'GET a deleted webhook: 404.',
        await call({ path: `${hooks}/${registered.fail.id}` }),
        { ids: { ...ids, webhookId: registered.fail.id } },
    );

    // A running session is removed with its webhooks.
    expectStatus(
        await call({ method: 'POST', path: `/api/sessions/${id}/start` }),
        200,
        'start again (warm)',
    );
    rec(
        'sessions-delete-running',
        'DELETE a session whose engine is running: 204 at once.',
        await call({ method: 'DELETE', path: `/api/sessions/${id}` }),
        { ids },
    );
    created.sessions = created.sessions.filter((sid) => sid !== id);
    rec(
        'webhooks-list-deleted-session',
        'GET .../webhooks of a deleted session: 404 (its webhooks went with it).',
        await call({ path: hooks }),
        { ids },
    );

    meta.startDurationMs = started.ms;
    meta.startProgress = progress;
}

async function flowWebhookRules() {
    console.log('webhook registration rules');
    const session = await ownSession(names.limit);
    const id = session.body.id;
    const ids = { sessionId: id };
    const hooks = `/api/sessions/${id}/webhooks`;
    const good = { secret: TEST_SECRET };

    rec(
        'webhooks-create-default-events',
        'No `events`: defaults to ["message.received"].',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: hook('/hook'), ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-ssrf-loopback',
        'A webhook for http://127.0.0.1:...: 400 "Destination address is not allowed" (even while another private host is allow-listed).',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'http://127.0.0.1:8368/hook', ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-ssrf-localhost',
        'http://localhost: 400, same message.',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'http://localhost:8368/hook', ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-ssrf-private-ip',
        'http://10.0.0.5: 400, same message.',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'http://10.0.0.5/hook', ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-ssrf-metadata-ip',
        'http://169.254.169.254: 400, same message.',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'http://169.254.169.254/latest', ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-url-credentials',
        'A URL with user:password@: 400 with its own message.',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'https://user:pass@example.com/hook', ...good },
        }),
        { ids },
    );
    rec(
        'webhooks-create-secret-too-short',
        'A secret shorter than 16 characters: 400 (no detail in production).',
        await call({
            method: 'POST',
            path: hooks,
            body: { url: 'https://example.com/hook', secret: 'short' },
        }),
        { ids },
    );
    rec(
        'webhooks-create-unknown-event',
        'An event name OpenWA does not know: 400.',
        await call({
            method: 'POST',
            path: hooks,
            body: {
                url: 'https://example.com/hook',
                ...good,
                events: ['nope.event'],
            },
        }),
        { ids },
    );
    rec(
        'webhooks-create-unknown-session',
        'A webhook for a session that does not exist: 404.',
        await call({
            method: 'POST',
            path: '/api/sessions/00000000-0000-4000-8000-000000000000/webhooks',
            body: { url: hook('/hook'), ...good },
        }),
    );

    // 16 per session (WEBHOOK_MAX_PER_SESSION): one exists already; add until OpenWA refuses.
    let accepted = 1;
    let refused = null;

    for (let index = 1; index <= 20 && refused === null; index += 1) {
        const attempt = await call({
            method: 'POST',
            path: hooks,
            body: { url: hook(`/hook?n=${index}`), ...good },
        });

        if (attempt.status === 201) {
            accepted += 1;
        } else {
            refused = attempt;
        }
    }

    if (refused !== null) {
        rec(
            'webhooks-create-limit',
            `The webhook after ${accepted} on one session is refused: 400 (WEBHOOK_MAX_PER_SESSION, default 16).`,
            refused,
            {
                ids,
                notes: [
                    `${accepted} webhooks were accepted before the refusal.`,
                ],
            },
        );
    } else {
        console.log(
            '  no webhook limit reached within 21 webhooks; fixture not written',
        );
    }

    await call({ method: 'DELETE', path: `/api/sessions/${id}` });
    created.sessions = created.sessions.filter((sid) => sid !== id);
}

async function flowStrict() {
    if (STRICT_BASE === null) {
        console.log('strict: skipped (no --strict-base)');

        return;
    }

    console.log('strict instance (no SSRF allow-list, validation detail on)');
    const strictKey = readKey(STRICT_CONTAINER, 'OPENWA_STRICT_API_KEY');

    secrets.add(strictKey);

    const callStrict = (spec) =>
        call({
            ...spec,
            base: STRICT_BASE,
            key: spec.key === undefined ? strictKey : spec.key,
        });
    const session = expectStatus(
        await callStrict({
            method: 'POST',
            path: '/api/sessions',
            body: { name: `rec-strict-${stamp}` },
        }),
        201,
        'strict: create session',
    );
    const ids = { sessionId: session.body.id };

    rec(
        'strict-sessions-create-name-too-short',
        'VALIDATION_ERROR_DETAIL=true: `message` is an array of strings and `error` is "Bad Request".',
        await callStrict({
            method: 'POST',
            path: '/api/sessions',
            body: { name: 'ab' },
        }),
    );
    rec(
        'strict-sessions-create-name-characters',
        'VALIDATION_ERROR_DETAIL=true: the bad-characters message.',
        await callStrict({
            method: 'POST',
            path: '/api/sessions',
            body: { name: 'has space' },
        }),
    );
    rec(
        'strict-sessions-create-missing-name',
        'VALIDATION_ERROR_DETAIL=true: several messages at once.',
        await callStrict({ method: 'POST', path: '/api/sessions', body: {} }),
    );
    rec(
        'strict-webhooks-create-secret-too-short',
        'VALIDATION_ERROR_DETAIL=true: the secret rule.',
        await callStrict({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/webhooks`,
            body: { url: 'https://example.com/hook', secret: 'short' },
        }),
        { ids },
    );
    rec(
        'strict-webhooks-create-ssrf-no-allowlist',
        'Without SSRF_ALLOWED_HOSTS the Docker host name is refused: 400 "Destination address is not allowed" (the hint the UI should give).',
        await callStrict({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/webhooks`,
            body: { url: hook('/hook'), secret: TEST_SECRET },
        }),
        { ids },
    );
    rec(
        'strict-messages-send-text-empty-chat',
        'VALIDATION_ERROR_DETAIL=true: send-text validation detail.',
        await callStrict({
            method: 'POST',
            path: `/api/sessions/${session.body.id}/messages/send-text`,
            body: { chatId: '', text: 'hi' },
        }),
        { ids },
    );

    await callStrict({
        method: 'DELETE',
        path: `/api/sessions/${session.body.id}`,
    });
}

async function flowThrottle() {
    console.log('throttler (last: it uses up the per-second budget)');
    await sleep(2000);

    const results = await Promise.all(
        Array.from({ length: 14 }, () =>
            call({ path: '/api/sessions', unpaced: true }),
        ),
    );
    const limited = results.find((result) => result.status === 429);

    for (let index = 0; index < 14; index += 1) {
        stamps.push(Date.now());
    }

    if (limited === undefined) {
        console.log(
            '  no 429 within 14 parallel calls (limiter not reached); fixture not written',
        );

        return;
    }

    rec(
        'ratelimit-throttled',
        'The global throttler (10 requests per second, 100 per minute, 1000 per hour per client address): 429 with NO `code` and NO `error`, and a Retry-After in seconds.',
        limited,
        {
            notes: [
                `Statuses of 14 parallel calls: ${results.map((result) => result.status).join(', ')}.`,
                'Not to be confused with SEND_PACING_LIMITED (429 with code + retryAfterSeconds, hours); this one clears in a second.',
                'The limits also show on every non-health response as X-RateLimit-Limit-short/-medium/-long.',
            ],
        },
    );
}

// ---------------------------------------------------------------------------------------------------------------------------

function dockerValue(args2) {
    try {
        return execFileSync('docker', args2, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
    } catch {
        return null;
    }
}

async function discover() {
    const health = await call({ path: '/api/health' });
    const validate = await call({ method: 'POST', path: '/api/auth/validate' });
    const sessions = await call({ path: '/api/sessions' });
    const digest = dockerValue([
        'inspect',
        CONTAINER,
        '--format',
        '{{.Image}}',
    ]);
    const imageName = dockerValue([
        'inspect',
        CONTAINER,
        '--format',
        '{{.Config.Image}}',
    ]);
    const repoDigests =
        digest === null
            ? null
            : dockerValue([
                  'image',
                  'inspect',
                  digest,
                  '--format',
                  '{{index .RepoDigests 0}}',
              ]);
    const labels =
        digest === null
            ? null
            : dockerValue([
                  'image',
                  'inspect',
                  digest,
                  '--format',
                  '{{json .Config.Labels}}',
              ]);
    const env = dockerValue([
        'inspect',
        CONTAINER,
        '--format',
        '{{json .Config.Env}}',
    ]);
    const kept = [
        'ENGINE_TYPE',
        'SSRF_ALLOWED_HOSTS',
        'RESOLVE_LID_TO_PHONE',
        'NODE_ENV',
        'VALIDATION_ERROR_DETAIL',
        'SEND_PACING_ENABLED',
    ];

    meta = {
        version: health.body?.version ?? 'unknown',
        image: repoDigests ?? imageName,
        engine: validate.body?.engineType ?? 'whatsapp-web.js',
        revision:
            labels === null
                ? null
                : (JSON.parse(labels)['org.opencontainers.image.revision'] ??
                  null),
        env:
            env === null
                ? {}
                : Object.fromEntries(
                      JSON.parse(env)
                          .filter((line) => kept.includes(line.split('=')[0]))
                          .map((line) => line.split(/=(.*)/s).slice(0, 2)),
                  ),
        rateLimitHeaders: Object.fromEntries(
            Object.entries(sessions.headers).filter(([key]) =>
                key.startsWith('x-ratelimit-limit'),
            ),
        ),
    };
    console.log(
        `OpenWA ${meta.version} (${meta.engine}) at ${BASE}; image ${meta.image ?? 'unknown'}`,
    );
}

function writeIndex() {
    const files = readdirSync(OUT)
        .filter((file) => file.endsWith('.json') && file !== 'index.json')
        .sort();
    const entries = files.map((file) => {
        const content = JSON.parse(readFileSync(join(OUT, file), 'utf8'));

        return {
            file,
            source: content.source ?? 'unknown',
            description: content.description ?? '',
        };
    });

    writeFileSync(
        join(OUT, 'index.json'),
        `${JSON.stringify({ note: 'Generated by scripts/openwa-record.mjs (recorded fixtures) and kept in step with the hand-written documented ones. source: recorded = captured from the real image, documented = built from docs/reference/openwa-api.md.', fixtures: entries }, null, 4)}\n`,
    );
    console.log(
        `index.json: ${entries.length} fixtures (${entries.filter((entry) => entry.source === 'recorded').length} recorded, ${entries.filter((entry) => entry.source === 'documented').length} documented)`,
    );
}

async function cleanup() {
    for (const id of created.sessions) {
        await call({ method: 'DELETE', path: `/api/sessions/${id}` }).catch(
            () => undefined,
        );
    }

    for (const id of created.keys) {
        await call({
            method: 'DELETE',
            path: `/api/auth/api-keys/${id}`,
        }).catch(() => undefined);
    }

    // Anything an earlier, interrupted run left behind.
    const leftovers = await call({ path: '/api/sessions' }).catch(() => null);

    for (const session of leftovers?.body ?? []) {
        if (String(session.name).startsWith('rec-')) {
            await call({
                method: 'DELETE',
                path: `/api/sessions/${session.id}`,
            }).catch(() => undefined);
        }
    }
}

const wants = (flow) => ONLY === null || ONLY.includes(flow);
const receiver = new Receiver();

if (INDEX_ONLY) {
    writeIndex();
    process.exit(0);
}

try {
    await discover();
    await cleanup();
    await receiver.start();

    if (wants('system')) {
        await flowSystem();
    }

    if (wants('auth')) {
        await flowAuth();
    }

    if (wants('sessions')) {
        await flowSessions();
    }

    if (wants('webhooks')) {
        await flowWebhookRules();
    }

    if (wants('lifecycle')) {
        await flowLifecycleAndDeliveries(receiver);
    }

    if (wants('strict')) {
        await flowStrict();
    }

    if (wants('throttle')) {
        await flowThrottle();
    }

    save('recording-meta', {
        source: 'recorded',
        recordedAt,
        description:
            'What the recording ran against and the numbers read off it.',
        openwa: {
            version: meta.version,
            image: meta.image,
            engine: meta.engine,
            revision: meta.revision ?? null,
            env: meta.env,
        },
        rateLimits: meta.rateLimitHeaders,
        startDurationMs: meta.startDurationMs ?? null,
        startStatusPolls: meta.startProgress ?? [],
    });
    writeIndex();
} finally {
    await cleanup().catch(() => undefined);
    await receiver.stop().catch(() => undefined);
}
