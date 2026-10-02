/**
 * Raw HTTP at the app's webhook route (`POST /webhooks/openwa/{session ulid}`) with signatures made by the SPEC's own HMAC code, not by the
 * OpenWA mock: the cases the mock cannot or should not produce (a body of any size, bytes that are not JSON, a header spelled wrongly, a
 * signature over another session's secret). Plus what only the database knows: a session's webhook secret and the delivery ledger.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { APIRequestContext } from '@playwright/test';
import { tinker } from './artisan';
import type { Instance } from './scenarios';

/** `sha256=<hex>`: HMAC-SHA256 over the exact bytes, as OpenWA writes the header. */
export const signature = (secret: string, raw: string | Buffer): string =>
    `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;

/** The secret the app generated for the session's webhook (the database holds it encrypted; the application decrypts it for the check). */
export async function readWebhookSecret(
    instance: Instance,
    ulid: string,
): Promise<string> {
    const output = await tinker(
        instance,
        `$s = App\\Models\\WhatsAppSession::where('ulid', getenv('E2E_ULID'))->firstOrFail(); echo "E2E_SECRET=".$s->webhook_secret."\\n";`,
        { E2E_ULID: ulid },
    );
    const line = output
        .split('\n')
        .find((row) => row.startsWith('E2E_SECRET='));
    const secret = line?.slice('E2E_SECRET='.length).trim() ?? '';

    if (secret === '') {
        throw new Error(`No webhook secret for session ${ulid}:\n${output}`);
    }

    return secret;
}

export type LedgerRow = {
    event: string;
    outcome: string | null;
    key: string;
    deliveryId: string | null;
    error: string | null;
};

/** The idempotency ledger of one session (`wa_webhook_deliveries`), oldest first. */
export async function readLedger(
    instance: Instance,
    ulid: string,
): Promise<LedgerRow[]> {
    const output = await tinker(
        instance,
        `$s = App\\Models\\WhatsAppSession::where('ulid', getenv('E2E_ULID'))->firstOrFail();
echo "E2E_LEDGER=".json_encode(App\\Models\\WaWebhookDelivery::where('session_id', $s->id)->orderBy('id')->get()->map(fn ($d) => ['event' => $d->event, 'outcome' => $d->outcome?->value, 'key' => $d->idempotency_key, 'deliveryId' => $d->delivery_id, 'error' => $d->error])->all())."\\n";`,
        { E2E_ULID: ulid },
    );
    const line = output
        .split('\n')
        .find((row) => row.startsWith('E2E_LEDGER='));

    if (!line) {
        throw new Error(`The ledger could not be read:\n${output}`);
    }

    return JSON.parse(line.slice('E2E_LEDGER='.length)) as LedgerRow[];
}

/** What the app answered. */
export type HookAnswer = {
    status: number;
    body: any;
    headers: Record<string, string>;
    text: string;
};

export type Envelope = {
    event: string;
    timestamp: string;
    sessionId: string;
    idempotencyKey: string;
    deliveryId: string;
    data: unknown;
};

/** The JSON envelope of a delivery (OpenWA's `sessionId` is its own UUID). */
export function envelope(
    openWaSessionId: string,
    event: string,
    data: unknown,
    extra: Partial<Envelope> = {},
): Envelope {
    return {
        event,
        timestamp: new Date().toISOString(),
        sessionId: openWaSessionId,
        idempotencyKey: `evt_${randomUUID()}`,
        deliveryId: `dlv_${randomUUID()}`,
        data,
        ...extra,
    };
}

/** A customer's text message as `message.received` carries it. */
export function textMessage(
    customer: string,
    body: string,
    id = `3EB0${randomUUID().replace(/-/g, '').slice(0, 16).toUpperCase()}`,
): Record<string, unknown> {
    return {
        id: `false_${customer}@c.us_${id}`,
        from: `${customer}@c.us`,
        chatId: `${customer}@c.us`,
        body,
        type: 'text',
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: false,
        isGroup: false,
        kind: 'individual',
    };
}

export class WebhookClient {
    constructor(
        private readonly request: APIRequestContext,
        private readonly instance: Instance,
        readonly ulid: string,
        readonly secret: string,
    ) {}

    get url(): string {
        return `${this.instance.url}/webhooks/openwa/${this.ulid}`;
    }

    /**
     * POSTs `raw` (the exact bytes) with OpenWA's headers. `sign` = what goes in `X-OpenWA-Signature`: `true` (a valid one with the
     * session's secret), `false` (no header), or the literal header value. `address` is the client address the server sees
     * (`X-Forwarded-For`: the instance trusts it, and its own rate-limit bucket keeps a flood away from everybody else's webhooks).
     */
    async post(
        raw: string | Buffer,
        options: {
            sign?: boolean | string;
            key?: string;
            event?: string;
            headers?: Record<string, string>;
            address?: string;
            url?: string;
        } = {},
    ): Promise<HookAnswer> {
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-OpenWA-Event': options.event ?? 'message.received',
            'X-OpenWA-Delivery-Id': `dlv_${randomUUID()}`,
            'X-OpenWA-Idempotency-Key': options.key ?? `evt_${randomUUID()}`,
            ...(options.address ? { 'X-Forwarded-For': options.address } : {}),
            ...options.headers,
        };
        const sign = options.sign ?? true;

        if (sign === true) {
            headers['X-OpenWA-Signature'] = signature(this.secret, raw);
        } else if (typeof sign === 'string') {
            headers['X-OpenWA-Signature'] = sign;
        }

        const response = await this.request.post(options.url ?? this.url, {
            headers,
            data: Buffer.isBuffer(raw) ? raw : Buffer.from(raw),
            failOnStatusCode: false,
            maxRedirects: 0,
        });
        const text = await response.text();
        let body: unknown;

        try {
            body = text === '' ? undefined : JSON.parse(text);
        } catch {
            body = undefined;
        }

        return {
            status: response.status(),
            body,
            headers: response.headers(),
            text,
        };
    }

    /** Sends an envelope as JSON, signed. */
    send(
        body: Envelope,
        options: Parameters<WebhookClient['post']>[1] = {},
    ): Promise<HookAnswer> {
        return this.post(JSON.stringify(body), {
            key: body.idempotencyKey,
            event: body.event,
            ...options,
        });
    }
}

export type RelayCall = {
    n: number;
    /** What the relay did with it: `lost-answer` (the app got it, OpenWA is told 500), `unreachable` (the app never saw it, OpenWA is told 503), `passed`. */
    outcome: 'lost-answer' | 'unreachable' | 'passed';
    /** What the app answered (null when it was never asked). */
    appStatus: number | null;
    appBody: string | null;
    headers: Record<string, string>;
    raw: string;
};

export type Relay = {
    /** Where OpenWA is told to deliver (a loopback address on a free port). */
    url: string;
    calls: RelayCall[];
    close(): Promise<void>;
};

/**
 * A go-between for the deliveries of one session: it stands where OpenWA's webhook points and passes every delivery on to the real route
 * (same headers, same bytes, so the signature still verifies), but fails the first `fail` of them the way a network does: the app GOT the
 * delivery and its answer was lost (OpenWA sees a 500 and will retry), or the app never saw it at all (a 503). OpenWA's retries then
 * arrive with the same delivery id and idempotency key: exactly what a flaky network makes of a webhook. The relay listens on a free port
 * chosen by the system (never one of the suite's).
 */
export async function startRelay(
    target: string,
    options: { fail: number; mode: 'lost-answer' | 'unreachable' },
): Promise<Relay> {
    const { createServer } = await import('node:http');
    const calls: RelayCall[] = [];
    const server = createServer((request, response) => {
        const chunks: Buffer[] = [];

        request.on('data', (chunk: Buffer) => chunks.push(chunk));
        request.on('end', () => {
            const raw = Buffer.concat(chunks);
            const headers = Object.fromEntries(
                Object.entries(request.headers)
                    .filter(([, value]) => typeof value === 'string')
                    .map(([name, value]) => [name, value as string]),
            );
            const call: RelayCall = {
                n: calls.length + 1,
                outcome: 'passed',
                appStatus: null,
                appBody: null,
                headers,
                raw: raw.toString('utf8'),
            };
            const failing = calls.length < options.fail;

            calls.push(call);

            if (failing && options.mode === 'unreachable') {
                call.outcome = 'unreachable';
                response.writeHead(503).end('relay: unreachable');

                return;
            }

            void fetch(target, {
                method: 'POST',
                headers: {
                    'Content-Type':
                        headers['content-type'] ?? 'application/json',
                    ...Object.fromEntries(
                        Object.entries(headers).filter(([name]) =>
                            name.startsWith('x-openwa-'),
                        ),
                    ),
                },
                body: raw,
            })
                .then(async (answer) => {
                    call.appStatus = answer.status;
                    call.appBody = await answer.text();

                    if (failing) {
                        call.outcome = 'lost-answer';
                        response.writeHead(500).end('relay: answer lost');

                        return;
                    }

                    response
                        .writeHead(answer.status, {
                            'Content-Type': 'application/json',
                        })
                        .end(call.appBody);
                })
                .catch(() => response.writeHead(502).end('relay: failed'));
        });
    });

    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));

    const address = server.address();

    if (address === null || typeof address === 'string') {
        throw new Error('The relay has no port.');
    }

    return {
        url: `http://127.0.0.1:${address.port}/`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
    };
}
