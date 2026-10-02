#!/usr/bin/env node
/**
 * A stateful mock of the OpenWA REST API for the e2e suite (P6, track 6C): no dependencies, plain `node:http`.
 *
 *   node e2e/support/openwa-mock.mjs --port=8366 --key=owa_k1_e2e-mock-key [--retry-base-ms=300] [--ssrf=allow-loopback|strict]
 *
 * It reproduces the shapes RECORDED from the real image (`tests/fixtures/openwa/*.json`, `docs/whatsapp-openwa.md`) for the subset
 * the application uses: `POST /api/auth/validate`, sessions (create, list, get, start, stop, delete, QR), webhooks (register, list,
 * get, update, delete, test), `send-text`, the media download, the NestJS error bodies and the API-key rules (roles, scoped keys),
 * plus the global throttler's 429 and `SEND_PACING_LIMITED`. Deliveries are signed like OpenWA signs them (`X-OpenWA-Signature:
 * sha256=<hex>` = HMAC-SHA256 over the RAW body with the secret the app registered) and carry the same headers, the same idempotency
 * keys, and the retry behaviour seen on the real image (attempts = `retryCount`, back-off doubling from `WEBHOOK_RETRY_DELAY`).
 *
 * A CONTROL API under `/__mock/` (no key; the mock listens on 127.0.0.1) drives the tests, see `e2e/support/openwa.ts` for the typed
 * client:
 *
 *   GET  /__mock/health                       readiness probe for Playwright
 *   POST /__mock/reset                        forget everything (sessions, webhooks, logs, scripts, config)
 *   GET  /__mock/state                        sessions, webhooks, config
 *   GET  /__mock/requests[?method=&path=&since=]  what the app called (API calls only, newest last); DELETE clears it
 *   GET  /__mock/deliveries[?event=&since=&key=]  every delivery ATTEMPT to the app (status it answered, headers, raw body); `key` = a part of the idempotency key (e.g. a message id)
 *   POST /__mock/config                       { startDelayMs, retryBaseMs, deliveryTimeoutMs, ssrf, validationDetail, teardownPendingMs,
 *                                               acks:{mode:'auto'|'manual',steps,delayMs}, pacing:{minIntervalMs,dailyCap,coldDailyCap},
 *                                               resolveLid, mediaInlineMaxBytes, sentEcho }
 *   POST /__mock/script                       { method?, path?, status, body?, headers?, times? } the next matching API call answers that
 *   POST /__mock/throttle                     { next: n } the next n API calls answer the throttler's 429
 *   POST /__mock/keys                         { role, allowedSessions? } -> { key, id }
 *   POST /__mock/sessions                     { name, status?, phone?, pushName? } create a session in any state without events
 *   POST /__mock/sessions/:ref/status         { status, phone?, pushName?, reason? } move a session (ref = id or name); emits the events
 *   POST /__mock/sessions/:ref/qr             a fresh QR (`session.qr`)
 *   POST /__mock/sessions/:ref/inbound        inject a message: text, image (inline or omitted), group, @lid, fromMe ...
 *   POST /__mock/sessions/:ref/ack            { messageId, status } fire `message.ack` (+ `message.failed`)
 *   POST /__mock/sessions/:ref/acks           { mode, steps, delayMs } this session's own ack plan (`config.acks` is the default for the rest)
 *   POST /__mock/replay                       { delivery: n, sameBody? } deliver an earlier delivery again (same idempotency key)
 *   POST /__mock/deliver                      { session?, event, data, signature?: 'valid'|'bad'|'wrong-secret'|'missing', url?, ... }
 *
 * `OpenWA ids`: sessions are UUIDs, the webhook secret is write-only (kept here, never returned), a QR is a generated PNG (never a
 * real code). Not part of the app: test support only.
 */
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { deflateSync } from 'node:zlib';

export const DEFAULT_API_KEY = 'owa_k1_e2e-mock-admin-key';
/** What the real image reports for itself; the mock says it is the version it was recorded from. */
export const MOCK_VERSION = '0.23.7';

export const WEBHOOK_EVENTS = [
    'message.received',
    'message.sent',
    'message.ack',
    'message.failed',
    'message.revoked',
    'message.reaction',
    'message.edited',
    'status.received',
    'session.status',
    'session.qr',
    'session.authenticated',
    'session.disconnected',
    'session.reconnect_loop',
    'session.restriction',
    'presence.update',
    'group.join',
    'group.leave',
    'group.update',
    'group.join_request',
    'call.received',
    'call.accepted',
    'call.rejected',
    'call.missed',
    '*',
];

const MAX_WEBHOOKS_PER_SESSION = 16;
const ROLE_RANK = { viewer: 1, operator: 2, admin: 3 };
const UUID_PATTERN =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REASONS = {
    200: 'OK',
    201: 'Created',
    204: 'No Content',
    400: 'Bad Request',
    401: 'Unauthorized',
    403: 'Forbidden',
    404: 'Not Found',
    409: 'Conflict',
    429: 'Too Many Requests',
    500: 'Internal Server Error',
    502: 'Bad Gateway',
    503: 'Service Unavailable',
    504: 'Gateway Timeout',
};

// ---------------------------------------------------------------------------------------------------------------------------
// Small helpers

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const nowIso = () => new Date().toISOString();
/** OpenWA stores entity timestamps with second precision (`2026-10-02T01:45:35.000Z`). */
const secondIso = () => `${new Date().toISOString().slice(0, 19)}.000Z`;
const epochSeconds = () => Math.floor(Date.now() / 1000);
const shortHash = (value) =>
    createHash('sha1')
        .update(typeof value === 'string' ? value : JSON.stringify(value))
        .digest('hex')
        .slice(0, 12);

/** `sha256=<hex>`: HMAC-SHA256 over the exact bytes that are sent. */
export function sign(secret, rawBody) {
    return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);

    for (let n = 0; n < 256; n += 1) {
        let c = n;

        for (let k = 0; k < 8; k += 1) {
            c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        }

        table[n] = c >>> 0;
    }

    return table;
})();

function crc32(buffer) {
    let crc = 0xffffffff;

    for (const byte of buffer) {
        crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
    }

    return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
    const length = Buffer.alloc(4);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);

    length.writeUInt32BE(data.length);
    crc.writeUInt32BE(crc32(body));

    return Buffer.concat([length, body, crc]);
}

/** A valid PNG. `paint(x, y)` returns [r, g, b] (colour type 2) or a number 0-255 (greyscale). */
export function makePng(width, height, paint, { grey = false } = {}) {
    const bytesPerPixel = grey ? 1 : 3;
    const raw = Buffer.alloc((width * bytesPerPixel + 1) * height);

    for (let y = 0; y < height; y += 1) {
        const row = y * (width * bytesPerPixel + 1);

        raw[row] = 0;

        for (let x = 0; x < width; x += 1) {
            const value = paint(x, y);

            if (grey) {
                raw[row + 1 + x] = value;
            } else {
                raw[row + 1 + x * 3] = value[0];
                raw[row + 2 + x * 3] = value[1];
                raw[row + 3 + x * 3] = value[2];
            }
        }
    }

    const header = Buffer.alloc(13);

    header.writeUInt32BE(width, 0);
    header.writeUInt32BE(height, 4);
    header[8] = 8;
    header[9] = grey ? 0 : 2;

    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        pngChunk('IHDR', header),
        pngChunk('IDAT', deflateSync(raw)),
        pngChunk('IEND', Buffer.alloc(0)),
    ]);
}

/** A QR-LOOKING PNG (276x276 like the real one, deterministic per seed): it can never be scanned. */
export function fakeQrDataUrl(seed) {
    const modules = 23;
    const scale = 12;
    const digest = createHash('sha256').update(String(seed)).digest();
    const grid = Array.from({ length: modules }, (_, y) =>
        Array.from(
            { length: modules },
            (_, x) =>
                ((digest[(y * modules + x) % digest.length] >> (x % 8)) & 1) ===
                1,
        ),
    );
    const finder = (cx, cy) => (x, y) =>
        x >= cx &&
        x < cx + 7 &&
        y >= cy &&
        y < cy + 7 &&
        (x === cx ||
            x === cx + 6 ||
            y === cy ||
            y === cy + 6 ||
            (x >= cx + 2 && x <= cx + 4 && y >= cy + 2 && y <= cy + 4));
    const finders = [
        finder(0, 0),
        finder(modules - 7, 0),
        finder(0, modules - 7),
    ];
    const inFinderZone = (x, y) =>
        (x < 8 && y < 8) ||
        (x >= modules - 8 && y < 8) ||
        (x < 8 && y >= modules - 8);
    const png = makePng(
        modules * scale,
        modules * scale,
        (px, py) => {
            const x = Math.floor(px / scale);
            const y = Math.floor(py / scale);
            const dark = inFinderZone(x, y)
                ? finders.some((isDark) => isDark(x, y))
                : grid[y][x];

            return dark ? 0 : 255;
        },
        { grey: true },
    );

    return `data:image/png;base64,${png.toString('base64')}`;
}

/** A small colourful picture for inbound image messages. */
export function samplePng(size = 64) {
    return makePng(size, size, (x, y) => [
        Math.floor((x / size) * 255),
        Math.floor((y / size) * 255),
        160,
    ]);
}

// ---------------------------------------------------------------------------------------------------------------------------
// The mock

function defaults(options) {
    return {
        startDelayMs: options.startDelayMs ?? 0,
        retryBaseMs: options.retryBaseMs ?? 5000,
        deliveryTimeoutMs: options.deliveryTimeoutMs ?? 10_000,
        /** `allow-loopback`: SSRF_ALLOWED_HOSTS=127.0.0.1,localhost (what the e2e app needs). `strict`: private hosts are refused like a real OpenWA without an allow-list. */
        ssrf: options.ssrf ?? 'allow-loopback',
        /** VALIDATION_ERROR_DETAIL: false (production) answers `{message: 'Bad Request', statusCode: 400}`. */
        validationDetail: options.validationDetail ?? false,
        /** A deleted PAIRED session keeps its name reserved for this long (SESSION_NAME_TEARDOWN_PENDING). */
        teardownPendingMs: options.teardownPendingMs ?? 0,
        acks: { mode: 'auto', steps: ['sent', 'delivered'], delayMs: 40 },
        pacing: { minIntervalMs: 0, dailyCap: 0, coldDailyCap: 0 },
        /** RESOLVE_LID_TO_PHONE */
        resolveLid: true,
        /** WEBHOOK_MEDIA_INLINE_MAX_BYTES effective: 1 MiB payload cap leaves about 768 KiB of media. */
        mediaInlineMaxBytes: 786_432,
        /** OpenWA reports an API send back as `message.sent` (own-send echo). */
        sentEcho: true,
    };
}

export async function startOpenWaMock(options = {}) {
    const adminKey = options.apiKey ?? DEFAULT_API_KEY;
    const host = options.host ?? '127.0.0.1';
    let state;

    function resetState() {
        state = {
            config: defaults(options),
            sessions: new Map(),
            webhooks: new Map(),
            keys: new Map([
                [
                    adminKey,
                    { id: 'key-admin', role: 'admin', allowedSessions: null },
                ],
            ]),
            requests: [],
            deliveries: [],
            failures: [],
            scripts: [],
            throttleNext: 0,
            reservedNames: new Map(),
            counters: { request: 0, delivery: 0 },
            sends: new Map(),
            chains: new Map(),
            timers: new Set(),
        };
    }

    resetState();

    // ----------------------------------------------------------------------------------------------------------- responses

    class Reply {
        constructor(status, body, headers = {}) {
            this.status = status;
            this.body = body;
            this.headers = headers;
        }
    }

    const reply = (status, body, headers) => new Reply(status, body, headers);
    const fail = (status, message, extra = {}) =>
        new Reply(status, {
            message,
            error: REASONS[status] ?? 'Error',
            statusCode: status,
            ...extra,
        });
    const validation = (...messages) =>
        state.config.validationDetail
            ? new Reply(400, {
                  message: messages,
                  error: 'Bad Request',
                  statusCode: 400,
              })
            : new Reply(400, { message: 'Bad Request', statusCode: 400 });

    // ------------------------------------------------------------------------------------------------------------ sessions

    const dto = (session) => ({
        id: session.id,
        name: session.name,
        status: session.status,
        phone: session.phone,
        pushName: session.pushName,
        connectedAt: session.connectedAt,
        lastActive: session.lastActive,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        lastError: session.lastError,
        restriction: null,
        engineLoaded: session.engineLoaded,
    });

    function createSession(name, extra = {}) {
        const stamp = secondIso();
        const session = {
            id: randomUUID(),
            name,
            status: 'created',
            phone: null,
            pushName: null,
            connectedAt: null,
            lastActive: null,
            createdAt: stamp,
            updatedAt: stamp,
            lastError: null,
            engineLoaded: false,
            paired: false,
            qr: null,
            messages: [],
            media: new Map(),
            sendLog: [],
            ...extra,
        };

        state.sessions.set(session.id, session);

        return session;
    }

    const findSession = (ref) =>
        state.sessions.get(ref) ??
        [...state.sessions.values()].find((session) => session.name === ref);

    function touch(session) {
        session.updatedAt = secondIso();
    }

    // ---------------------------------------------------------------------------------------------------------------- SSRF

    function isPrivateHost(hostname) {
        const bare = hostname.replace(/^\[|\]$/g, '').toLowerCase();

        if (
            bare === 'localhost' ||
            bare.endsWith('.localhost') ||
            bare.endsWith('.internal') ||
            bare.endsWith('.local') ||
            !bare.includes('.')
        ) {
            return true;
        }

        if (bare.includes(':')) {
            return (
                bare === '::1' ||
                bare.startsWith('fc') ||
                bare.startsWith('fd') ||
                bare.startsWith('fe80')
            );
        }

        const parts = bare.split('.').map(Number);

        if (
            parts.length !== 4 ||
            parts.some((part) => !Number.isInteger(part))
        ) {
            return false;
        }

        const [a, b] = parts;

        return (
            a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168) ||
            (a === 169 && b === 254)
        );
    }

    function ssrfAllows(url) {
        if (state.config.ssrf !== 'strict') {
            return true;
        }

        return !isPrivateHost(url.hostname);
    }

    // -------------------------------------------------------------------------------------------------------------- events

    const eventKey = (event, session, data, occurredAt) => {
        const sid = session.id;
        const message = data?.messageId ?? data?.id;

        switch (event) {
            case 'message.received':
            case 'message.sent':
                return `msg_${sid}_${message}`;
            case 'message.ack':
                return `ack_${sid}_${message}_${data.status}`;
            case 'message.failed':
                return `failed_${sid}_${message}_${data.status}`;
            case 'message.revoked':
                return `rev_${sid}_${message}`;
            case 'session.qr':
                return `qr_${sid}_${shortHash(data.qr)}`;
            case 'session.status':
                return `sess_${sid}_${data.status}_${occurredAt}`;
            case 'session.authenticated':
                return `auth_${sid}_${shortHash(data)}_${occurredAt}`;
            case 'session.disconnected':
                return `disc_${sid}_${shortHash(data.reason ?? '')}_${occurredAt}`;
            case 'session.reconnect_loop':
                return `loop_${sid}_${data.attempts}_${occurredAt}`;
            default:
                return `evt_${event.replaceAll('.', '_')}_${shortHash(data)}`;
        }
    };

    /** Every active webhook of the session that listens for the event gets its own delivery (own idempotency key, own delivery id). */
    function emit(session, event, data) {
        const occurredAt = nowIso();

        for (const hook of state.webhooks.values()) {
            if (
                hook.sessionId !== session.id ||
                !hook.active ||
                !(hook.events.includes(event) || hook.events.includes('*'))
            ) {
                continue;
            }

            hook.lastTriggeredAt = nowIso();
            queueDelivery(hook, {
                event,
                timestamp: nowIso(),
                sessionId: session.id,
                idempotencyKey: `${eventKey(event, session, data, occurredAt)}_${hook.id}`,
                deliveryId: `dlv_${randomUUID()}`,
                data,
            });
        }
    }

    function buildHeaders(hook, payload, rawBody, retryCount) {
        return {
            'Content-Type': 'application/json',
            'User-Agent': 'OpenWA-Webhook/1.0.0',
            'X-OpenWA-Event': payload.event,
            'X-OpenWA-Idempotency-Key': payload.idempotencyKey,
            'X-OpenWA-Delivery-Id': payload.deliveryId,
            'X-OpenWA-Retry-Count': String(retryCount),
            ...(hook.secret
                ? { 'X-OpenWA-Signature': sign(hook.secret, rawBody) }
                : {}),
        };
    }

    /** One POST to the receiver: never follows redirects, gives up after `deliveryTimeoutMs`. */
    async function post(url, headers, rawBody) {
        const controller = new AbortController();
        const timer = setTimeout(
            () => controller.abort(),
            state.config.deliveryTimeoutMs,
        );

        try {
            const response = await fetch(url, {
                method: 'POST',
                headers,
                body: rawBody,
                redirect: 'manual',
                signal: controller.signal,
            });

            await response.arrayBuffer().catch(() => undefined);

            return {
                status: response.status,
                error:
                    response.status >= 200 && response.status < 300
                        ? null
                        : `HTTP ${response.status}: ${REASONS[response.status] ?? response.statusText}`,
            };
        } catch (error) {
            return {
                status: null,
                error:
                    error?.name === 'AbortError'
                        ? 'timeout'
                        : String(error?.cause?.code ?? error?.message ?? error),
            };
        } finally {
            clearTimeout(timer);
        }
    }

    function logAttempt(entry) {
        const record = {
            n: (state.counters.delivery += 1),
            at: nowIso(),
            ...entry,
        };

        state.deliveries.push(record);

        return record;
    }

    const isOk = (result) =>
        result.status !== null && result.status >= 200 && result.status < 300;

    /**
     * One delivery: attempt 0 goes out in order per webhook (so the app sees events in the order they happened), the retries
     * (`retryCount` attempts in total, back-off doubling from `retryBaseMs`) run on their own and never hold the chain.
     */
    function queueDelivery(hook, payload) {
        const world = state;
        const rawBody = JSON.stringify(payload);
        const attempts = Math.max(1, hook.retryCount);
        const attempt = async (number) => {
            const headers = buildHeaders(hook, payload, rawBody, number);
            const result = await post(hook.url, headers, rawBody);
            const ok = isOk(result);
            const last = number === attempts - 1;

            if (world !== state) {
                return true; // reset() meanwhile: this delivery belongs to a world that no longer exists
            }

            logAttempt({
                event: payload.event,
                sessionId: payload.sessionId,
                webhookId: hook.id,
                url: hook.url,
                deliveryId: payload.deliveryId,
                idempotencyKey: payload.idempotencyKey,
                retryCount: number,
                status: result.status,
                error: result.error,
                outcome: ok ? 'delivered' : last ? 'failed' : 'retrying',
                headers,
                rawBody,
            });

            if (!ok && last) {
                state.failures.unshift({
                    id: randomUUID(),
                    webhookId: hook.id,
                    sessionId: payload.sessionId,
                    event: payload.event,
                    url: hook.url,
                    idempotencyKey: payload.idempotencyKey,
                    deliveryId: payload.deliveryId,
                    attempts,
                    lastStatusCode: result.status,
                    lastError: result.error,
                    createdAt: secondIso(),
                });
            }

            return ok;
        };
        const first = (world.chains.get(hook.id) ?? Promise.resolve()).then(
            () => attempt(0),
        );

        world.chains.set(
            hook.id,
            first.then(
                () => undefined,
                () => undefined,
            ),
        );

        void first.then(async (delivered) => {
            for (let number = 1; !delivered && number < attempts; number += 1) {
                await sleep(world.config.retryBaseMs * 2 ** (number - 1));

                if (world !== state) {
                    return;
                }

                delivered = await attempt(number);
            }
        });
    }

    // ----------------------------------------------------------------------------------------------------------- messages

    const chatIdOf = (value) => {
        const text = String(value ?? '').trim();

        if (text.includes('@')) {
            return text;
        }

        return `${text.replace(/\D+/g, '')}@c.us`;
    };

    const waId = (fromMe, chatId) =>
        `${fromMe ? 'true' : 'false'}_${chatId}_${randomBytes(8).toString('hex').toUpperCase()}`;

    function inboundMessage(session, input) {
        const fromMe = input.fromMe === true;
        const kind =
            input.kind ??
            (input.isGroup
                ? 'group'
                : String(input.chatId ?? input.from ?? '').endsWith('@g.us')
                  ? 'group'
                  : 'individual');
        const isGroup = kind === 'group';
        const lid = input.lid === true;
        const peer =
            input.chatId ??
            input.from ??
            (isGroup
                ? '120363000000000001@g.us'
                : lid
                  ? '123456789012345@lid'
                  : '4915112345678@c.us');
        const chatId = chatIdOf(peer);
        const mine = session.phone
            ? `${session.phone}@c.us`
            : '4915100000000@c.us';
        const id = input.id ?? waId(fromMe, chatId);
        const message = {
            id,
            from: fromMe ? mine : chatId,
            to: fromMe ? chatId : mine,
            chatId,
            body: input.body ?? '',
            type: input.type ?? (input.media ? 'image' : 'text'),
            timestamp: input.timestamp ?? epochSeconds(),
            fromMe,
            isGroup,
            kind,
            ...(isGroup || input.author
                ? { author: input.author ?? '4915198765432@c.us' }
                : {}),
            contact: {
                pushName: input.pushName ?? 'Test Customer',
                ...(input.contactName ? { name: input.contactName } : {}),
            },
        };

        if (lid || chatId.endsWith('@lid')) {
            message.isLidSender = true;

            if (state.config.resolveLid) {
                message.senderPhone = input.senderPhone ?? '4915112345678';
            }
        } else if (input.senderPhone) {
            message.senderPhone = input.senderPhone;
        }

        if (input.media) {
            const bytes = input.media.dataBase64
                ? Buffer.from(input.media.dataBase64, 'base64')
                : input.media.sizeBytes
                  ? null
                  : samplePng(input.media.size ?? 64);
            const sizeBytes =
                bytes === null ? input.media.sizeBytes : bytes.length;
            const mimetype = input.media.mimetype ?? 'image/png';
            const filename =
                input.media.filename ??
                (mimetype === 'image/png' ? 'photo.png' : undefined);
            const omitted =
                input.media.omitted === true ||
                sizeBytes > state.config.mediaInlineMaxBytes;

            message.media = omitted
                ? {
                      mimetype,
                      ...(filename ? { filename } : {}),
                      omitted: true,
                      sizeBytes,
                  }
                : {
                      mimetype,
                      ...(filename ? { filename } : {}),
                      data: bytes.toString('base64'),
                  };

            if (bytes !== null && input.media.stored !== false) {
                session.media.set(`${chatId}|${id}`, { bytes, mimetype });
            }
        }

        session.messages.push(message);

        return message;
    }

    function ackPayload(messageId, status) {
        const ack =
            { pending: 0, sent: 1, delivered: 2, read: 3, failed: -1 }[
                status
            ] ?? 1;

        return { id: messageId, messageId, status, ack };
    }

    function fireAck(session, messageId, status) {
        const canonical = status === 'played' ? 'read' : status;

        emit(session, 'message.ack', ackPayload(messageId, canonical));

        if (canonical === 'failed') {
            emit(session, 'message.failed', ackPayload(messageId, 'failed'));
        }
    }

    function scheduleAcks(session, messageId) {
        const { mode, steps, delayMs } = session.acks ?? state.config.acks;

        if (mode !== 'auto') {
            return;
        }

        const world = state;

        steps.forEach((status, index) => {
            const timer = setTimeout(
                () => {
                    world.timers.delete(timer);

                    if (world === state) {
                        fireAck(session, messageId, status);
                    }
                },
                delayMs * (index + 1),
            );

            timer.unref?.();
            state.timers.add(timer);
        });
    }

    // ----------------------------------------------------------------------------------------------------------- API routes

    /** Resolves the key of the request: returns {key} or a Reply (401). */
    function authenticate(headers) {
        const bearer = /^Bearer\s+(.+)$/i.exec(headers.authorization ?? '');
        const presented = headers['x-api-key'] ?? bearer?.[1];

        if (!presented) {
            return fail(401, 'API key is required');
        }

        const key = state.keys.get(presented);

        return key ? { key } : fail(401, 'Invalid API key');
    }

    const requireRole = (key, role) =>
        ROLE_RANK[key.role] >= ROLE_RANK[role]
            ? null
            : fail(403, `Insufficient permissions. Required: ${role}`);

    function scopeCheck(key, sessionId) {
        if (
            key.allowedSessions !== null &&
            key.allowedSessions !== undefined &&
            key.allowedSessions.length > 0 &&
            !key.allowedSessions.includes(sessionId)
        ) {
            return fail(401, 'API key not authorized for this session');
        }

        return null;
    }

    function sessionFor(id, key, role) {
        const scoped = scopeCheck(key, id);

        if (scoped) {
            return { problem: scoped };
        }

        const denied = requireRole(key, role);

        if (denied) {
            return { problem: denied };
        }

        const session = state.sessions.get(id);

        return session
            ? { session }
            : { problem: fail(404, `Session with id '${id}' not found`) };
    }

    const uuidProblem = (id) =>
        UUID_PATTERN.test(id)
            ? null
            : fail(400, 'Validation failed (uuid is expected)');

    function checkBody(body, allowed) {
        const messages = [];

        if (body !== null && typeof body === 'object') {
            for (const name of Object.keys(body)) {
                if (!allowed.includes(name)) {
                    messages.push(`property ${name} should not exist`);
                }
            }
        }

        return messages;
    }

    function createSessionRoute(key, body) {
        const denied = requireRole(key, 'operator');

        if (denied) {
            return denied;
        }

        if (key.allowedSessions && key.allowedSessions.length > 0) {
            return fail(
                403,
                'Session-scoped API keys are not permitted on this route',
            );
        }

        const problems = checkBody(body, [
            'name',
            'config',
            'proxyUrl',
            'proxyType',
        ]);
        const name = body?.name;
        const isText = typeof name === 'string';

        // class-validator lists the failed constraints in this order (the recorded `strict-sessions-create-missing-name`).
        if (!isText || !/^[a-zA-Z0-9-]+$/.test(name)) {
            problems.push(
                'Session name can only contain letters, numbers, and hyphens',
            );
        }

        if (!isText || name.length > 50) {
            problems.push(
                'name must be shorter than or equal to 50 characters',
            );
        }

        if (!isText || name.length < 3) {
            problems.push('name must be longer than or equal to 3 characters');
        }

        if (!isText) {
            problems.push('name must be a string');
        }

        if (problems.length > 0) {
            return validation(...problems);
        }

        const reservedUntil = state.reservedNames.get(name);

        if (reservedUntil !== undefined && reservedUntil > Date.now()) {
            return fail(
                409,
                `Session '${name}' is still being torn down, retry shortly`,
                { code: 'SESSION_NAME_TEARDOWN_PENDING' },
            );
        }

        if (
            [...state.sessions.values()].some(
                (session) => session.name === name,
            )
        ) {
            return fail(409, `Session with name '${name}' already exists`);
        }

        return reply(201, dto(createSession(name)));
    }

    async function startRoute(key, id) {
        const bad = uuidProblem(id);

        if (bad) {
            return bad;
        }

        const { session, problem } = sessionFor(id, key, 'operator');

        if (problem) {
            return problem;
        }

        if (session.engineLoaded) {
            return fail(400, 'Session is already started');
        }

        const before = session.status;

        session.engineLoaded = true;
        session.status = 'initializing';
        session.lastError = null;
        touch(session);
        emit(session, 'session.status', {
            sessionId: session.id,
            status: 'initializing',
        });

        if (state.config.startDelayMs > 0) {
            await sleep(state.config.startDelayMs);
        }

        if (!state.sessions.has(session.id) || !session.engineLoaded) {
            return fail(409, 'The session was stopped while it was starting');
        }

        if (session.paired) {
            session.status = 'ready';
            session.connectedAt = secondIso();
            session.lastActive = secondIso();
            touch(session);
            emit(session, 'session.status', {
                sessionId: session.id,
                status: 'authenticating',
            });
            emit(session, 'session.status', {
                sessionId: session.id,
                status: 'ready',
            });
            emit(session, 'session.authenticated', {
                sessionId: session.id,
                phone: session.phone,
                pushName: session.pushName,
            });
        } else {
            session.status = 'qr_ready';
            session.qr = fakeQrDataUrl(`${session.id}:${Date.now()}`);
            touch(session);
            emit(session, 'session.status', {
                sessionId: session.id,
                status: 'qr_ready',
            });
            emit(session, 'session.qr', {
                sessionId: session.id,
                qr: session.qr,
            });
        }

        void before;

        return reply(200, dto(session));
    }

    function stopRoute(key, id) {
        const bad = uuidProblem(id);

        if (bad) {
            return bad;
        }

        const { session, problem } = sessionFor(id, key, 'operator');

        if (problem) {
            return problem;
        }

        session.engineLoaded = false;
        session.status = 'disconnected';
        session.qr = null;
        touch(session);
        // The real image sends session.status for an API stop, but NOT session.disconnected.
        emit(session, 'session.status', {
            sessionId: session.id,
            status: 'disconnected',
        });

        return reply(200, dto(session));
    }

    function deleteRoute(key, id) {
        const { session, problem } = sessionFor(id, key, 'operator');

        if (problem) {
            return problem;
        }

        state.sessions.delete(session.id);

        for (const hook of state.webhooks.values()) {
            if (hook.sessionId === session.id) {
                state.webhooks.delete(hook.id);
            }
        }

        if (session.paired && state.config.teardownPendingMs > 0) {
            state.reservedNames.set(
                session.name,
                Date.now() + state.config.teardownPendingMs,
            );
        }

        return reply(204, null);
    }

    function qrRoute(key, id) {
        const bad = uuidProblem(id);

        if (bad) {
            return bad;
        }

        const { session, problem } = sessionFor(id, key, 'operator');

        if (problem) {
            return problem;
        }

        if (!session.engineLoaded) {
            return fail(
                400,
                'Session is not started. Call POST /sessions/:sessionId/start first.',
            );
        }

        if (session.status === 'qr_ready' && session.qr) {
            return reply(200, { qrCode: session.qr, status: 'qr_ready' });
        }

        if (session.status === 'ready') {
            // Unverified wording (a paired session cannot be recorded without a phone).
            return fail(400, 'Session is already authenticated');
        }

        return fail(400, 'QR code is not ready yet. Please wait...');
    }

    // Webhook routes ----------------------------------------------------------------------------------------------------

    const hookDto = (hook) => ({
        id: hook.id,
        sessionId: hook.sessionId,
        url: hook.url,
        events: hook.events,
        filters: hook.filters,
        active: hook.active,
        retryCount: hook.retryCount,
        lastTriggeredAt: hook.lastTriggeredAt,
        createdAt: hook.createdAt,
        updatedAt: hook.updatedAt,
    });

    function validateHookBody(body, { creating }) {
        const problems = checkBody(
            body,
            creating
                ? [
                      'url',
                      'events',
                      'secret',
                      'headers',
                      'filters',
                      'retryCount',
                  ]
                : [
                      'url',
                      'events',
                      'secret',
                      'headers',
                      'filters',
                      'active',
                      'retryCount',
                  ],
        );
        let url = null;

        if (creating || body?.url !== undefined) {
            try {
                url = new URL(String(body?.url));

                if (!['http:', 'https:'].includes(url.protocol)) {
                    throw new Error('protocol');
                }
            } catch {
                problems.push('url must be a URL address');
            }
        }

        if (body?.events !== undefined) {
            if (!Array.isArray(body.events) || body.events.length < 1) {
                problems.push('events must contain at least 1 elements');
            } else if (
                body.events.some((event) => !WEBHOOK_EVENTS.includes(event))
            ) {
                problems.push(
                    `each value in events must be one of the following values: ${WEBHOOK_EVENTS.join(', ')}`,
                );
            }
        }

        if (body?.secret !== undefined && body.secret !== '') {
            if (typeof body.secret !== 'string') {
                problems.push('secret must be a string');
            } else if (body.secret.length < 16) {
                problems.push(
                    'secret must be longer than or equal to 16 characters',
                );
            }
        }

        if (
            body?.retryCount !== undefined &&
            (!Number.isInteger(body.retryCount) ||
                body.retryCount < 0 ||
                body.retryCount > 5)
        ) {
            problems.push('retryCount must not be greater than 5');
        }

        return { problems, url };
    }

    function urlProblem(url) {
        if (url.username || url.password) {
            return fail(
                400,
                'Webhook URL must not contain credentials (userinfo)',
            );
        }

        return ssrfAllows(url)
            ? null
            : fail(400, 'Destination address is not allowed');
    }

    function createHookRoute(key, sessionId, body) {
        const scoped = scopeCheck(key, sessionId);

        if (scoped) {
            return scoped;
        }

        const denied = requireRole(key, 'operator');

        if (denied) {
            return denied;
        }

        const { problems, url } = validateHookBody(body, { creating: true });

        if (problems.length > 0) {
            return validation(...problems);
        }

        const session = state.sessions.get(sessionId);

        if (!session) {
            return fail(404, `Session with id '${sessionId}' not found`);
        }

        const blocked = urlProblem(url);

        if (blocked) {
            return blocked;
        }

        if (
            [...state.webhooks.values()].filter(
                (hook) => hook.sessionId === sessionId,
            ).length >= MAX_WEBHOOKS_PER_SESSION
        ) {
            return fail(
                400,
                `Webhook limit reached for this session (${MAX_WEBHOOKS_PER_SESSION}/${MAX_WEBHOOKS_PER_SESSION}); delete one before registering another`,
            );
        }

        const stamp = secondIso();
        const hook = {
            id: randomUUID(),
            sessionId,
            url: body.url,
            events: body.events ?? ['message.received'],
            secret: body.secret || null,
            headers: body.headers ?? {},
            filters: body.filters ?? null,
            active: true,
            retryCount: body.retryCount ?? 3,
            lastTriggeredAt: null,
            createdAt: stamp,
            updatedAt: stamp,
        };

        state.webhooks.set(hook.id, hook);

        return reply(201, hookDto(hook));
    }

    function hookFor(key, sessionId, id) {
        const scoped = scopeCheck(key, sessionId);

        if (scoped) {
            return { problem: scoped };
        }

        const denied = requireRole(key, 'operator');

        if (denied) {
            return { problem: denied };
        }

        const hook = state.webhooks.get(id);

        return hook && hook.sessionId === sessionId
            ? { hook }
            : { problem: fail(404, `Webhook with id '${id}' not found`) };
    }

    async function testHookRoute(key, sessionId, id) {
        const { hook, problem } = hookFor(key, sessionId, id);

        if (problem) {
            return problem;
        }

        const deliveryId = `dlv_${randomUUID()}`;
        const payload = {
            event: 'test',
            timestamp: nowIso(),
            sessionId,
            // The real image: `evt_test_<12 hex>` (the reference says test_<deliveryId>_<webhookId>), data {message, webhookId, url}.
            idempotencyKey: `evt_test_${randomBytes(6).toString('hex')}`,
            deliveryId,
            data: {
                message: 'This is a test webhook from OpenWA',
                webhookId: hook.id,
                url: hook.url,
            },
        };
        const rawBody = JSON.stringify(payload);
        const headers = buildHeaders(hook, payload, rawBody, 0);
        const result = await post(hook.url, headers, rawBody);

        logAttempt({
            event: 'test',
            sessionId,
            webhookId: hook.id,
            url: hook.url,
            deliveryId,
            idempotencyKey: payload.idempotencyKey,
            retryCount: 0,
            status: result.status,
            error: result.error,
            outcome: result.error === null ? 'delivered' : 'failed',
            headers,
            rawBody,
        });

        return reply(
            200,
            result.status === null
                ? { success: false, error: result.error }
                : {
                      success: result.status >= 200 && result.status < 300,
                      statusCode: result.status,
                  },
        );
    }

    // Messages ------------------------------------------------------------------------------------------------------------

    function sendTextRoute(key, id, body) {
        const scoped = scopeCheck(key, id);

        if (scoped) {
            return scoped;
        }

        const denied = requireRole(key, 'operator');

        if (denied) {
            return denied;
        }

        const problems = checkBody(body, [
            'chatId',
            'text',
            'mentions',
            'linkPreview',
            'customLinkPreview',
            'quotedMessageId',
        ]);

        if (typeof body?.chatId !== 'string' || body.chatId === '') {
            problems.unshift('chatId should not be empty');
        }

        if (typeof body?.text !== 'string' || body.text === '') {
            problems.push('text should not be empty');
        } else if (body.text.length > 4096) {
            problems.push(
                'text must be shorter than or equal to 4096 characters',
            );
        }

        if (problems.length > 0) {
            return validation(...problems);
        }

        const session = state.sessions.get(id);

        if (!session || !session.engineLoaded) {
            return fail(
                400,
                `Session '${id}' is not active. Start the session first.`,
            );
        }

        if (session.status !== 'ready') {
            // The engine exists but WhatsApp is not connected yet (waiting for a scan, starting, reconnecting): retryable.
            return fail(
                409,
                'Session is not connected. The WhatsApp client is not ready.',
            );
        }

        const pacing = state.config.pacing;
        const sentToday = session.sendLog.length;
        const lastSendAt = session.sendLog.at(-1) ?? 0;
        const knownChat = session.messages.some(
            (message) => message.chatId === body.chatId,
        );

        if (pacing.dailyCap > 0 && sentToday >= pacing.dailyCap) {
            return fail(
                429,
                `Daily allowance of ${pacing.dailyCap} message(s) reached for a session 0 day(s) old`,
                { code: 'SEND_PACING_LIMITED', retryAfterSeconds: 34521 },
            );
        }

        if (
            pacing.coldDailyCap > 0 &&
            !knownChat &&
            (session.coldToday ?? 0) >= pacing.coldDailyCap
        ) {
            return fail(
                429,
                `Daily allowance of ${pacing.coldDailyCap} new conversation(s) reached for a session 0 day(s) old`,
                { code: 'SEND_PACING_LIMITED', retryAfterSeconds: 34521 },
            );
        }

        if (
            pacing.minIntervalMs > 0 &&
            Date.now() - lastSendAt < pacing.minIntervalMs
        ) {
            return fail(429, 'Sending too fast for this session', {
                code: 'SEND_PACING_LIMITED',
                retryAfterSeconds: Math.ceil(
                    (pacing.minIntervalMs - (Date.now() - lastSendAt)) / 1000,
                ),
            });
        }

        const messageId = waId(true, body.chatId);
        const timestamp = epochSeconds();

        session.sendLog.push(Date.now());
        if (!knownChat) {
            session.coldToday = (session.coldToday ?? 0) + 1;
        }

        session.messages.push({
            id: messageId,
            from: `${session.phone ?? '4915100000000'}@c.us`,
            to: body.chatId,
            chatId: body.chatId,
            body: body.text,
            type: 'text',
            timestamp,
            fromMe: true,
            isGroup: body.chatId.endsWith('@g.us'),
            kind: body.chatId.endsWith('@g.us') ? 'group' : 'individual',
        });

        // 201 means accepted: the echo and the acks follow on their own.
        const world = state;
        const timer = setTimeout(() => {
            world.timers.delete(timer);

            if (world !== state) {
                return;
            }

            if (state.config.sentEcho) {
                emit(
                    session,
                    'message.sent',
                    session.messages.find(
                        (message) => message.id === messageId,
                    ),
                );
            }

            scheduleAcks(session, messageId);
        }, 10);

        timer.unref?.();
        state.timers.add(timer);

        return reply(201, { messageId, timestamp });
    }

    function mediaRoute(key, id, chatId, messageId) {
        const scoped = scopeCheck(key, id);

        if (scoped) {
            return scoped;
        }

        const session = state.sessions.get(id);

        if (!session) {
            return fail(404, `Session with id '${id}' not found`);
        }

        const stored = session.media.get(
            `${decodeURIComponent(chatId)}|${decodeURIComponent(messageId)}`,
        );

        if (!stored) {
            return fail(404, 'No media stored for this message');
        }

        return reply(200, stored.bytes, {
            'Content-Type': stored.mimetype,
            'Content-Disposition': 'attachment',
            'X-Content-Type-Options': 'nosniff',
        });
    }

    // Dispatcher ----------------------------------------------------------------------------------------------------------

    async function api(method, path, query, headers, body, malformed) {
        if (
            method === 'GET' &&
            (path === '/api/health' ||
                path === '/api/health/live' ||
                path === '/api/health/ready')
        ) {
            if (path === '/api/health/live') {
                return reply(200, { status: 'ok' });
            }

            if (path === '/api/health/ready') {
                return reply(200, {
                    status: 'ok',
                    details: {
                        mainDatabase: { status: 'up' },
                        dataDatabase: { status: 'up' },
                    },
                });
            }

            const keyed =
                headers['x-api-key'] && state.keys.has(headers['x-api-key']);

            return reply(200, {
                status: 'ok',
                timestamp: nowIso(),
                ...(keyed ? { version: MOCK_VERSION } : {}),
            });
        }

        const segments = path.replace(/^\/api\//, '').split('/');
        const known =
            (segments[0] === 'sessions' && segments.length <= 7) ||
            (segments[0] === 'auth' && segments[1] === 'validate') ||
            segments[0] === 'webhooks' ||
            (segments[0] === 'infra' && segments[1] === 'engines');

        if (!known || malformed) {
            return fail(404, `Cannot ${method} ${path}`);
        }

        const auth = authenticate(headers);

        if (auth instanceof Reply) {
            return auth;
        }

        const key = auth.key;

        if (state.throttleNext > 0) {
            state.throttleNext -= 1;

            return reply(
                429,
                {
                    statusCode: 429,
                    message: 'ThrottlerException: Too Many Requests',
                },
                { 'Retry-After': '1', 'Retry-After-short': '1' },
            );
        }

        if (method === 'POST' && path === '/api/auth/validate') {
            return reply(200, {
                valid: true,
                role: key.role,
                engineType: 'whatsapp-web.js',
            });
        }

        if (method === 'GET' && path === '/api/infra/engines/current') {
            return key.role === 'admin'
                ? reply(200, { engineType: 'whatsapp-web.js' })
                : fail(403, 'Insufficient permissions. Required: admin');
        }

        if (method === 'GET' && path === '/api/webhooks') {
            const denied = requireRole(key, 'operator');

            return (
                denied ??
                reply(
                    200,
                    [...state.webhooks.values()]
                        .filter(
                            (hook) =>
                                !key.allowedSessions?.length ||
                                key.allowedSessions.includes(hook.sessionId),
                        )
                        .reverse()
                        .map(hookDto),
                )
            );
        }

        if (method === 'GET' && path === '/api/webhooks/delivery-failures') {
            return requireRole(key, 'admin') ?? reply(200, state.failures);
        }

        if (segments[0] !== 'sessions') {
            return fail(404, `Cannot ${method} ${path}`);
        }

        if (segments.length === 1) {
            if (method === 'POST') {
                return createSessionRoute(key, body);
            }

            if (method === 'GET') {
                const name = query.get('name');

                if (
                    query.has('name') &&
                    (name === '' || query.getAll('name').length > 1)
                ) {
                    return validation('name must not be empty');
                }

                const list = [...state.sessions.values()]
                    .filter(
                        (session) =>
                            !key.allowedSessions?.length ||
                            key.allowedSessions.includes(session.id),
                    )
                    .filter((session) => name === null || session.name === name)
                    .reverse();

                return reply(200, list.map(dto));
            }
        }

        const id = segments[1];
        const rest = segments.slice(2).join('/');

        if (rest === '') {
            if (method === 'GET') {
                const bad = uuidProblem(id);

                if (bad) {
                    return bad;
                }

                const { session, problem } = sessionFor(id, key, 'viewer');

                return problem ?? reply(200, dto(session));
            }

            if (method === 'DELETE') {
                return deleteRoute(key, id);
            }
        }

        if (method === 'POST' && rest === 'start') {
            return startRoute(key, id);
        }

        if (method === 'POST' && rest === 'stop') {
            return stopRoute(key, id);
        }

        if (method === 'GET' && rest === 'qr') {
            return qrRoute(key, id);
        }

        if (rest === 'webhooks') {
            if (method === 'POST') {
                return createHookRoute(key, id, body);
            }

            if (method === 'GET') {
                const scoped = scopeCheck(key, id);
                const denied = scoped ?? requireRole(key, 'operator');

                if (denied) {
                    return denied;
                }

                return state.sessions.has(id)
                    ? reply(
                          200,
                          [...state.webhooks.values()]
                              .filter((hook) => hook.sessionId === id)
                              .reverse()
                              .map(hookDto),
                      )
                    : fail(404, `Session with id '${id}' not found`);
            }
        }

        const hookMatch = /^webhooks\/([^/]+)(?:\/(test))?$/.exec(rest);

        if (hookMatch) {
            const [, hookId, test] = hookMatch;

            if (test === 'test' && method === 'POST') {
                return testHookRoute(key, id, hookId);
            }

            const { hook, problem } = hookFor(key, id, hookId);

            if (problem) {
                return problem;
            }

            if (method === 'GET') {
                return reply(200, hookDto(hook));
            }

            if (method === 'DELETE') {
                state.webhooks.delete(hook.id);

                return reply(204, null);
            }

            if (method === 'PUT') {
                const { problems, url } = validateHookBody(body, {
                    creating: false,
                });

                if (problems.length > 0) {
                    return validation(...problems);
                }

                if (url !== null && body.url !== hook.url) {
                    const blocked = urlProblem(url);

                    if (blocked) {
                        return blocked;
                    }
                }

                for (const field of [
                    'url',
                    'events',
                    'headers',
                    'filters',
                    'active',
                    'retryCount',
                ]) {
                    if (body[field] !== undefined) {
                        hook[field] = body[field];
                    }
                }

                if (body.secret !== undefined) {
                    hook.secret = body.secret === '' ? null : body.secret;
                }

                hook.updatedAt = secondIso();

                return reply(200, hookDto(hook));
            }
        }

        if (method === 'POST' && rest === 'messages/send-text') {
            return sendTextRoute(key, id, body);
        }

        const mediaMatch = /^messages\/([^/]+)\/([^/]+)\/media$/.exec(rest);

        if (method === 'GET' && mediaMatch) {
            return mediaRoute(key, id, mediaMatch[1], mediaMatch[2]);
        }

        return fail(404, `Cannot ${method} ${path}`);
    }

    // ---------------------------------------------------------------------------------------------------------- control API

    async function control(method, path, query, body) {
        const json = (value, status = 200) => reply(status, value);
        const need = (ref) => findSession(ref);
        const sessionRef =
            /^\/__mock\/sessions\/([^/]+)\/(status|qr|inbound|ack|acks)$/.exec(
                path,
            );

        if (method === 'GET' && path === '/__mock/health') {
            return json({
                ok: true,
                name: 'openwa-mock',
                version: MOCK_VERSION,
            });
        }

        if (method === 'POST' && path === '/__mock/reset') {
            for (const timer of state.timers) {
                clearTimeout(timer);
            }

            resetState();

            return json({ ok: true });
        }

        if (method === 'GET' && path === '/__mock/state') {
            return json({
                config: state.config,
                sessions: [...state.sessions.values()].map((session) => ({
                    ...dto(session),
                    paired: session.paired,
                    hasQr: session.qr !== null,
                    messages: session.messages.length,
                })),
                webhooks: [...state.webhooks.values()].map((hook) => ({
                    ...hookDto(hook),
                    hasSecret: hook.secret !== null,
                })),
                keys: [...state.keys.values()].map((entry) => ({
                    id: entry.id,
                    role: entry.role,
                    allowedSessions: entry.allowedSessions,
                })),
            });
        }

        if (method === 'GET' && path === '/__mock/requests') {
            const since = Number(query.get('since') ?? 0);

            return json(
                state.requests.filter(
                    (entry) =>
                        entry.n > since &&
                        (query.get('method') === null ||
                            entry.method ===
                                query.get('method').toUpperCase()) &&
                        (query.get('path') === null ||
                            entry.path.includes(query.get('path'))),
                ),
            );
        }

        if (method === 'DELETE' && path === '/__mock/requests') {
            state.requests.length = 0;

            return json({ ok: true });
        }

        if (method === 'GET' && path === '/__mock/deliveries') {
            const since = Number(query.get('since') ?? 0);

            return json(
                state.deliveries.filter(
                    (entry) =>
                        entry.n > since &&
                        (query.get('event') === null ||
                            entry.event === query.get('event')) &&
                        (query.get('key') === null ||
                            String(entry.idempotencyKey).includes(
                                query.get('key'),
                            )),
                ),
            );
        }

        if (method === 'POST' && path === '/__mock/config') {
            const patch = body ?? {};

            for (const [name, value] of Object.entries(patch)) {
                if (
                    value !== null &&
                    typeof value === 'object' &&
                    !Array.isArray(value) &&
                    typeof state.config[name] === 'object'
                ) {
                    state.config[name] = { ...state.config[name], ...value };
                } else {
                    state.config[name] = value;
                }
            }

            return json(state.config);
        }

        if (method === 'POST' && path === '/__mock/script') {
            state.scripts.push({
                method: body?.method?.toUpperCase() ?? null,
                path: body?.path ?? null,
                status: body?.status ?? 500,
                body: body?.body ?? {
                    message: 'Scripted failure',
                    error: REASONS[body?.status ?? 500],
                    statusCode: body?.status ?? 500,
                },
                headers: body?.headers ?? {},
                times: body?.times ?? 1,
            });

            return json({ ok: true, pending: state.scripts.length });
        }

        if (method === 'POST' && path === '/__mock/throttle') {
            state.throttleNext = Number(body?.next ?? 1);

            return json({ ok: true, next: state.throttleNext });
        }

        if (method === 'POST' && path === '/__mock/keys') {
            const role = body?.role ?? 'operator';
            const created = `owa_k1_e2e-mock-${role}-${randomBytes(6).toString('hex')}`;
            const entry = {
                id: randomUUID(),
                role,
                allowedSessions: body?.allowedSessions ?? null,
            };

            state.keys.set(created, entry);

            return json(
                {
                    key: created,
                    id: entry.id,
                    role,
                    allowedSessions: entry.allowedSessions,
                },
                201,
            );
        }

        if (method === 'POST' && path === '/__mock/sessions') {
            if (
                typeof body?.name !== 'string' ||
                [...state.sessions.values()].some(
                    (session) => session.name === body.name,
                )
            ) {
                return fail(
                    409,
                    'A session with that name exists (or no name was given)',
                );
            }

            const ready = body.status === 'ready';
            const session = createSession(body.name, {
                status: body.status ?? 'created',
                engineLoaded: [
                    'initializing',
                    'qr_ready',
                    'authenticating',
                    'ready',
                ].includes(body.status ?? 'created'),
                paired: ready || body.paired === true,
                phone:
                    ready || body.phone
                        ? (body.phone ?? '4915100000000')
                        : null,
                pushName:
                    ready || body.pushName
                        ? (body.pushName ?? 'Mock Phone')
                        : null,
                connectedAt: ready ? secondIso() : null,
                qr:
                    body.status === 'qr_ready'
                        ? fakeQrDataUrl(randomUUID())
                        : null,
            });

            return json({ ...dto(session), paired: session.paired }, 201);
        }

        if (sessionRef) {
            const [, ref, action] = sessionRef;
            const session = need(decodeURIComponent(ref));

            if (!session) {
                return fail(404, `No mock session "${ref}"`);
            }

            if (action === 'status') {
                const status = String(body?.status ?? '');

                if (
                    ![
                        'created',
                        'initializing',
                        'qr_ready',
                        'authenticating',
                        'ready',
                        'disconnected',
                        'action_required',
                        'failed',
                    ].includes(status)
                ) {
                    return fail(400, `Unknown status "${status}"`);
                }

                session.status = status;
                session.engineLoaded = [
                    'initializing',
                    'qr_ready',
                    'authenticating',
                    'ready',
                ].includes(status);
                session.lastError = ['failed', 'action_required'].includes(
                    status,
                )
                    ? (body?.reason ?? 'Mock failure')
                    : null;
                touch(session);

                if (status === 'ready') {
                    session.paired = true;
                    session.phone =
                        body?.phone ?? session.phone ?? '4915100000000';
                    session.pushName =
                        body?.pushName ?? session.pushName ?? 'Mock Phone';
                    session.connectedAt = secondIso();
                    session.qr = null;
                }

                if (status === 'qr_ready') {
                    session.qr = fakeQrDataUrl(`${session.id}:${Date.now()}`);
                }

                emit(session, 'session.status', {
                    sessionId: session.id,
                    status,
                });

                if (status === 'qr_ready') {
                    emit(session, 'session.qr', {
                        sessionId: session.id,
                        qr: session.qr,
                    });
                }

                if (status === 'ready') {
                    emit(session, 'session.authenticated', {
                        sessionId: session.id,
                        phone: session.phone,
                        pushName: session.pushName,
                    });
                }

                if (status === 'disconnected') {
                    session.qr = null;
                    emit(session, 'session.disconnected', {
                        sessionId: session.id,
                        reason: body?.reason ?? 'LOGOUT',
                    });
                }

                return json(dto(session));
            }

            if (action === 'qr') {
                session.status = 'qr_ready';
                session.engineLoaded = true;
                session.qr = fakeQrDataUrl(
                    `${session.id}:${randomBytes(4).toString('hex')}`,
                );
                touch(session);
                emit(session, 'session.qr', {
                    sessionId: session.id,
                    qr: session.qr,
                });

                return json(dto(session));
            }

            if (action === 'inbound') {
                const message = inboundMessage(session, body ?? {});

                emit(session, body?.event ?? 'message.received', message);

                return json(
                    { messageId: message.id, chatId: message.chatId, message },
                    201,
                );
            }

            if (action === 'acks') {
                // A plan of its own for THIS session (specs that share one mock must not fight over the global `config.acks`).
                session.acks = {
                    ...state.config.acks,
                    ...(body?.mode === undefined ? {} : { mode: body.mode }),
                    ...(Array.isArray(body?.steps)
                        ? { steps: body.steps }
                        : {}),
                    ...(body?.delayMs === undefined
                        ? {}
                        : { delayMs: Number(body.delayMs) }),
                };

                return json({ ok: true, acks: session.acks });
            }

            if (action === 'ack') {
                const messageId = String(body?.messageId ?? '');
                const status = String(body?.status ?? 'delivered');

                if (
                    ![
                        'pending',
                        'sent',
                        'delivered',
                        'read',
                        'played',
                        'failed',
                    ].includes(status)
                ) {
                    return fail(400, `Unknown ack status "${status}"`);
                }

                fireAck(session, messageId, status);

                return json({
                    ok: true,
                    ack: ackPayload(
                        messageId,
                        status === 'played' ? 'read' : status,
                    ),
                });
            }
        }

        if (method === 'POST' && path === '/__mock/replay') {
            const original = state.deliveries.find(
                (entry) => entry.n === Number(body?.delivery),
            );

            if (!original) {
                return fail(404, `No delivery #${body?.delivery}`);
            }

            const hook = state.webhooks.get(original.webhookId);
            const payload = JSON.parse(original.rawBody);
            let rawBody = original.rawBody;
            let headers = {
                ...original.headers,
                'X-OpenWA-Retry-Count': String(Number(original.retryCount) + 1),
            };

            if (body?.sameBody !== true) {
                // A replay (outbox sweep, redrive) keeps the idempotency key but is a new delivery: new id, new bytes, new signature.
                payload.deliveryId = `dlv_${randomUUID()}`;
                payload.timestamp = nowIso();
                rawBody = JSON.stringify(payload);
                headers = hook
                    ? buildHeaders(hook, payload, rawBody, 0)
                    : {
                          ...headers,
                          'X-OpenWA-Delivery-Id': payload.deliveryId,
                      };
            }

            const result = await post(original.url, headers, rawBody);
            const logged = logAttempt({
                event: original.event,
                sessionId: original.sessionId,
                webhookId: original.webhookId,
                url: original.url,
                deliveryId: payload.deliveryId,
                idempotencyKey: payload.idempotencyKey,
                retryCount:
                    body?.sameBody === true
                        ? Number(original.retryCount) + 1
                        : 0,
                status: result.status,
                error: result.error,
                outcome: result.error === null ? 'delivered' : 'failed',
                headers,
                rawBody,
            });

            return json({
                n: logged.n,
                status: result.status,
                error: result.error,
            });
        }

        if (method === 'POST' && path === '/__mock/deliver') {
            const session = body?.session ? need(String(body.session)) : null;
            const targets = body?.url
                ? [
                      {
                          url: String(body.url),
                          secret: body.secret ?? null,
                          id: 'adhoc',
                          sessionId: session?.id ?? 'adhoc',
                      },
                  ]
                : [...state.webhooks.values()].filter(
                      (hook) =>
                          (session === null || hook.sessionId === session.id) &&
                          (hook.events.includes(body?.event) ||
                              hook.events.includes('*')),
                  );
            const results = [];

            for (const hook of targets) {
                const sid = session?.id ?? hook.sessionId;
                const payload = {
                    event: String(body?.event ?? 'message.received'),
                    timestamp: nowIso(),
                    sessionId: sid,
                    idempotencyKey:
                        body?.idempotencyKey ??
                        `evt_${randomUUID()}_${hook.id}`,
                    deliveryId: body?.deliveryId ?? `dlv_${randomUUID()}`,
                    data: body?.data ?? {},
                };
                const rawBody = JSON.stringify(payload);
                const mode = body?.signature ?? 'valid';
                const headers = buildHeaders(
                    { secret: null },
                    payload,
                    rawBody,
                    Number(body?.retryCount ?? 0),
                );
                const secret = hook.secret ?? body?.secret ?? null;

                if (mode === 'valid' && secret) {
                    headers['X-OpenWA-Signature'] = sign(secret, rawBody);
                } else if (mode === 'wrong-secret') {
                    headers['X-OpenWA-Signature'] = sign(
                        'a-different-secret-entirely-0123456789',
                        rawBody,
                    );
                } else if (mode === 'bad') {
                    headers['X-OpenWA-Signature'] = `sha256=${'0'.repeat(64)}`;
                } else if (mode === 'tampered' && secret) {
                    // signed over different bytes than the ones sent
                    headers['X-OpenWA-Signature'] = sign(secret, `${rawBody} `);
                }

                const result = await post(hook.url, headers, rawBody);
                const logged = logAttempt({
                    event: payload.event,
                    sessionId: sid,
                    webhookId: hook.id,
                    url: hook.url,
                    deliveryId: payload.deliveryId,
                    idempotencyKey: payload.idempotencyKey,
                    retryCount: Number(body?.retryCount ?? 0),
                    status: result.status,
                    error: result.error,
                    outcome: result.error === null ? 'delivered' : 'failed',
                    headers,
                    rawBody,
                });

                results.push({
                    n: logged.n,
                    webhookId: hook.id,
                    status: result.status,
                    error: result.error,
                });
            }

            return json({ results });
        }

        return fail(404, `Unknown control route ${method} ${path}`);
    }

    // ------------------------------------------------------------------------------------------------------------ server

    function scriptFor(method, path) {
        const index = state.scripts.findIndex(
            (script) =>
                (script.method === null || script.method === method) &&
                (script.path === null || path.includes(script.path)),
        );

        if (index < 0) {
            return null;
        }

        const script = state.scripts[index];

        script.times -= 1;

        if (script.times <= 0) {
            state.scripts.splice(index, 1);
        }

        return reply(script.status, script.body, script.headers);
    }

    const server = createServer((request, response) => {
        const chunks = [];

        request.on('data', (chunk) => chunks.push(chunk));
        request.on('end', async () => {
            const url = new URL(request.url ?? '/', 'http://mock');
            const method = request.method ?? 'GET';
            const path = url.pathname;
            const text = Buffer.concat(chunks).toString('utf8');
            let body;
            let malformed = false;

            if (text !== '') {
                if (
                    (request.headers['content-type'] ?? '').includes(
                        'application/json',
                    )
                ) {
                    try {
                        body = JSON.parse(text);
                    } catch {
                        malformed = true;
                    }
                } else {
                    body = {};
                }
            }

            let result;
            let logged = null;

            try {
                if (path.startsWith('/__mock/')) {
                    result = await control(
                        method,
                        path,
                        url.searchParams,
                        body,
                    );
                } else if (path.startsWith('/api/')) {
                    logged = {
                        n: (state.counters.request += 1),
                        at: nowIso(),
                        method,
                        path,
                        query: Object.fromEntries(url.searchParams),
                        auth: request.headers['x-api-key']
                            ? 'x-api-key'
                            : request.headers.authorization
                              ? 'bearer'
                              : 'none',
                        apiKey:
                            request.headers['x-api-key'] ??
                            request.headers.authorization?.replace(
                                /^Bearer\s+/i,
                                '',
                            ) ??
                            null,
                        body: body ?? null,
                        status: 0,
                    };
                    state.requests.push(logged);
                    result =
                        scriptFor(method, path) ??
                        (await api(
                            method,
                            path,
                            url.searchParams,
                            request.headers,
                            body,
                            malformed,
                        ));
                } else {
                    result = fail(404, `Cannot ${method} ${path}`);
                }
            } catch (error) {
                result = fail(500, 'Internal server error', {
                    detail: String(error?.stack ?? error),
                });
            }

            if (logged) {
                logged.status = result.status;
                logged.response = Buffer.isBuffer(result.body)
                    ? '<binary>'
                    : result.body === null
                      ? null
                      : JSON.stringify(result.body).length > 4096
                        ? '<omitted: large body>'
                        : result.body;
            }

            const buffer =
                result.body === null
                    ? null
                    : Buffer.isBuffer(result.body)
                      ? result.body
                      : Buffer.from(JSON.stringify(result.body));
            const headers = {
                'X-RateLimit-Limit-short': '10',
                'X-RateLimit-Limit-medium': '100',
                'X-RateLimit-Limit-long': '1000',
                ...(buffer === null
                    ? {}
                    : { 'Content-Type': 'application/json; charset=utf-8' }),
                ...result.headers,
                ...(buffer === null
                    ? {}
                    : { 'Content-Length': String(buffer.length) }),
            };

            response.writeHead(result.status, headers);
            response.end(buffer ?? undefined);
        });
    });

    await new Promise((done, failListen) => {
        server.once('error', failListen);
        server.listen(options.port ?? 0, host, done);
    });

    const port = server.address().port;

    return {
        port,
        url: `http://${host}:${port}`,
        apiKey: adminKey,
        /** The live state (tests read it; mutate through the control API). */
        get state() {
            return state;
        },
        async close() {
            for (const timer of state.timers) {
                clearTimeout(timer);
            }

            resetState();
            server.closeAllConnections?.();
            await new Promise((done) => server.close(() => done()));
        },
    };
}

// ---------------------------------------------------------------------------------------------------------------------------
// CLI

if (
    process.argv[1] &&
    import.meta.url === pathToFileURL(process.argv[1]).href
) {
    const args = Object.fromEntries(
        process.argv
            .slice(2)
            .filter((arg) => arg.startsWith('--'))
            .map((arg) => {
                const [key, ...rest] = arg.slice(2).split('=');

                return [key, rest.length === 0 ? 'true' : rest.join('=')];
            }),
    );
    const port = Number(args.port);

    if (!Number.isInteger(port) || port < 1) {
        console.error(
            'usage: openwa-mock.mjs --port=<port> [--key=<api key>] [--host=127.0.0.1] [--retry-base-ms=5000] [--ssrf=allow-loopback|strict] [--start-delay-ms=0] [--validation-detail]',
        );
        process.exit(2);
    }

    const mock = await startOpenWaMock({
        port,
        host: args.host,
        apiKey: args.key,
        retryBaseMs:
            args['retry-base-ms'] === undefined
                ? undefined
                : Number(args['retry-base-ms']),
        startDelayMs:
            args['start-delay-ms'] === undefined
                ? undefined
                : Number(args['start-delay-ms']),
        ssrf: args.ssrf,
        validationDetail: args['validation-detail'] === 'true',
    });

    console.log(`openwa-mock listening on ${mock.url}`);

    const stop = () => {
        void mock.close().finally(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    };

    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
}
