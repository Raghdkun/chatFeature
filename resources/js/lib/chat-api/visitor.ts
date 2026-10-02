/**
 * Typed client for the PUBLIC chat endpoints (docs/contracts/rest-shapes.md, "Public (visitor bearer)"), used by the embed
 * panel inside the iframe.
 *
 * - No cookies, no CSRF: every call after session creation carries `Authorization: Bearer vt_...` only.
 * - Success: `{ data }` is unwrapped. Errors: `{ error: { code, message, details? } }` becomes a {@link VisitorApiError}
 *   (`409 no_agents`, `409 conversation_exists`, `401 session_revoked`, `422` field errors, `429` with `Retry-After`).
 * - A `429` on a call that is safe to repeat (reads, and message sends, which are idempotent through `client_msg_id`) is retried
 *   after `Retry-After` (capped); everything else surfaces it so the UI can say how long to wait.
 *
 * Framework-free: pass a fake `fetch` (or MSW) in tests.
 */
import type {
    AttachmentData,
    ConversationPublic,
    MessageData,
} from '@/lib/chat/types';
import type { HandoffResponse } from '@/lib/whatsapp/types';

/** The `ws` block of a session response: where Reverb lives for visitors (client-facing values). */
export type WsConfig = {
    key: string;
    host: string;
    port: number;
    scheme: string;
};

/** What the server accepts for one message (the `limits` block of a session response); `null` fields fall back to the panel's defaults. */
export type SessionLimits = {
    maxMessageLength: number | null;
    attachmentMaxBytes: number | null;
    attachmentMaxDimension: number | null;
    attachmentMaxPerMessage: number | null;
};

export type SessionResponse = {
    visitorToken: string;
    expiresAt: string;
    conversation: ConversationPublic | null;
    /** `null` when Reverb is not configured on the server: the panel then stays on REST polling. */
    ws: WsConfig | null;
    /** `null` while the server does not send limits (an older backend): the panel's built-in defaults apply. */
    limits: SessionLimits | null;
};

export type VisitorFields = {
    name?: string;
    email?: string;
    phone?: string;
    meta?: Record<string, string | number | boolean>;
};

export type CreateSessionRequest = {
    identity_token?: string;
    visitor?: VisitorFields;
    page: { url: string; title: string; referrer: string };
    locale: string;
};

export type CreateConversationRequest = {
    category: string;
    name?: string;
    email?: string;
    phone?: string;
    message?: string;
    consent?: boolean;
};

export type OfflineTicketRequest = {
    name: string;
    email: string;
    message: string;
    category?: string;
    missed_conversation?: string;
};

/** `POST .../whatsapp-handoff`: the topic the visitor asks about (the ticket records it, like a chat would). */
export type HandoffRequest = { category?: string };

export type SendMessageRequest = {
    client_msg_id: string;
    body?: string;
    attachments?: string[];
};

export type ReceiptsRequest = {
    delivered_upto?: number;
    seen_upto?: number;
};

export type RatingRequest = { score: number; comment?: string };

export type MessagesPage = {
    messages: MessageData[];
    nextCursor: string | null;
};

export type SentMessage = {
    message: MessageData;
    /** `true` when the server already had this `client_msg_id` (a retry of a message that did go through). */
    replayed: boolean;
};

export type VisitorFieldErrors = Record<string, string[]>;

export type VisitorErrorCode =
    | 'no_agents'
    | 'conversation_exists'
    | 'conversation_not_active'
    | 'conversation_not_ended'
    | 'conversation_not_queued'
    | 'already_rated'
    | 'feature_disabled'
    | 'session_revoked'
    | 'unauthenticated'
    | 'widget_not_found'
    | 'origin_not_allowed'
    | 'not_found'
    | 'validation_failed'
    | 'rate_limited'
    | 'network'
    | 'aborted'
    | 'invalid_response'
    | 'server_error'
    | (string & {});

export class VisitorApiError extends Error {
    readonly status: number;
    readonly code: VisitorErrorCode;
    readonly details: VisitorFieldErrors;
    /** Seconds from `Retry-After` on a 429, when the server sent it. */
    readonly retryAfter: number | null;

    constructor(init: {
        status: number;
        code: VisitorErrorCode;
        message: string;
        details?: VisitorFieldErrors;
        retryAfter?: number | null;
    }) {
        super(init.message);
        this.name = 'VisitorApiError';
        this.status = init.status;
        this.code = init.code;
        this.details = init.details ?? {};
        this.retryAfter = init.retryAfter ?? null;
    }

    /** The token is unusable (expired, revoked, never valid): start a fresh session. */
    get isSessionGone(): boolean {
        return (
            this.code === 'session_revoked' ||
            (this.status === 401 && this.code === 'unauthenticated')
        );
    }

    /** A signed identity the server could not verify (`422`, `details.identity_token`): retrying the same token cannot work. */
    get isIdentityRejected(): boolean {
        return this.status === 422 && 'identity_token' in this.details;
    }

    /** Could not reach the server at all (offline, DNS, CORS, a dropped connection). */
    get isNetwork(): boolean {
        return this.code === 'network';
    }
}

export function isVisitorApiError(value: unknown): value is VisitorApiError {
    return value instanceof VisitorApiError;
}

export type VisitorApiOptions = {
    /** `https://chat.example.com/api/v1/public` (the boot config's `api.base`). */
    base: string;
    /** The widget's public key (`wk_...`), only used to create a session and to read the public config. */
    widgetKey: string;
    /** The current visitor token; `null` before a session exists. */
    token: () => string | null;
    fetchImpl?: typeof fetch;
    /** How many times a `429` on a safe-to-repeat call is retried (default 2). */
    maxRateLimitRetries?: number;
    /** Longest `Retry-After` we are willing to wait for before giving up, in seconds (default 8). */
    maxRetryAfterSeconds?: number;
    /** A request (connect, answer and body) that takes longer fails as a `network` error (milliseconds, default 20 000). */
    timeoutMs?: number;
    /** The same for an image upload (default 90 000). */
    uploadTimeoutMs?: number;
    /** Replace `setTimeout` based waiting (tests). */
    sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
    xhrFactory?: () => XMLHttpRequest;
};

type Query = Record<string, string | number | null | undefined>;

type RequestInitLite = {
    method?: 'GET' | 'POST' | 'DELETE';
    query?: Query;
    json?: unknown;
    /** No bearer (config / availability / session creation without a stored token). */
    anonymous?: boolean;
    /** An explicit bearer, overriding the current token (resuming a stored session). */
    bearer?: string;
    /** The call can be repeated without side effects (or is idempotent): a 429 is retried. */
    safe?: boolean;
    signal?: AbortSignal;
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normaliseDetails(raw: unknown): VisitorFieldErrors {
    if (!isRecord(raw)) {
        return {};
    }

    const details: VisitorFieldErrors = {};

    for (const [field, value] of Object.entries(raw)) {
        const messages = (Array.isArray(value) ? value : [value]).filter(
            (item): item is string => typeof item === 'string' && item !== '',
        );

        if (messages.length > 0) {
            details[field] = messages;
        }
    }

    return details;
}

function parseRetryAfter(value: string | null): number | null {
    if (value === null) {
        return null;
    }

    const seconds = Number(value);

    if (Number.isFinite(seconds) && seconds >= 0) {
        return Math.ceil(seconds);
    }

    const date = Date.parse(value);

    return Number.isNaN(date)
        ? null
        : Math.max(0, Math.ceil((date - Date.now()) / 1000));
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) {
            reject(abortError());

            return;
        }

        const timer = setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        const onAbort = (): void => {
            clearTimeout(timer);
            reject(abortError());
        };

        signal?.addEventListener('abort', onAbort, { once: true });
    });
}

function abortError(): VisitorApiError {
    return new VisitorApiError({
        status: 0,
        code: 'aborted',
        message: 'Request cancelled.',
    });
}

function asConversation(value: unknown): ConversationPublic | null {
    return isRecord(value) &&
        typeof value.ulid === 'string' &&
        typeof value.status === 'string'
        ? (value as unknown as ConversationPublic)
        : null;
}

function invalid(status: number): VisitorApiError {
    return new VisitorApiError({
        status,
        code: 'invalid_response',
        message: 'Unexpected response from the server.',
    });
}

export type UploadOptions = {
    onProgress?: (fraction: number) => void;
    signal?: AbortSignal;
};

export type VisitorApi = ReturnType<typeof createVisitorApi>;

export function createVisitorApi(options: VisitorApiOptions) {
    const base = options.base.replace(/\/+$/, '');
    const fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    const sleep = options.sleep ?? defaultSleep;
    const maxRetries = options.maxRateLimitRetries ?? 2;
    const maxRetryAfter = options.maxRetryAfterSeconds ?? 8;
    const timeoutMs = options.timeoutMs ?? 20_000;
    const widget = encodeURIComponent(options.widgetKey);

    function url(path: string, query?: Query): string {
        const search = new URLSearchParams();

        for (const [key, value] of Object.entries(query ?? {})) {
            if (value !== undefined && value !== null) {
                search.set(key, String(value));
            }
        }

        const qs = search.toString();

        return `${base}${path}${qs === '' ? '' : `?${qs}`}`;
    }

    function headers(init: RequestInitLite, json: boolean): HeadersInit {
        const result: Record<string, string> = { Accept: 'application/json' };
        const bearer = init.bearer ?? (init.anonymous ? null : options.token());

        if (bearer !== null && bearer !== undefined) {
            result.Authorization = `Bearer ${bearer}`;
        }

        if (json) {
            result['Content-Type'] = 'application/json';
        }

        return result;
    }

    async function toError(response: Response): Promise<VisitorApiError> {
        let body: unknown = null;

        try {
            body = await response.json();
        } catch {
            // not JSON (a proxy error page, an empty body)
        }

        const error = isRecord(body) && isRecord(body.error) ? body.error : {};
        const code =
            typeof error.code === 'string'
                ? error.code
                : response.status === 401
                  ? 'unauthenticated'
                  : response.status === 429
                    ? 'rate_limited'
                    : response.status === 404
                      ? 'not_found'
                      : 'server_error';

        return new VisitorApiError({
            status: response.status,
            code,
            message:
                typeof error.message === 'string'
                    ? error.message
                    : `Request failed (${response.status}).`,
            details: normaliseDetails(error.details),
            retryAfter: parseRetryAfter(response.headers.get('Retry-After')),
        });
    }

    /**
     * One round trip (request, answer, body) that must finish within `timeoutMs`: a stalled connection or body is a `network` error,
     * never a spinner that never ends. A caller's own `signal` still wins (`aborted`).
     */
    async function attempt(
        path: string,
        init: RequestInitLite,
        method: string,
    ): Promise<
        | { ok: true; body: unknown; status: number }
        | { ok: false; failure: VisitorApiError }
    > {
        const control = new AbortController();
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: () => void = () => undefined;

        // Settles the attempt when the clock runs out or the caller gives up, even if the transport itself never answers.
        const stop = new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
                control.abort();
                reject(
                    new VisitorApiError({
                        status: 0,
                        code: 'network',
                        message: 'The server took too long to answer.',
                    }),
                );
            }, timeoutMs);
            onAbort = () => {
                control.abort();
                reject(abortError());
            };
        });

        init.signal?.addEventListener('abort', onAbort, { once: true });

        const run = async (): Promise<
            | { ok: true; body: unknown; status: number }
            | { ok: false; failure: VisitorApiError }
        > => {
            let response: Response;

            try {
                response = await fetchImpl(url(path, init.query), {
                    method,
                    mode: 'cors',
                    credentials: 'omit',
                    headers: headers(init, init.json !== undefined),
                    body:
                        init.json === undefined
                            ? undefined
                            : JSON.stringify(init.json),
                    signal: control.signal,
                });
            } catch (error) {
                if (init.signal?.aborted === true) {
                    throw abortError();
                }

                throw new VisitorApiError({
                    status: 0,
                    code: 'network',
                    message:
                        error instanceof Error
                            ? error.message
                            : 'Network error.',
                });
            }

            if (response.ok) {
                if (response.status === 204) {
                    return { ok: true, body: null, status: 204 };
                }

                try {
                    return {
                        ok: true,
                        body: (await response.json()) as unknown,
                        status: response.status,
                    };
                } catch {
                    if (init.signal?.aborted === true) {
                        throw abortError();
                    }

                    throw invalid(response.status);
                }
            }

            return { ok: false, failure: await toError(response) };
        };

        try {
            return await Promise.race([run(), stop]);
        } finally {
            clearTimeout(timer);
            init.signal?.removeEventListener('abort', onAbort);
        }
    }

    /** Returns the parsed body (`null` for 204). Throws {@link VisitorApiError}. */
    async function request(
        path: string,
        init: RequestInitLite = {},
    ): Promise<{ body: unknown; status: number }> {
        const method = init.method ?? 'GET';
        const safe = init.safe ?? method === 'GET';
        let tries = 0;

        for (;;) {
            if (init.signal?.aborted === true) {
                throw abortError();
            }

            const result = await attempt(path, init, method);

            if (result.ok) {
                return { body: result.body, status: result.status };
            }

            const { failure } = result;

            if (
                failure.status === 429 &&
                safe &&
                tries < maxRetries &&
                (failure.retryAfter ?? 1) <= maxRetryAfter
            ) {
                tries += 1;
                await sleep((failure.retryAfter ?? 1) * 1000, init.signal);

                continue;
            }

            throw failure;
        }
    }

    function data(body: unknown, status: number): unknown {
        if (!isRecord(body) || !('data' in body)) {
            throw invalid(status);
        }

        return body.data;
    }

    function asMessage(value: unknown, status: number): MessageData {
        if (
            !isRecord(value) ||
            typeof value.ulid !== 'string' ||
            typeof value.seq !== 'number'
        ) {
            throw invalid(status);
        }

        return value as unknown as MessageData;
    }

    function asWs(value: unknown): WsConfig | null {
        return isRecord(value) &&
            typeof value.key === 'string' &&
            typeof value.host === 'string' &&
            typeof value.port === 'number' &&
            typeof value.scheme === 'string'
            ? (value as unknown as WsConfig)
            : null;
    }

    function asLimits(value: unknown): SessionLimits | null {
        if (!isRecord(value)) {
            return null;
        }

        const positive = (field: unknown): number | null =>
            typeof field === 'number' && Number.isFinite(field) && field > 0
                ? Math.floor(field)
                : null;
        const limits: SessionLimits = {
            maxMessageLength: positive(value.maxMessageLength),
            attachmentMaxBytes: positive(value.attachmentMaxBytes),
            attachmentMaxDimension: positive(value.attachmentMaxDimension),
            attachmentMaxPerMessage: positive(value.attachmentMaxPerMessage),
        };

        return Object.values(limits).some((limit) => limit !== null)
            ? limits
            : null;
    }

    function asSession(value: unknown, status: number): SessionResponse {
        if (
            !isRecord(value) ||
            typeof value.visitorToken !== 'string' ||
            typeof value.expiresAt !== 'string'
        ) {
            throw invalid(status);
        }

        return {
            visitorToken: value.visitorToken,
            expiresAt: value.expiresAt,
            conversation: asConversation(value.conversation),
            ws: asWs(value.ws),
            limits: asLimits(value.limits),
        };
    }

    function conversationOf(body: unknown, status: number): ConversationPublic {
        const conversation = asConversation(data(body, status));

        if (conversation === null) {
            throw invalid(status);
        }

        return conversation;
    }

    return {
        /* ------------------------------------------------------ widget */

        /** The resolved boot config (fresh categories with description / icon / colour, availability). */
        async getConfig(
            locale?: string,
            signal?: AbortSignal,
        ): Promise<Record<string, unknown>> {
            const { body, status } = await request(
                `/widgets/${widget}/config`,
                {
                    anonymous: true,
                    query: { locale },
                    signal,
                },
            );
            const value = data(body, status);

            if (!isRecord(value)) {
                throw invalid(status);
            }

            return value;
        },

        async getAvailability(
            signal?: AbortSignal,
        ): Promise<Record<string, unknown>> {
            const { body, status } = await request(
                `/widgets/${widget}/availability`,
                { anonymous: true, signal },
            );
            const value = data(body, status);

            if (!isRecord(value)) {
                throw invalid(status);
            }

            return value;
        },

        /* ---------------------------------------------------- session */

        /**
         * Creates a visitor session for this widget. With `resumeToken` the stored token is sent as the bearer and the server
         * ROTATES it: the response carries a NEW token (the old one is revoked), the still-open conversation (moved to the new
         * session) and the `ws` block. The caller must adopt and store the token that comes back.
         */
        async createSession(
            request_: CreateSessionRequest,
            resumeToken?: string,
        ): Promise<SessionResponse> {
            const { body, status } = await request(
                `/widgets/${widget}/sessions`,
                {
                    method: 'POST',
                    json: request_,
                    anonymous: resumeToken === undefined,
                    bearer: resumeToken,
                },
            );

            return asSession(data(body, status), status);
        },

        /**
         * The WhatsApp hand-off (P6): a code and the `wa.me` link that opens WhatsApp with it typed. A visitor who asks again for the same
         * topic while the ticket is live gets that ticket back. `409 whatsapp_unavailable` (no connected session), `403 feature_disabled`,
         * `422` (`details.category`), `429`.
         */
        async whatsappHandoff(
            request_: HandoffRequest = {},
        ): Promise<HandoffResponse> {
            const { body, status } = await request(
                `/widgets/${widget}/whatsapp-handoff`,
                { method: 'POST', json: request_ },
            );
            const value = data(body, status);

            if (
                !isRecord(value) ||
                typeof value.code !== 'string' ||
                typeof value.waUrl !== 'string' ||
                typeof value.expiresAt !== 'string'
            ) {
                throw invalid(status);
            }

            return {
                code: value.code,
                waUrl: value.waUrl,
                expiresAt: value.expiresAt,
            };
        },

        /** Revokes the current token (best effort by the caller). */
        async revokeSession(): Promise<void> {
            await request('/sessions', { method: 'DELETE' });
        },

        /* ------------------------------------------------ conversation */

        /** The session's current conversation, or `null`. Visitors never list history. */
        async getConversation(
            signal?: AbortSignal,
        ): Promise<ConversationPublic | null> {
            const { body, status } = await request('/conversation', {
                signal,
            });

            return asConversation(data(body, status));
        },

        async createConversation(
            request_: CreateConversationRequest,
        ): Promise<ConversationPublic> {
            const { body, status } = await request('/conversations', {
                method: 'POST',
                json: request_,
            });

            return conversationOf(body, status);
        },

        async createOfflineTicket(
            request_: OfflineTicketRequest,
        ): Promise<ConversationPublic> {
            const { body, status } = await request('/offline-tickets', {
                method: 'POST',
                json: request_,
            });

            return conversationOf(body, status);
        },

        async listMessages(
            conversation: string,
            query: { afterSeq?: number; limit?: number } = {},
            signal?: AbortSignal,
        ): Promise<MessagesPage> {
            const { body, status } = await request(
                `/conversations/${encodeURIComponent(conversation)}/messages`,
                {
                    query: { after_seq: query.afterSeq, limit: query.limit },
                    signal,
                },
            );
            const list = data(body, status);

            if (!Array.isArray(list)) {
                throw invalid(status);
            }

            const meta = isRecord(body) && isRecord(body.meta) ? body.meta : {};

            return {
                messages: list.map((item) => asMessage(item, status)),
                nextCursor:
                    typeof meta.next_cursor === 'string'
                        ? meta.next_cursor
                        : null,
            };
        },

        /** Idempotent through `client_msg_id`: a replay answers `200` with the original (`replayed: true`). */
        async sendMessage(
            conversation: string,
            request_: SendMessageRequest,
            signal?: AbortSignal,
        ): Promise<SentMessage> {
            const { body, status } = await request(
                `/conversations/${encodeURIComponent(conversation)}/messages`,
                { method: 'POST', json: request_, safe: true, signal },
            );

            return {
                message: asMessage(data(body, status), status),
                replayed: status === 200,
            };
        },

        async sendReceipts(
            conversation: string,
            request_: ReceiptsRequest,
        ): Promise<void> {
            await request(
                `/conversations/${encodeURIComponent(conversation)}/receipts`,
                { method: 'POST', json: request_, safe: true },
            );
        },

        /** Fallback when whispers are unavailable. */
        async sendTyping(conversation: string, typing: boolean): Promise<void> {
            await request(
                `/conversations/${encodeURIComponent(conversation)}/typing`,
                { method: 'POST', json: { typing } },
            );
        },

        async endConversation(
            conversation: string,
        ): Promise<ConversationPublic> {
            const { body, status } = await request(
                `/conversations/${encodeURIComponent(conversation)}/end`,
                { method: 'POST' },
            );

            return conversationOf(body, status);
        },

        /** Leaves a `queued` chat (`closed`, reason `cancelled`). `409 conversation_not_queued` when an agent was first. */
        async cancelConversation(
            conversation: string,
        ): Promise<ConversationPublic> {
            const { body, status } = await request(
                `/conversations/${encodeURIComponent(conversation)}/cancel`,
                { method: 'POST' },
            );

            return conversationOf(body, status);
        },

        async rateConversation(
            conversation: string,
            request_: RatingRequest,
        ): Promise<void> {
            await request(
                `/conversations/${encodeURIComponent(conversation)}/rating`,
                { method: 'POST', json: request_ },
            );
        },

        /** Declines the rating prompt (`closed`, reason `skipped`). `409 conversation_not_ended` once the chat is closed already. */
        async skipRating(conversation: string): Promise<ConversationPublic> {
            const { body, status } = await request(
                `/conversations/${encodeURIComponent(conversation)}/rating/skip`,
                { method: 'POST' },
            );

            return conversationOf(body, status);
        },

        /**
         * Uploads one image (multipart `file`). XHR rather than `fetch` because only XHR reports upload progress. The returned
         * attachment is referenced from the next message by its `ulid`.
         */
        uploadAttachment(
            conversation: string,
            file: File | Blob,
            upload: UploadOptions = {},
        ): Promise<AttachmentData> {
            return new Promise((resolve, reject) => {
                const xhr = options.xhrFactory?.() ?? new XMLHttpRequest();
                const form = new FormData();
                form.append(
                    'file',
                    file,
                    file instanceof File ? file.name : 'image',
                );

                xhr.open(
                    'POST',
                    url(
                        `/conversations/${encodeURIComponent(conversation)}/attachments`,
                    ),
                );
                xhr.setRequestHeader('Accept', 'application/json');

                const token = options.token();

                if (token !== null) {
                    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                }

                xhr.upload.onprogress = (event: ProgressEvent): void => {
                    if (event.lengthComputable && event.total > 0) {
                        upload.onProgress?.(event.loaded / event.total);
                    }
                };
                xhr.timeout = options.uploadTimeoutMs ?? 90_000;
                xhr.onerror = xhr.ontimeout = (): void =>
                    reject(
                        new VisitorApiError({
                            status: 0,
                            code: 'network',
                            message: 'Upload failed.',
                        }),
                    );
                xhr.onabort = (): void => reject(abortError());
                xhr.onload = (): void => {
                    let parsed: unknown = null;

                    try {
                        parsed = JSON.parse(xhr.responseText) as unknown;
                    } catch {
                        // fall through to the status check
                    }

                    if (xhr.status >= 200 && xhr.status < 300) {
                        const value = isRecord(parsed) ? parsed.data : null;

                        if (
                            isRecord(value) &&
                            typeof value.ulid === 'string' &&
                            typeof value.url === 'string'
                        ) {
                            upload.onProgress?.(1);
                            resolve(value as unknown as AttachmentData);

                            return;
                        }

                        reject(invalid(xhr.status));

                        return;
                    }

                    const error =
                        isRecord(parsed) && isRecord(parsed.error)
                            ? parsed.error
                            : {};

                    reject(
                        new VisitorApiError({
                            status: xhr.status,
                            code:
                                typeof error.code === 'string'
                                    ? error.code
                                    : xhr.status === 413
                                      ? 'payload_too_large'
                                      : xhr.status === 429
                                        ? 'rate_limited'
                                        : 'server_error',
                            message:
                                typeof error.message === 'string'
                                    ? error.message
                                    : `Upload failed (${xhr.status}).`,
                            details: normaliseDetails(error.details),
                            retryAfter: parseRetryAfter(
                                xhr.getResponseHeader('Retry-After'),
                            ),
                        }),
                    );
                };

                if (upload.signal !== undefined) {
                    if (upload.signal.aborted) {
                        reject(abortError());

                        return;
                    }

                    upload.signal.addEventListener('abort', () => xhr.abort(), {
                        once: true,
                    });
                }

                xhr.send(form);
            });
        },
    };
}
