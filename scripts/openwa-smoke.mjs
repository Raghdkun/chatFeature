#!/usr/bin/env node
/**
 * A connectivity and capability check for ANY OpenWA gateway, for people (P6, track 6C): no npm packages, no PNE Chat running, Node 20+.
 * It cleans up after itself (the throw-away session and its webhook are deleted, a local receiver is closed) and never prints a key.
 *
 *   OPENWA_API_KEY=owa_k1_... node scripts/openwa-smoke.mjs --base=http://127.0.0.1:2785
 *   node scripts/openwa-smoke.mjs --base=https://wa.example.com --key-file=/path/to/key --no-start
 *   node scripts/openwa-smoke.mjs --webhook-url=http://host.docker.internal:8323/webhooks/openwa/smoke    # the URL PNE Chat will register
 *   node scripts/openwa-smoke.mjs --receiver-port=8368 --receiver-host=host.docker.internal            # prove a signed delivery end to end
 *
 * Without OPENWA_API_KEY / --key-file it reads the admin key of the dev container (`docker exec pne-chat-dev-openwa-1 cat /app/data/.api-key`).
 *
 * What it checks (PASS / WARN / FAIL / SKIP per line, exit code 1 when anything FAILs):
 *   1. the gateway answers (health, version, engine)
 *   2. the key is valid and its ROLE can operate (PNE Chat needs an unscoped operator or admin key to create sessions and send)
 *   3. a session can be created (3-50 letters, digits, hyphens) and read back
 *   4. the engine starts and a QR is served as a PNG data URL (skipped with --no-start; the start blocks 5-25 s and uses about 400 MB)
 *   5. a webhook can be registered for the address your app uses (--webhook-url), with the SSRF hint when OpenWA refuses it
 *   6. (with --receiver-port) OpenWA delivers a signed `test` event to this machine and the HMAC-SHA256 over the raw body verifies
 */
import { execFileSync } from 'node:child_process';
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';

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
const WEBHOOK_URL = args['webhook-url'] ? String(args['webhook-url']) : null;
const RECEIVER_PORT = args['receiver-port']
    ? Number(args['receiver-port'])
    : null;
const RECEIVER_HOST = String(args['receiver-host'] ?? 'host.docker.internal');
const START = args['no-start'] !== 'true';
const TESTED_WITH = '0.23.7';

const results = { pass: 0, warn: 0, fail: 0, skip: 0 };
const say = (level, text) => {
    results[level] += 1;
    console.log(`${level.toUpperCase().padEnd(5)} ${text}`);
};
const info = (text) => console.log(`      ${text}`);
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function readKey() {
    if (process.env.OPENWA_API_KEY) {
        return process.env.OPENWA_API_KEY.trim();
    }

    if (args['key-file']) {
        return readFileSync(String(args['key-file']), 'utf8').trim();
    }

    try {
        return execFileSync(
            'docker',
            ['exec', CONTAINER, 'cat', '/app/data/.api-key'],
            { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
        ).trim();
    } catch {
        return null;
    }
}

const KEY = readKey();

async function call(
    method,
    path,
    body,
    { key = KEY, timeoutMs = 120_000 } = {},
) {
    const response = await fetch(BASE + path, {
        method,
        headers: {
            ...(key ? { 'X-API-Key': key } : {}),
            ...(body === undefined
                ? {}
                : { 'Content-Type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    let parsed = text;

    try {
        parsed = text === '' ? null : JSON.parse(text);
    } catch {
        // not JSON
    }

    return { status: response.status, body: parsed, headers: response.headers };
}

const messageOf = (result) =>
    Array.isArray(result.body?.message)
        ? result.body.message.join('; ')
        : String(result.body?.message ?? JSON.stringify(result.body));

async function main() {
    console.log(`OpenWA smoke check against ${BASE}\n`);

    // 1. reachable ---------------------------------------------------------------------------------------------------------
    let health;

    try {
        health = await call('GET', '/api/health', undefined, {
            timeoutMs: 10_000,
        });
    } catch (error) {
        say(
            'fail',
            `cannot reach ${BASE}: ${error.cause?.code ?? error.cause?.message ?? error.message}. Is OpenWA running and is this the right address (port 2785 by default)?`,
        );

        return;
    }

    if (health.status !== 200) {
        say(
            'fail',
            `GET /api/health answered HTTP ${health.status} (${messageOf(health)}). Is something else on this port, or a proxy in the way?`,
        );

        return;
    }

    say('pass', 'the gateway answers /api/health');

    if (KEY === null) {
        say(
            'fail',
            'no API key: set OPENWA_API_KEY, pass --key-file=<file>, or run the dev container (the key is printed once in its first start log and kept in /app/data/.api-key)',
        );

        return;
    }

    // 2. the key ------------------------------------------------------------------------------------------------------------
    const validate = await call('POST', '/api/auth/validate');

    if (validate.status === 401) {
        say(
            'fail',
            `the API key is not accepted (${messageOf(validate)}). It may be revoked, expired, mistyped, or from another OpenWA instance (a data volume that was recreated mints a new key).`,
        );

        return;
    }

    if (validate.status !== 200) {
        say(
            'fail',
            `POST /api/auth/validate answered HTTP ${validate.status} (${messageOf(validate)})`,
        );

        return;
    }

    const { role, engineType } = validate.body;
    const authedHealth = await call('GET', '/api/health');

    say(
        'pass',
        `key valid, role "${role}", engine "${engineType}", version ${authedHealth.body?.version ?? 'unknown'}`,
    );

    if (
        authedHealth.body?.version &&
        authedHealth.body.version !== TESTED_WITH
    ) {
        say(
            'warn',
            `PNE Chat was verified against OpenWA ${TESTED_WITH}; this is ${authedHealth.body.version}. Re-run this check after upgrading and read the release notes for webhook / session changes.`,
        );
    }

    if (role === 'viewer') {
        say(
            'fail',
            'a viewer key cannot create sessions, register webhooks or send. PNE Chat needs an unscoped operator or admin key.',
        );

        return;
    }

    if (engineType !== 'whatsapp-web.js') {
        say(
            'warn',
            `engine "${engineType}": PNE Chat was verified with whatsapp-web.js (chat ids are @c.us there, @s.whatsapp.net on Baileys; both are handled, but Baileys has a higher ban risk)`,
        );
    }

    // 3. a session ----------------------------------------------------------------------------------------------------------
    const name = `smoke-${randomBytes(3).toString('hex')}`;
    const created = await call('POST', '/api/sessions', { name });
    let sessionId = null;
    let receiver = null;

    if (created.status === 403) {
        say(
            'fail',
            `creating a session is refused (${messageOf(created)}): a key scoped to some sessions cannot create new ones. Use an unscoped operator/admin key.`,
        );

        return;
    }

    if (created.status !== 201) {
        say(
            'fail',
            `creating a session answered HTTP ${created.status} (${messageOf(created)})`,
        );

        return;
    }

    sessionId = created.body.id;
    say('pass', `created session "${name}" (${created.body.status})`);

    try {
        const read = await call('GET', `/api/sessions/${sessionId}`);

        say(
            read.status === 200 && read.body.name === name ? 'pass' : 'fail',
            `the session reads back (HTTP ${read.status})`,
        );

        // 4. start + QR -------------------------------------------------------------------------------------------------------
        if (START) {
            const started = Date.now();
            const start = await call(
                'POST',
                `/api/sessions/${sessionId}/start`,
            ).catch((error) => ({
                status: 0,
                body: {
                    message:
                        error.name === 'TimeoutError'
                            ? 'no answer within 2 minutes'
                            : error.message,
                },
            }));

            if (start.status === 200) {
                say(
                    'pass',
                    `the engine started in ${((Date.now() - started) / 1000).toFixed(1)} s, status "${start.body.status}"`,
                );
                info(
                    '(the start call BLOCKS until the engine waits for a scan: give an HTTP client a timeout of 90 s or more)',
                );

                const qr = await call('GET', `/api/sessions/${sessionId}/qr`);
                const png = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(
                    qr.body?.qrCode ?? '',
                );

                if (qr.status === 200 && png) {
                    const bytes = Buffer.from(png[1], 'base64');

                    say(
                        'pass',
                        `a QR is served as a PNG data URL (${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)} px, ${bytes.length} bytes); it refreshes about every 60 s while unscanned`,
                    );
                } else if (start.body.status === 'ready') {
                    say('skip', 'the session is already paired (ready): no QR');
                } else {
                    say('fail', `no QR: HTTP ${qr.status} ${messageOf(qr)}`);
                }
            } else if (start.status === 504) {
                say(
                    'fail',
                    `the engine did not start in time (HTTP 504): WhatsApp Web is unreachable from the container (DNS / firewall / an unreachable proxy), or the container lacks memory (give it 1 GB). ${messageOf(start)}`,
                );
            } else {
                say(
                    'fail',
                    `starting the engine answered HTTP ${start.status}: ${messageOf(start)}`,
                );
            }
        } else {
            say('skip', 'engine start and QR (--no-start)');
        }

        // 5 + 6. webhook -----------------------------------------------------------------------------------------------------
        const secret = randomBytes(24).toString('hex');
        let url = WEBHOOK_URL;
        const deliveries = [];

        if (RECEIVER_PORT !== null) {
            receiver = createServer((request, response) => {
                const chunks = [];

                request.on('data', (chunk) => chunks.push(chunk));
                request.on('end', () => {
                    deliveries.push({
                        headers: request.headers,
                        raw: Buffer.concat(chunks).toString('utf8'),
                    });
                    response.writeHead(200);
                    response.end();
                });
            });
            await new Promise((done, fail) => {
                receiver.once('error', fail);
                receiver.listen(RECEIVER_PORT, '127.0.0.1', done);
            });
            url = `http://${RECEIVER_HOST}:${RECEIVER_PORT}/openwa-smoke`;
        }

        if (url === null) {
            say(
                'skip',
                'webhook registration (pass --webhook-url=<the address PNE Chat will register> or --receiver-port=<free port>)',
            );
        } else {
            const hook = await call(
                'POST',
                `/api/sessions/${sessionId}/webhooks`,
                { url, secret, events: ['session.status', 'message.received'] },
            );

            if (hook.status === 201) {
                say(
                    'pass',
                    `a webhook for ${url} was accepted (the secret is write-only: PNE Chat keeps its own copy)`,
                );

                if (receiver !== null) {
                    const test = await call(
                        'POST',
                        `/api/sessions/${sessionId}/webhooks/${hook.body.id}/test`,
                    );

                    await sleep(300);

                    const delivery = deliveries[0];

                    if (test.body?.success !== true || delivery === undefined) {
                        say(
                            'fail',
                            `OpenWA could not deliver to ${url}: ${JSON.stringify(test.body)}. Is ${RECEIVER_HOST} reachable from the OpenWA container and allowed by SSRF_ALLOWED_HOSTS?`,
                        );
                    } else {
                        const expected = `sha256=${createHmac('sha256', secret).update(delivery.raw).digest('hex')}`;
                        const given = String(
                            delivery.headers['x-openwa-signature'] ?? '',
                        );
                        const good =
                            given.length === expected.length &&
                            timingSafeEqual(
                                Buffer.from(given),
                                Buffer.from(expected),
                            );

                        say(
                            good ? 'pass' : 'fail',
                            good
                                ? 'a signed delivery arrived and X-OpenWA-Signature = sha256=HMAC-SHA256(secret, raw body) verifies'
                                : 'a delivery arrived but its signature does not verify (the raw body was altered, or the secret differs)',
                        );
                        say(
                            delivery.headers['x-openwa-idempotency-key'] &&
                                delivery.headers['x-openwa-delivery-id']
                                ? 'pass'
                                : 'fail',
                            `idempotency headers present (${delivery.headers['x-openwa-idempotency-key'] ?? 'missing'})`,
                        );
                    }
                } else {
                    info(
                        '(registered only: nothing was delivered; add --receiver-port to prove a signed delivery)',
                    );
                }
            } else if (
                hook.status === 400 &&
                /destination address is not allowed/i.test(messageOf(hook))
            ) {
                say(
                    'fail',
                    `OpenWA refused the webhook address ${url} (SSRF guard: "Destination address is not allowed").`,
                );
                info(
                    'The address resolves to a private, loopback or Docker-internal host. Fix: set SSRF_ALLOWED_HOSTS on the OpenWA container to include that host,',
                );
                info(
                    'e.g. SSRF_ALLOWED_HOSTS=host.docker.internal (app on the Docker host) or the compose service name (app in the same compose network), then recreate the container.',
                );
                info(
                    'Or use a public https address (a tunnel, or the production domain).',
                );
            } else if (
                hook.status === 400 &&
                /credentials/i.test(messageOf(hook))
            ) {
                say(
                    'fail',
                    `OpenWA refuses webhook URLs with user:password@ in them (${messageOf(hook)}).`,
                );
            } else if (hook.status === 400 && /limit/i.test(messageOf(hook))) {
                say(
                    'fail',
                    `the webhook limit of a session is reached (${messageOf(hook)}).`,
                );
            } else {
                say(
                    'fail',
                    `registering the webhook answered HTTP ${hook.status}: ${messageOf(hook)}`,
                );
            }
        }
    } finally {
        // Cleanup: deleting a session removes its webhooks too.
        const removed =
            sessionId === null
                ? null
                : await call('DELETE', `/api/sessions/${sessionId}`).catch(
                      () => null,
                  );

        if (removed !== null && removed.status === 204) {
            info(`cleaned up: session "${name}" and its webhook deleted`);
        } else if (sessionId !== null) {
            say(
                'warn',
                `could not delete the throw-away session "${name}" (${sessionId}): delete it by hand (DELETE /api/sessions/${sessionId})`,
            );
        }

        if (receiver !== null) {
            receiver.closeAllConnections?.();
            await new Promise((done) => receiver.close(() => done()));
        }
    }
}

try {
    await main();
} catch (error) {
    say('fail', `unexpected error: ${error?.message ?? error}`);
}

console.log(
    `\n${results.pass} passed, ${results.warn} warnings, ${results.fail} failed, ${results.skip} skipped`,
);
process.exit(results.fail > 0 ? 1 : 0);
