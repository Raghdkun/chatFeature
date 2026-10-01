/**
 * The chat REST APIs as test helpers (no UI): the management API for staff (`StaffApi`, Sanctum cookie + XSRF through `Api`) and the
 * public API for a visitor (`VisitorApi`, bearer `vt_...`, no cookies). Shapes are those of docs/rest-api.md ("Chat API (P4)");
 * the types below only name the fields the specs read.
 *
 * Every method returns the `ApiResult` (status, `data`, `error`) so specs can assert refusals (`409 already_claimed`, `403`, `404`)
 * as well as successes; `must()` turns a result into its data or throws.
 */
import { request, type APIRequestContext } from '@playwright/test';
import { Api, type ApiResult } from './api';
import { hostOrigin } from './host';
import type { Instance } from './scenarios';

export type PresenceStatus = 'online' | 'away' | 'offline';
export type ConversationStatus =
    | 'queued'
    | 'active'
    | 'ended'
    | 'closed'
    | 'missed';

/** `ConversationStaff` (and, with fewer fields, `ConversationPublic`). */
export type Conversation = {
    ulid: string;
    ticketNo: string;
    status: ConversationStatus;
    type: 'live' | 'offline';
    category: { slug: string; label: string } | null;
    agent: { name: string; avatarUrl: string | null } | null;
    createdAt: string;
    endedAt: string | null;
    ratingRequested: boolean;
    lastSeq: number;
    // staff only
    visitor?: {
        ulid: string;
        name: string | null;
        email: string | null;
        verified: boolean;
    };
    widget?: { ulid: string; name: string };
    assignedAgent?: { id: number; name: string } | null;
    unseenByAgent?: number;
    claimedAt?: string | null;
    queueExpiresAt?: string | null;
};

export type Message = {
    ulid: string;
    seq: number;
    conversation: string;
    sender: {
        type: 'visitor' | 'agent' | 'system';
        name: string | null;
        id?: number;
    };
    type: 'text' | 'image' | 'system';
    body: string | null;
    clientMsgId: string | null;
    deliveredAt: string | null;
    seenAt: string | null;
};

/** The data of a result, or an error naming the call: setup code must not carry on after a failed step. */
export function must<T = any>(result: ApiResult, what: string): T {
    if (!result.ok) {
        throw new Error(
            `${what} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
        );
    }

    return result.data as T;
}

/** A fresh ULID-shaped id for `client_msg_id` (26 characters of Crockford base32; the server only checks the shape). */
export function clientMsgId(): string {
    const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
    let out = '';

    for (let index = 0; index < 26; index += 1) {
        out += alphabet[Math.floor(Math.random() * alphabet.length)];
    }

    return `01${out.slice(2)}`;
}

/** The management API as a staff member (the cookies of `api`'s context decide who). */
export class StaffApi {
    constructor(readonly api: Api) {}

    presence = () => this.api.get('/api/v1/me/presence');
    /** `PUT /me/presence`: `online` / `away` also count as a heartbeat; `offline` is explicit. */
    setPresence = (status: PresenceStatus) =>
        this.api.put('/api/v1/me/presence', { status });
    heartbeat = () => this.api.post('/api/v1/me/presence/heartbeat');

    /** `GET /conversations` (filters: `status`, `category`, `widget`, `agent`, `type`, `q`, `from`, `to`, `limit`, ...). */
    conversations = (query: Record<string, string | number> = {}) =>
        this.api.get(
            `/api/v1/conversations?${new URLSearchParams(
                Object.entries(query).map(([key, value]) => [
                    key,
                    String(value),
                ]),
            )}`,
        );
    /** The queued chats this caller could accept. */
    queue = () => this.api.get('/api/v1/conversations/queue');
    conversation = (ulid: string) =>
        this.api.get(`/api/v1/conversations/${ulid}`);
    messages = (ulid: string, afterSeq = 0, limit = 100) =>
        this.api.get(
            `/api/v1/conversations/${ulid}/messages?after_seq=${afterSeq}&limit=${limit}`,
        );
    /** The atomic accept. */
    claim = (ulid: string) =>
        this.api.post(`/api/v1/conversations/${ulid}/claim`);
    send = (ulid: string, body: string, id: string = clientMsgId()) =>
        this.api.post(`/api/v1/conversations/${ulid}/messages`, {
            client_msg_id: id,
            body,
        });
    end = (ulid: string) => this.api.post(`/api/v1/conversations/${ulid}/end`);
    /** Offline tickets (agent) and any unfinished conversation (admin). */
    close = (ulid: string) =>
        this.api.post(`/api/v1/conversations/${ulid}/close`);
    transfer = (
        ulid: string,
        target: { agent_id: number } | { category: string },
    ) => this.api.post(`/api/v1/conversations/${ulid}/transfer`, target);
    transferTargets = (ulid: string) =>
        this.api.get(`/api/v1/conversations/${ulid}/transfer-targets`);
    receipts = (
        ulid: string,
        upto: { delivered_upto?: number; seen_upto?: number },
    ) => this.api.post(`/api/v1/conversations/${ulid}/receipts`, upto);
    typing = (ulid: string, typing: boolean) =>
        this.api.post(`/api/v1/conversations/${ulid}/typing`, { typing });
}

/** A client address nobody else uses: the P4 servers trust `X-Forwarded-For`, so every visitor is a network of its own (rate limits). */
export function clientAddress(): string {
    const octet = () => 1 + Math.floor(Math.random() * 253);

    return `10.${octet()}.${octet()}.${octet()}`;
}

export type StartSessionOptions = {
    /** Widget public key. */
    key: string;
    /** The `Origin` the browser would send: default the instance's customer site. */
    origin?: string;
    visitor?: {
        name?: string;
        email?: string;
        phone?: string;
        meta?: Record<string, unknown>;
    };
    identityToken?: string;
    page?: { url: string; title?: string; referrer?: string };
    locale?: string;
    /** Rotate: send an earlier visitor token as the bearer. */
    bearer?: string;
    /** The client address (`X-Forwarded-For`) this visitor presents: default a fresh one; pass the same twice to share a rate-limit bucket. */
    address?: string;
};

/**
 * A visitor without a browser: the public API with the visitor's bearer token. `VisitorApi.start()` creates the session
 * (`POST /public/widgets/{key}/sessions`); then `startChat`, `send`, `end`, `rate` ... work like the panel's own calls.
 */
export class VisitorApi {
    private constructor(
        readonly context: APIRequestContext,
        readonly token: string,
        /** `data` of the session answer: `visitorToken`, `expiresAt`, `conversation`, `ws`, `limits`. */
        readonly session: any,
        private readonly address: string,
    ) {}

    static async start(
        instance: Instance,
        options: StartSessionOptions,
    ): Promise<VisitorApi> {
        const address = options.address ?? clientAddress();
        const context = await request.newContext({
            baseURL: instance.url,
            extraHTTPHeaders: {
                Accept: 'application/json',
                Origin: options.origin ?? hostOrigin(instance),
                'X-Forwarded-For': address,
            },
        });
        const response = await context.post(
            `/api/v1/public/widgets/${options.key}/sessions`,
            {
                headers: options.bearer
                    ? { Authorization: `Bearer ${options.bearer}` }
                    : {},
                data: {
                    ...(options.visitor ? { visitor: options.visitor } : {}),
                    ...(options.identityToken
                        ? { identity_token: options.identityToken }
                        : {}),
                    ...(options.page ? { page: options.page } : {}),
                    ...(options.locale ? { locale: options.locale } : {}),
                },
                failOnStatusCode: false,
            },
        );
        const body = await response.json().catch(() => undefined);

        if (response.status() !== 201) {
            await context.dispose();

            throw new Error(
                `Starting a visitor session failed: HTTP ${response.status()} ${JSON.stringify(body)}`,
            );
        }

        return new VisitorApi(
            context,
            body.data.visitorToken,
            body.data,
            address,
        );
    }

    async request(
        method: 'GET' | 'POST' | 'DELETE',
        path: string,
        body?: unknown,
    ): Promise<ApiResult> {
        const response = await this.context.fetch(`/api/v1/public${path}`, {
            method,
            headers: { Authorization: `Bearer ${this.token}` },
            data: body === undefined ? undefined : body,
            failOnStatusCode: false,
        });
        const text = await response.text();
        let parsed: any;

        try {
            parsed = text === '' ? undefined : JSON.parse(text);
        } catch {
            parsed = undefined;
        }

        return {
            status: response.status(),
            ok: response.ok(),
            body: parsed,
            headers: response.headers(),
            data: parsed?.data ?? (parsed?.error ? undefined : parsed),
            error: parsed?.error,
        };
    }

    /** `GET /public/conversation`: this session's latest live conversation (`data` is null when there is none). */
    conversation = () => this.request('GET', '/conversation');
    /** `POST /public/conversations`: start a chat in `category` (a slug). */
    startChat = (body: {
        category: string;
        name?: string;
        email?: string;
        phone?: string;
        message?: string;
        consent?: boolean;
    }) => this.request('POST', '/conversations', body);
    messages = (ulid: string, afterSeq = 0) =>
        this.request(
            'GET',
            `/conversations/${ulid}/messages?after_seq=${afterSeq}`,
        );
    send = (ulid: string, body: string, id: string = clientMsgId()) =>
        this.request('POST', `/conversations/${ulid}/messages`, {
            client_msg_id: id,
            body,
        });
    receipts = (
        ulid: string,
        upto: { delivered_upto?: number; seen_upto?: number },
    ) => this.request('POST', `/conversations/${ulid}/receipts`, upto);
    typing = (ulid: string, typing: boolean) =>
        this.request('POST', `/conversations/${ulid}/typing`, { typing });
    end = (ulid: string) => this.request('POST', `/conversations/${ulid}/end`);
    cancel = (ulid: string) =>
        this.request('POST', `/conversations/${ulid}/cancel`);
    rate = (ulid: string, score: number, comment?: string) =>
        this.request('POST', `/conversations/${ulid}/rating`, {
            score,
            ...(comment === undefined ? {} : { comment }),
        });
    skipRating = (ulid: string) =>
        this.request('POST', `/conversations/${ulid}/rating/skip`);
    offlineTicket = (body: {
        name: string;
        email: string;
        message: string;
        category?: string;
        missed_conversation?: string;
    }) => this.request('POST', '/offline-tickets', body);
    /** `DELETE /public/sessions`: every session of the visitor is revoked. */
    signOut = () => this.request('DELETE', '/sessions');

    /** Another session of the same visitor (rotation): the previous token stays valid for 60 s. */
    rotate(instance: Instance, key: string): Promise<VisitorApi> {
        return VisitorApi.start(instance, { key, bearer: this.token });
    }

    async dispose(): Promise<void> {
        await this.context.dispose();
    }

    /** The client address this visitor presents (for specs that need the same network twice). */
    get clientAddress(): string {
        return this.address;
    }
}
