/**
 * The typed client of the OpenWA mock's control API (`e2e/support/openwa-mock.mjs`, P6): what a WhatsApp spec uses to play OpenWA and
 * the phone. The `openWa` fixture of `e2e/support/test.ts` builds one for the scenario's instance (`p6-wa`):
 *
 *   test.use({ scenario: 'p6-wa' });
 *   test.beforeEach(async ({ openWa }) => openWa.reset());
 *   test('...', async ({ openWa }) => {
 *       const session = await openWa.waitForSession('support-main');          // the app created it through the OpenWA API
 *       await openWa.setStatus(session.id, 'ready', { phone: '4915100000000' });
 *       await openWa.inboundText(session.id, '4915112345678', 'Hi! My support code is K7M2QX4P');
 *       const send = await openWa.waitForRequest((call) => call.path.endsWith('/messages/send-text'));
 *   });
 *
 * `reset()` forgets the mock's sessions, webhooks, logs, scripts and config (not the app's database: the app learns about a vanished
 * session through its own reconciliation). Everything here talks plain HTTP to the mock and never to the app.
 */
import { readFileSync } from 'node:fs';
import { ROOT, type Instance } from './scenarios';

export type OpenWaStatus =
    | 'created'
    | 'initializing'
    | 'qr_ready'
    | 'authenticating'
    | 'ready'
    | 'disconnected'
    | 'action_required'
    | 'failed';

export type AckStatus =
    | 'pending'
    | 'sent'
    | 'delivered'
    | 'read'
    | 'played'
    | 'failed';

/** `SessionResponseDto` of OpenWA (the fields the app reads). */
export type MockSession = {
    id: string;
    name: string;
    status: OpenWaStatus;
    phone: string | null;
    pushName: string | null;
    connectedAt: string | null;
    lastActive: string | null;
    createdAt: string;
    updatedAt: string;
    lastError: string | null;
    restriction: null;
    engineLoaded: boolean;
};

export type MockWebhook = {
    id: string;
    sessionId: string;
    url: string;
    events: string[];
    active: boolean;
    retryCount: number;
    hasSecret: boolean;
};

/** One API call the app made (the control API's request log; the key is the one the app presented). */
export type MockRequest = {
    n: number;
    at: string;
    method: string;
    path: string;
    query: Record<string, string>;
    auth: 'x-api-key' | 'bearer' | 'none';
    apiKey: string | null;
    body: unknown;
    status: number;
    /** What the mock answered (JSON bodies up to 4 KB; the QR and media bytes are not kept): e.g. `{ messageId, timestamp }` of a send. */
    response: unknown;
};

/** One delivery ATTEMPT to the app: what it answered (`status`, null = no answer), the exact headers and raw body that were sent. */
export type MockDelivery = {
    n: number;
    at: string;
    event: string;
    sessionId: string;
    webhookId: string;
    url: string;
    deliveryId: string;
    idempotencyKey: string;
    retryCount: number;
    status: number | null;
    error: string | null;
    outcome: 'delivered' | 'retrying' | 'failed';
    headers: Record<string, string>;
    rawBody: string;
};

export type InboundMedia = {
    mimetype?: string;
    filename?: string;
    /** The bytes, base64 (decoded size above the inline limit makes the media arrive `omitted`). */
    dataBase64?: string;
    /** Without `dataBase64`: pretend the media has this many bytes (it arrives `omitted`, and nothing can be downloaded). */
    sizeBytes?: number;
    /** Without `dataBase64` and `sizeBytes`: a generated PNG of `size` x `size` pixels (default 64). */
    size?: number;
    /** Force the `omitted` marker (the bytes stay downloadable unless `stored` is false). */
    omitted?: boolean;
    /** false: the media route answers 404 for it. */
    stored?: boolean;
};

export type InboundMessage = {
    /** Bare digits or a full chat id; default a person `4915112345678@c.us`. */
    from?: string;
    chatId?: string;
    body?: string;
    type?: string;
    fromMe?: boolean;
    isGroup?: boolean;
    kind?:
        | 'individual'
        | 'group'
        | 'channel'
        | 'status'
        | 'broadcast'
        | 'unknown';
    /** Group / status sender. */
    author?: string;
    pushName?: string;
    /** The sender is a privacy id (`...@lid`); `senderPhone` is added when RESOLVE_LID_TO_PHONE (default on in the mock). */
    lid?: boolean;
    senderPhone?: string;
    media?: InboundMedia;
    /** Pin the WhatsApp message id (to replay "the same message"). */
    id?: string;
    timestamp?: number;
    /** `message.received` (default) or any other event name, e.g. `message.sent`. */
    event?: string;
};

export type MockConfig = Partial<{
    startDelayMs: number;
    retryBaseMs: number;
    deliveryTimeoutMs: number;
    ssrf: 'allow-loopback' | 'strict';
    validationDetail: boolean;
    teardownPendingMs: number;
    acks: Partial<{
        mode: 'auto' | 'manual';
        steps: AckStatus[];
        delayMs: number;
    }>;
    pacing: Partial<{
        minIntervalMs: number;
        dailyCap: number;
        coldDailyCap: number;
    }>;
    resolveLid: boolean;
    mediaInlineMaxBytes: number;
    sentEcho: boolean;
}>;

export type DeliverOptions = {
    /** Session id or name; its webhooks that listen for `event` receive it (or `url`). */
    session?: string;
    event: string;
    data: unknown;
    /** `valid` (default), `bad` (zeros), `wrong-secret`, `tampered` (signed over other bytes), `missing` (no header). */
    signature?: 'valid' | 'bad' | 'wrong-secret' | 'tampered' | 'missing';
    /** Deliver here instead of to the registered webhooks (then `secret` signs it). */
    url?: string;
    secret?: string;
    idempotencyKey?: string;
    deliveryId?: string;
    retryCount?: number;
};

export type ScriptedResponse = {
    method?: string;
    /** Substring of the request path. */
    path?: string;
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    /** How many matching calls answer this (default 1). */
    times?: number;
};

export class OpenWaMock {
    constructor(
        readonly url: string,
        readonly apiKey: string,
    ) {}

    /** The mock of an instance (`p6-wa`); throws for a scenario without one. */
    static for(instance: Instance): OpenWaMock {
        if (instance.openWa === null) {
            throw new Error(`Scenario ${instance.key} has no OpenWA mock.`);
        }

        return new OpenWaMock(instance.openWa.url, instance.openWa.apiKey);
    }

    private async control<T>(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<T> {
        const response = await fetch(`${this.url}${path}`, {
            method,
            ...(body === undefined
                ? {}
                : {
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify(body),
                  }),
        });
        const text = await response.text();

        if (!response.ok) {
            throw new Error(
                `OpenWA mock ${method} ${path} failed: HTTP ${response.status} ${text}`,
            );
        }

        return (text === '' ? null : JSON.parse(text)) as T;
    }

    /** A call to the mock's OpenWA API as OpenWA's client would make it (with the admin key unless `key` says otherwise). */
    async api(
        method: string,
        path: string,
        options: { body?: unknown; key?: string | null } = {},
    ): Promise<{ status: number; body: any; headers: Headers }> {
        const key = options.key === undefined ? this.apiKey : options.key;
        const response = await fetch(`${this.url}${path}`, {
            method,
            headers: {
                ...(key === null ? {} : { 'X-API-Key': key }),
                ...(options.body === undefined
                    ? {}
                    : { 'Content-Type': 'application/json' }),
            },
            body:
                options.body === undefined
                    ? undefined
                    : JSON.stringify(options.body),
            redirect: 'manual',
        });
        const text = await response.text();
        let body: unknown = text === '' ? null : text;

        try {
            body = text === '' ? null : JSON.parse(text);
        } catch {
            // media bytes, plain text
        }

        return { status: response.status, body, headers: response.headers };
    }

    health = () => this.control<{ ok: boolean }>('GET', '/__mock/health');
    /** Forget sessions, webhooks, logs, scripts, throttle and config. */
    reset = () => this.control<{ ok: boolean }>('POST', '/__mock/reset');
    state = () =>
        this.control<{
            config: Record<string, unknown>;
            sessions: (MockSession & {
                paired: boolean;
                hasQr: boolean;
                messages: number;
            })[];
            webhooks: MockWebhook[];
            keys: {
                id: string;
                role: string;
                allowedSessions: string[] | null;
            }[];
        }>('GET', '/__mock/state');
    config = (patch: MockConfig) =>
        this.control<Record<string, unknown>>('POST', '/__mock/config', patch);

    /** The API calls the app made (newest last). `since` is the `n` of the last call you already saw. */
    requests(
        filter: { method?: string; path?: string; since?: number } = {},
    ): Promise<MockRequest[]> {
        const query = new URLSearchParams();

        if (filter.method) query.set('method', filter.method);
        if (filter.path) query.set('path', filter.path);
        if (filter.since) query.set('since', String(filter.since));

        return this.control('GET', `/__mock/requests?${query}`);
    }
    clearRequests = () => this.control('DELETE', '/__mock/requests');

    /** Delivery attempts to the app (one row per attempt, so a retry shows up as its own row). */
    deliveries(
        filter: { event?: string; since?: number } = {},
    ): Promise<MockDelivery[]> {
        const query = new URLSearchParams();

        if (filter.event) query.set('event', filter.event);
        if (filter.since) query.set('since', String(filter.since));

        return this.control('GET', `/__mock/deliveries?${query}`);
    }

    /** The next matching API call answers `status` (e.g. a 429 `SEND_PACING_LIMITED`, a 502, a 504). */
    script = (response: ScriptedResponse) =>
        this.control('POST', '/__mock/script', response);
    /** The next `next` API calls answer the global throttler's 429. */
    throttle = (next = 1) => this.control('POST', '/__mock/throttle', { next });
    /** `SEND_PACING_LIMITED` on the next send(s). */
    pacingLimited(retryAfterSeconds = 3600, times = 1) {
        return this.script({
            method: 'POST',
            path: '/messages/send-text',
            status: 429,
            body: {
                statusCode: 429,
                error: 'Too Many Requests',
                message:
                    'Daily allowance of 5 new conversation(s) reached for a session 0 day(s) old',
                code: 'SEND_PACING_LIMITED',
                retryAfterSeconds,
            },
            times,
        });
    }

    createKey = (
        role: 'viewer' | 'operator' | 'admin',
        allowedSessions?: string[],
    ) =>
        this.control<{ key: string; id: string }>('POST', '/__mock/keys', {
            role,
            allowedSessions,
        });

    /** A session in any state, created without events (use `setStatus` to make the app hear about a change). */
    createSession = (body: {
        name: string;
        status?: OpenWaStatus;
        phone?: string;
        pushName?: string;
        paired?: boolean;
    }) => this.control<MockSession>('POST', '/__mock/sessions', body);

    /** Moves a session (id or name) and emits what OpenWA emits: `session.status` (+ `session.qr`, `session.authenticated`, `session.disconnected`). */
    setStatus = (
        ref: string,
        status: OpenWaStatus,
        extra: { phone?: string; pushName?: string; reason?: string } = {},
    ) =>
        this.control<MockSession>(
            'POST',
            `/__mock/sessions/${encodeURIComponent(ref)}/status`,
            { status, ...extra },
        );
    /** The session is paired and running: `ready` with a phone. */
    connect = (
        ref: string,
        phone = '4915100000000',
        pushName = 'PNE Support',
    ) => this.setStatus(ref, 'ready', { phone, pushName });
    /** A fresh QR (`session.qr`), the way OpenWA refreshes it about every 60 s. */
    newQr = (ref: string) =>
        this.control<MockSession>(
            'POST',
            `/__mock/sessions/${encodeURIComponent(ref)}/qr`,
        );

    /** A message arrives at the session's phone. Returns the WhatsApp message id and chat id. */
    inbound = (ref: string, message: InboundMessage) =>
        this.control<{
            messageId: string;
            chatId: string;
            message: Record<string, unknown>;
        }>(
            'POST',
            `/__mock/sessions/${encodeURIComponent(ref)}/inbound`,
            message,
        );
    inboundText = (
        ref: string,
        from: string,
        body: string,
        extra: InboundMessage = {},
    ) => this.inbound(ref, { from, body, ...extra });
    inboundImage = (
        ref: string,
        from: string,
        caption = '',
        media: InboundMedia = {},
    ) =>
        this.inbound(ref, {
            from,
            body: caption,
            type: 'image',
            media: { mimetype: 'image/png', filename: 'photo.png', ...media },
        });
    inboundGroup = (ref: string, body: string, author = '4915198765432@c.us') =>
        this.inbound(ref, {
            chatId: '120363000000000001@g.us',
            kind: 'group',
            isGroup: true,
            author,
            body,
        });
    /** A sender known only by a privacy id (`@lid`). */
    inboundLid = (ref: string, body: string, extra: InboundMessage = {}) =>
        this.inbound(ref, { lid: true, body, ...extra });
    /** The phone's own send (`fromMe: true`). */
    inboundFromMe = (ref: string, to: string, body: string) =>
        this.inbound(ref, { from: to, body, fromMe: true });

    /** A receipt for an outbound message (`message.ack`, plus `message.failed` for `failed`). */
    ack = (ref: string, messageId: string, status: AckStatus) =>
        this.control<{ ok: boolean }>(
            'POST',
            `/__mock/sessions/${encodeURIComponent(ref)}/ack`,
            { messageId, status },
        );

    /** Delivers an earlier delivery again: same idempotency key, new delivery id (`sameBody` = the very same bytes, as an automatic retry would). */
    replay = (delivery: number, sameBody = false) =>
        this.control<{ n: number; status: number | null }>(
            'POST',
            '/__mock/replay',
            { delivery, sameBody },
        );
    /** An arbitrary delivery, e.g. with a bad signature: resolves with the status the app answered. */
    deliver = (options: DeliverOptions) =>
        this.control<{
            results: {
                n: number;
                webhookId: string;
                status: number | null;
                error: string | null;
            }[];
        }>('POST', '/__mock/deliver', options);

    private async poll<T>(
        read: () => Promise<T | undefined>,
        what: string,
        timeoutMs: number,
    ): Promise<T> {
        const until = Date.now() + timeoutMs;

        for (;;) {
            const found = await read();

            if (found !== undefined) {
                return found;
            }

            if (Date.now() > until) {
                throw new Error(
                    `Timed out after ${timeoutMs} ms waiting for ${what}.`,
                );
            }

            await new Promise((done) => setTimeout(done, 100));
        }
    }

    /** Waits for an API call of the app (e.g. the `send-text` of a reply). */
    waitForRequest(
        predicate: (call: MockRequest) => boolean,
        { timeoutMs = 15_000, since = 0 } = {},
    ): Promise<MockRequest> {
        return this.poll(
            async () => (await this.requests({ since })).find(predicate),
            'an API call of the app',
            timeoutMs,
        );
    }

    /** Waits for a delivery attempt (the app answered it, or did not). */
    waitForDelivery(
        predicate: (attempt: MockDelivery) => boolean,
        { timeoutMs = 15_000, since = 0 } = {},
    ): Promise<MockDelivery> {
        return this.poll(
            async () => (await this.deliveries({ since })).find(predicate),
            'a webhook delivery attempt',
            timeoutMs,
        );
    }

    /** Waits until the app has created a session of this name through the API. */
    waitForSession(
        name: string,
        { timeoutMs = 15_000 } = {},
    ): Promise<MockSession> {
        return this.poll(
            async () =>
                (await this.state()).sessions.find(
                    (session) => session.name === name,
                ),
            `session "${name}"`,
            timeoutMs,
        );
    }

    /** The webhooks the app registered for a session (the secret is never shown, `hasSecret` says it was set). */
    async webhooksOf(ref: string): Promise<MockWebhook[]> {
        const state = await this.state();
        const session = state.sessions.find(
            (item) => item.id === ref || item.name === ref,
        );

        return session
            ? state.webhooks.filter((hook) => hook.sessionId === session.id)
            : [];
    }
}

/** A recorded / documented fixture of `tests/fixtures/openwa` (see `index.json` for what is recorded and what is documented). */
export function openWaFixture<T = any>(name: string): T {
    return JSON.parse(
        readFileSync(`${ROOT}tests/fixtures/openwa/${name}.json`, 'utf8'),
    ) as T;
}
