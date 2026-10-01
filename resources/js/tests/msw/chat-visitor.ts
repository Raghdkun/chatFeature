/**
 * A stateful fake of the PUBLIC chat API (docs/contracts/rest-shapes.md, "Public (visitor bearer)") for the embed panel's tests,
 * served through MSW. It follows the documented behaviour, not any implementation: session creation scoped to a widget, bearer
 * checks (`401 unauthenticated` / `401 session_revoked`), `409 no_agents`, `409 conversation_exists`, `409 conversation_not_active`,
 * idempotent `client_msg_id`, `after_seq` paging, `422` field errors, `429` with `Retry-After`, multipart uploads, the Pusher auth.
 *
 *   const backend = createVisitorBackend();
 *   const server = setupServer(...backend.handlers);
 *   backend.claim('Sam');   // what the realtime layer would push, but through REST state
 *
 * `calls` records every request (method, path, body, auth header) so tests can assert what the panel sent.
 */
import { http, HttpResponse, type HttpHandler } from 'msw';
import {
    fakeTime,
    makeConversationPublic,
    makeMessage,
} from '@/lib/chat/fixtures';
import type {
    AttachmentData,
    ConversationPublic,
    MessageData,
} from '@/lib/chat/types';

export const API = 'https://chat.test/api/v1/public';
export const KEY = 'wk_testkey0000000000000';

export type RecordedCall = {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    auth: string | null;
};

export type BackendOptions = {
    /** `POST /conversations` answers `409 no_agents`. */
    noAgents?: boolean;
    /** Sessions come back without a `ws` block (Reverb not configured on the server). */
    noWs?: boolean;
    /** `POST /broadcasting/auth` answers `503 realtime_unavailable`. */
    noRealtimeAuth?: boolean;
    /** Required fields of `POST /conversations` besides `category` (server-side pre-chat rules). */
    requireName?: boolean;
    requireEmail?: boolean;
    /** What `GET /config` returns as `data` (the resolved boot config). */
    config?: Record<string, unknown>;
    availability?: Record<string, unknown>;
};

type Failure = {
    method: string;
    path: RegExp;
    status: number;
    body?: unknown;
    headers?: Record<string, string>;
    times: number;
};

const err = (
    status: number,
    code: string,
    message: string,
    details?: Record<string, string[]>,
    headers?: Record<string, string>,
) =>
    HttpResponse.json(
        { error: { code, message, ...(details ? { details } : {}) } },
        { status, headers },
    );

export function bootConfig(overrides: Record<string, unknown> = {}) {
    return {
        v: 1,
        key: KEY,
        configVersion: 3,
        generatedAt: '2026-11-20T10:00:00.000Z',
        locale: 'en',
        api: {
            base: API,
            embed: `https://chat.test/embed/${KEY}`,
            appOrigin: 'https://chat.test',
        },
        config: {
            v: 1,
            defaultLocale: 'en',
            localeDetect: true,
            theme: {
                mode: 'light',
                primary: '#0f766e',
                primaryText: '#ffffff',
                accent: '#f59e0b',
                surface: '#ffffff',
                text: '#0f172a',
                fontFamily: 'Inter, system-ui, sans-serif',
                fontUrl: null,
                radius: 16,
                shadow: 'soft',
                panelWidth: 380,
                panelHeight: 620,
            },
            launcher: {
                style: 'bubble',
                icon: 'chat',
                iconUrl: null,
                label: 'Chat with us',
                avatarUrl: null,
            },
            texts: {
                en: {
                    title: 'Support',
                    subtitle: 'We usually reply in a few minutes',
                    welcome: 'Hi! How can we help you today?',
                    categoryPrompt: 'What do you need help with?',
                    connecting: 'Connecting you to an agent…',
                    noAgents: 'No agent is available right now.',
                    offlineTitle: 'Leave us a message',
                    offlineBody: "We'll get back to you by email.",
                    placeholder: 'Type your message…',
                    send: 'Send',
                    attach: 'Attach image',
                    endChat: 'End chat',
                    ratingTitle: 'How was this chat?',
                    ratingPlaceholder: 'Add a comment (optional)',
                    thanks: 'Thanks for your feedback!',
                    startNewChat: 'Start a new chat',
                    poweredBy: 'Powered by PNE Chat',
                    closeChat: 'Close chat',
                    unread: 'unread messages',
                    dismiss: 'Dismiss',
                },
            },
            features: {
                attachments: true,
                rating: true,
                sounds: true,
                preChat: true,
                whatsapp: false,
                offlineForm: true,
                titleBadge: false,
                endChatByVisitor: true,
                poweredBy: true,
            },
            preChat: {
                fields: {
                    name: { enabled: true, required: true },
                    email: { enabled: true, required: false },
                    phone: { enabled: false, required: false },
                },
                consentText: null,
            },
            greetings: {
                enabled: true,
                onPageLoad: true,
                delaySeconds: 3,
                intervalMinutes: 30,
                autoHideSeconds: 180,
                dismissPolicy: 'session',
                showAgent: true,
            },
            hours: {
                mode: 'always_online',
                timezone: 'UTC',
                schedule: [],
                holidays: [],
            },
        },
        greetings: [],
        categories: [
            {
                slug: 'billing',
                label: 'Billing',
                description: 'Invoices and payments',
                icon: 'credit-card',
                color: '#7c3aed',
            },
            {
                slug: 'tech',
                label: 'Technical support',
                description: null,
                icon: null,
                color: null,
            },
        ],
        availability: {
            online: true,
            openNow: true,
            nextOpenAt: null,
            categories: [
                { slug: 'billing', online: true },
                { slug: 'tech', online: true },
            ],
            whatsapp: { enabled: false },
        },
        ...overrides,
    };
}

export function createVisitorBackend(options: BackendOptions = {}) {
    const state = {
        config: options.config ?? bootConfig(),
        availability:
            options.availability ??
            (bootConfig().availability as Record<string, unknown>),
        noAgents: options.noAgents ?? false,
        wsEnabled: !(options.noWs ?? false),
        realtimeAuth: !(options.noRealtimeAuth ?? false),
        requireName: options.requireName ?? false,
        requireEmail: options.requireEmail ?? false,
        /** token -> expiry; a token that is not here is unknown. */
        tokens: new Map<string, string>(),
        revoked: new Set<string>(),
        conversation: null as ConversationPublic | null,
        /** The token whose session owns `conversation` (a conversation belongs to the session that started it). */
        owner: null as string | null,
        /** The visitor-side name sent when the conversation was created. */
        visitor: { name: null as string | null, email: null as string | null },
        messages: [] as MessageData[],
        receipts: [] as { delivered_upto?: number; seen_upto?: number }[],
        tickets: [] as Record<string, unknown>[],
        ratings: [] as { score: number; comment?: string }[],
        attachments: new Map<string, AttachmentData>(),
        typing: [] as boolean[],
        sessionsCreated: 0,
        /** Tokens the server rotated (a returning bearer on session creation): old token -> the one that replaced it. */
        rotated: new Map<string, string>(),
        authorised: [] as string[],
    };
    const calls: RecordedCall[] = [];
    const failures: Failure[] = [];
    let counter = 0;

    const ws = {
        key: 'reverb-key',
        host: 'ws.chat.test',
        port: 443,
        scheme: 'https',
    };

    const record = async (request: Request): Promise<RecordedCall> => {
        const url = new URL(request.url);
        let body: unknown;

        if (request.method !== 'GET' && request.method !== 'DELETE') {
            const type = request.headers.get('content-type') ?? '';

            if (type.includes('application/json')) {
                body = await request.clone().json();
            } else if (type.includes('multipart/form-data')) {
                // undici cannot parse the FormData that jsdom's XHR serialises (its `File` is a different class): read the raw part.
                const raw = await request.clone().text();

                body = { file: /filename="([^"]*)"/.exec(raw)?.[1] ?? null };
            } else if (type.includes('x-www-form-urlencoded')) {
                body = Object.fromEntries(
                    new URLSearchParams(await request.clone().text()),
                );
            }
        }

        const call: RecordedCall = {
            method: request.method,
            path: url.pathname.replace('/api/v1/public', ''),
            query: Object.fromEntries(url.searchParams),
            body,
            auth: request.headers.get('authorization'),
        };

        calls.push(call);

        return call;
    };

    const bearer = (call: RecordedCall): string | Response => {
        const token = call.auth?.replace(/^Bearer /, '') ?? null;

        if (token === null) {
            return err(401, 'unauthenticated', 'Unauthenticated.');
        }

        if (state.revoked.has(token)) {
            return err(401, 'session_revoked', 'Session revoked.');
        }

        const expires = state.tokens.get(token);

        if (expires === undefined) {
            return err(401, 'unauthenticated', 'Unauthenticated.');
        }

        if (Date.parse(expires) < Date.now()) {
            return err(401, 'session_revoked', 'Session expired.');
        }

        return token;
    };

    const injected = (call: RecordedCall): Response | null => {
        const failure = failures.find(
            (f) =>
                f.times > 0 &&
                f.method === call.method &&
                f.path.test(call.path),
        );

        if (failure === undefined) {
            return null;
        }

        failure.times -= 1;

        return HttpResponse.json(
            failure.body ?? {
                error: { code: 'server_error', message: 'Boom' },
            },
            {
                status: failure.status,
                headers: failure.headers,
            },
        );
    };

    const token = (): string => `vt_${String(++counter).padStart(40, '0')}`;
    const isOpen = (): boolean =>
        state.conversation !== null &&
        (state.conversation.status === 'queued' ||
            state.conversation.status === 'active');
    const mine = (who: string): boolean => state.owner === who;

    const message = (
        sender: MessageData['sender'],
        body: string | null,
        extra: Partial<MessageData> = {},
    ): MessageData => {
        const seq = state.messages.length + 1;
        const created = makeMessage({
            conversation: state.conversation?.ulid ?? 'conv',
            seq,
            ulid: `01MSG${String(seq).padStart(21, '0')}`,
            sender,
            type: sender.type === 'system' ? 'system' : 'text',
            body,
            createdAt: fakeTime(seq),
            ...extra,
        });

        state.messages.push(created);

        if (state.conversation !== null) {
            state.conversation = { ...state.conversation, lastSeq: seq };
        }

        return created;
    };

    const handlers: HttpHandler[] = [
        http.get(`${API}/widgets/:key/config`, async ({ request }) => {
            const call = await record(request);

            return (
                injected(call) ??
                HttpResponse.json(
                    {
                        data: {
                            ...state.config,
                            availability: state.availability,
                        },
                    },
                    { headers: { ETag: '"cfg"' } },
                )
            );
        }),

        http.get(`${API}/widgets/:key/availability`, async ({ request }) => {
            const call = await record(request);

            return (
                injected(call) ??
                HttpResponse.json({ data: state.availability })
            );
        }),

        http.post(
            `${API}/widgets/:key/sessions`,
            async ({ request, params }) => {
                const call = await record(request);

                if (params.key !== KEY) {
                    return err(404, 'widget_not_found', 'Widget not found.');
                }

                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                state.sessionsCreated += 1;

                const identity = (call.body as { identity_token?: string })
                    ?.identity_token;

                if (identity !== undefined && identity.startsWith('bad')) {
                    return err(
                        422,
                        'validation_failed',
                        'The given data was invalid.',
                        {
                            identity_token: [
                                'The identity could not be verified.',
                            ],
                        },
                    );
                }

                // A returning bearer is ROTATED: a new token, the old one revoked, a still-open chat moves to the new session.
                const returning = call.auth?.replace(/^Bearer /, '');

                if (
                    returning !== undefined &&
                    state.tokens.has(returning) &&
                    !state.revoked.has(returning)
                ) {
                    const next = token();
                    const nextExpiry = new Date(
                        Date.now() + 30 * 86_400_000,
                    ).toISOString();
                    const resumes = isOpen() && mine(returning);

                    state.tokens.set(next, nextExpiry);
                    state.revoked.add(returning);
                    state.rotated.set(returning, next);

                    if (resumes) {
                        state.owner = next;
                    }

                    return HttpResponse.json(
                        {
                            data: {
                                visitorToken: next,
                                expiresAt: nextExpiry,
                                conversation: resumes
                                    ? state.conversation
                                    : null,
                                ws: state.wsEnabled ? ws : null,
                            },
                        },
                        { status: 201 },
                    );
                }

                const fresh = token();
                const expiresAt = new Date(
                    Date.now() + 30 * 86_400_000,
                ).toISOString();

                state.tokens.set(fresh, expiresAt);

                return HttpResponse.json(
                    {
                        data: {
                            visitorToken: fresh,
                            expiresAt,
                            conversation: null,
                            ws: state.wsEnabled ? ws : null,
                        },
                    },
                    { status: 201 },
                );
            },
        ),

        http.delete(`${API}/sessions`, async ({ request }) => {
            const call = await record(request);
            const who = bearer(call);

            if (typeof who !== 'string') {
                return who;
            }

            state.revoked.add(who);

            return new HttpResponse(null, { status: 204 });
        }),

        http.get(`${API}/conversation`, async ({ request }) => {
            const call = await record(request);
            const forced = injected(call);

            if (forced !== null) {
                return forced;
            }

            const who = bearer(call);

            return typeof who === 'string'
                ? HttpResponse.json({
                      data: mine(who) ? state.conversation : null,
                  })
                : who;
        }),

        http.post(`${API}/conversations`, async ({ request }) => {
            const call = await record(request);
            const forced = injected(call);

            if (forced !== null) {
                return forced;
            }

            const who = bearer(call);

            if (typeof who !== 'string') {
                return who;
            }

            const body = (call.body ?? {}) as Record<string, string>;
            const errors: Record<string, string[]> = {};

            if (!body.category) {
                errors.category = ['The category field is required.'];
            }

            if (state.requireName && !body.name) {
                errors.name = ['The name field is required.'];
            }

            if (state.requireEmail && !body.email) {
                errors.email = ['The email field is required.'];
            }

            if (Object.keys(errors).length > 0) {
                return err(
                    422,
                    'validation_failed',
                    'The given data was invalid.',
                    errors,
                );
            }

            if (isOpen() && mine(who)) {
                return err(
                    409,
                    'conversation_exists',
                    'You already have an open chat.',
                );
            }

            if (state.noAgents) {
                return err(409, 'no_agents', 'No agent is available.');
            }

            state.owner = who;
            state.visitor = {
                name: body.name ?? null,
                email: body.email ?? null,
            };
            state.messages = [];
            state.conversation = makeConversationPublic({
                ulid: `01CONV${String(++counter).padStart(20, '0')}`,
                status: 'queued',
                category: { slug: body.category, label: body.category },
                createdAt: new Date().toISOString(),
                lastSeq: 0,
            });

            if (body.message) {
                message(
                    {
                        type: 'visitor',
                        name: body.name ?? null,
                        avatarUrl: null,
                    },
                    body.message,
                );
            }

            return HttpResponse.json(
                { data: state.conversation },
                { status: 201 },
            );
        }),

        http.post(`${API}/offline-tickets`, async ({ request }) => {
            const call = await record(request);
            const forced = injected(call);

            if (forced !== null) {
                return forced;
            }

            const who = bearer(call);

            if (typeof who !== 'string') {
                return who;
            }

            const body = (call.body ?? {}) as Record<string, string>;
            const errors: Record<string, string[]> = {};

            for (const field of ['name', 'email', 'message']) {
                if (!body[field]) {
                    errors[field] = [`The ${field} field is required.`];
                }
            }

            if (Object.keys(errors).length > 0) {
                return err(
                    422,
                    'validation_failed',
                    'The given data was invalid.',
                    errors,
                );
            }

            state.tickets.push(body);

            return HttpResponse.json(
                {
                    data: makeConversationPublic({
                        ulid: `01TICK${String(++counter).padStart(20, '0')}`,
                        ticketNo: 'T1CKET',
                        type: 'offline',
                        status: 'queued',
                        category: null,
                    }),
                },
                { status: 201 },
            );
        }),

        http.get(
            `${API}/conversations/:ulid/messages`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                if (state.conversation?.ulid !== params.ulid || !mine(who)) {
                    return err(404, 'not_found', 'Not found.');
                }

                const after = Number(call.query.after_seq ?? 0);
                const limit = Number(call.query.limit ?? 100);
                const page = state.messages
                    .filter((m) => m.seq > after)
                    .slice(0, limit);
                const more =
                    state.messages.filter((m) => m.seq > after).length >
                    page.length;

                return HttpResponse.json({
                    data: page,
                    meta: {
                        next_cursor: more
                            ? String(page.at(-1)?.seq ?? 0)
                            : null,
                    },
                });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/messages`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                if (state.conversation?.ulid !== params.ulid || !mine(who)) {
                    return err(404, 'not_found', 'Not found.');
                }

                const body = call.body as {
                    client_msg_id?: string;
                    body?: string;
                    attachments?: string[];
                };

                if (
                    !body.client_msg_id ||
                    (!body.body && !body.attachments?.length)
                ) {
                    return err(422, 'validation_failed', 'Invalid.', {
                        body: ['A message needs text or an attachment.'],
                    });
                }

                const replay = state.messages.find(
                    (m) => m.clientMsgId === body.client_msg_id,
                );

                if (replay !== undefined) {
                    return HttpResponse.json({ data: replay }, { status: 200 });
                }

                if (state.conversation?.status !== 'active') {
                    return err(
                        409,
                        'conversation_not_active',
                        'This chat is not active.',
                    );
                }

                const created = message(
                    {
                        type: 'visitor',
                        name: state.visitor.name,
                        avatarUrl: null,
                    },
                    body.body ?? null,
                    {
                        clientMsgId: body.client_msg_id,
                        attachments: (body.attachments ?? []).flatMap((id) => {
                            const known = state.attachments.get(id);

                            return known ? [known] : [];
                        }),
                        type: body.attachments?.length ? 'image' : 'text',
                    },
                );

                return HttpResponse.json({ data: created }, { status: 201 });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/attachments`,
            async ({ request }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                const ulid = `01ATT${String(++counter).padStart(21, '0')}`;
                const attachment: AttachmentData = {
                    ulid,
                    mime: 'image/webp',
                    size: 1234,
                    width: 320,
                    height: 200,
                    url: `https://files.test/a/${ulid}?signature=x`,
                    thumbUrl: `https://files.test/a/${ulid}?thumb=1&signature=x`,
                };

                state.attachments.set(ulid, attachment);

                return HttpResponse.json({ data: attachment }, { status: 201 });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/receipts`,
            async ({ request }) => {
                const call = await record(request);
                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                state.receipts.push(
                    call.body as {
                        delivered_upto?: number;
                        seen_upto?: number;
                    },
                );

                return new HttpResponse(null, { status: 204 });
            },
        ),

        http.post(`${API}/conversations/:ulid/typing`, async ({ request }) => {
            const call = await record(request);
            const who = bearer(call);

            if (typeof who !== 'string') {
                return who;
            }

            state.typing.push((call.body as { typing: boolean }).typing);

            return new HttpResponse(null, { status: 204 });
        }),

        http.post(
            `${API}/conversations/:ulid/end`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                const current = state.conversation;

                if (
                    current === null ||
                    current.ulid !== params.ulid ||
                    !isOpen()
                ) {
                    return err(409, 'conversation_not_active', 'Not active.');
                }

                // Only an active chat is ended (a queued one is cancelled: `POST .../cancel`).
                if (current.status !== 'active') {
                    return err(409, 'conversation_not_active', 'Not active.');
                }

                state.conversation = {
                    ...current,
                    status: 'ended',
                    ratingRequested: true,
                    endedAt: new Date().toISOString(),
                };

                return HttpResponse.json({ data: state.conversation });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/cancel`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                const current = state.conversation;

                if (
                    current === null ||
                    current.ulid !== params.ulid ||
                    !mine(who)
                ) {
                    return err(404, 'not_found', 'Not found.');
                }

                if (current.status !== 'queued') {
                    return err(
                        409,
                        'conversation_not_queued',
                        'An agent was first.',
                    );
                }

                state.conversation = {
                    ...current,
                    status: 'closed',
                    endedAt: new Date().toISOString(),
                };

                return HttpResponse.json({ data: state.conversation });
            },
        ),

        http.post(
            `${API}/conversations/:ulid/rating`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                const rated = state.conversation;

                if (rated === null || rated.ulid !== params.ulid) {
                    return err(404, 'not_found', 'Not found.');
                }

                if (state.ratings.length > 0) {
                    return err(409, 'already_rated', 'Already rated.');
                }

                if (rated.status !== 'ended') {
                    return err(
                        409,
                        'conversation_not_ended',
                        'The chat has not ended.',
                    );
                }

                const body = call.body as { score: number; comment?: string };

                if (!(body.score >= 1 && body.score <= 5)) {
                    return err(422, 'validation_failed', 'Invalid.', {
                        score: ['Score must be 1 to 5.'],
                    });
                }

                state.ratings.push(body);
                state.conversation = { ...rated, status: 'closed' };

                return HttpResponse.json(
                    { data: { ok: true } },
                    { status: 201 },
                );
            },
        ),

        http.post(
            `${API}/conversations/:ulid/rating/skip`,
            async ({ request, params }) => {
                const call = await record(request);
                const forced = injected(call);

                if (forced !== null) {
                    return forced;
                }

                const who = bearer(call);

                if (typeof who !== 'string') {
                    return who;
                }

                const current = state.conversation;

                if (
                    current === null ||
                    current.ulid !== params.ulid ||
                    !mine(who)
                ) {
                    return err(404, 'not_found', 'Not found.');
                }

                if (current.status !== 'ended') {
                    return err(
                        409,
                        'conversation_not_ended',
                        'The chat has not ended.',
                    );
                }

                state.conversation = { ...current, status: 'closed' };

                return HttpResponse.json({ data: state.conversation });
            },
        ),

        http.post(`${API}/broadcasting/auth`, async ({ request }) => {
            const call = await record(request);
            const who = bearer(call);

            if (typeof who !== 'string') {
                return who;
            }

            if (!state.realtimeAuth) {
                return err(
                    503,
                    'realtime_unavailable',
                    'Live updates are not available right now.',
                );
            }

            const body = call.body as { channel_name?: string };

            if (
                body.channel_name !==
                `private-conversation.${state.conversation?.ulid}`
            ) {
                return err(403, 'forbidden', 'Forbidden.');
            }

            state.authorised.push(body.channel_name);

            return HttpResponse.json({ auth: 'reverb-key:signature' });
        }),
    ];

    return {
        handlers,
        state,
        calls,
        ws,

        /** Requests whose path ends with `suffix` (`/messages` matches `/conversations/{ulid}/messages`). */
        callsTo(method: string, suffix: string): RecordedCall[] {
            return calls.filter(
                (c) => c.method === method && c.path.endsWith(suffix),
            );
        },

        /** The next `times` matching requests fail with this status / body (once consumed, requests behave normally again). */
        fail(
            method: string,
            path: RegExp | string,
            status: number,
            body?: unknown,
            times = 1,
            headers?: Record<string, string>,
        ): void {
            failures.push({
                method,
                path: typeof path === 'string' ? new RegExp(path) : path,
                status,
                body,
                headers,
                times,
            });
        },

        /** A token the server knows and has not revoked (a session the loader could hand back). */
        issueToken(
            expiresAt = new Date(Date.now() + 86_400_000).toISOString(),
        ): {
            token: string;
            expiresAt: string;
        } {
            const issued = token();

            state.tokens.set(issued, expiresAt);

            return { token: issued, expiresAt };
        },

        revoke(tokenValue: string): void {
            state.revoked.add(tokenValue);
        },

        /** Server side: put a queued conversation in front of an agent. */
        claim(agentName = 'Sam'): ConversationPublic {
            if (state.conversation === null) {
                throw new Error('No conversation to claim.');
            }

            state.conversation = {
                ...state.conversation,
                status: 'active',
                agent: { name: agentName, avatarUrl: null },
            };
            message(
                { type: 'system', name: null, avatarUrl: null },
                `${agentName} joined the chat.`,
            );

            return state.conversation;
        },

        agentSays(body: string, extra: Partial<MessageData> = {}): MessageData {
            return message(
                {
                    type: 'agent',
                    name: state.conversation?.agent?.name ?? 'Sam',
                    avatarUrl: null,
                },
                body,
                extra,
            );
        },

        agentEnds(ratingRequested = true): void {
            if (state.conversation !== null) {
                state.conversation = {
                    ...state.conversation,
                    status: 'ended',
                    ratingRequested,
                    endedAt: new Date().toISOString(),
                };
            }
        },

        /** The queue timeout elapsed. */
        miss(): void {
            if (state.conversation !== null) {
                state.conversation = {
                    ...state.conversation,
                    status: 'missed',
                };
            }
        },

        close(): void {
            if (state.conversation !== null) {
                state.conversation = {
                    ...state.conversation,
                    status: 'closed',
                };
            }
        },

        /** Start a conversation without going through the panel (a stored session that has an open chat). */
        seedConversation(
            tokenValue: string,
            status: ConversationPublic['status'] = 'queued',
        ): ConversationPublic {
            state.tokens.set(
                tokenValue,
                state.tokens.get(tokenValue) ??
                    new Date(Date.now() + 86_400_000).toISOString(),
            );
            state.owner = tokenValue;
            state.messages = [];
            state.conversation = makeConversationPublic({
                ulid: `01CONV${String(++counter).padStart(20, '0')}`,
                status,
                createdAt: new Date(Date.now() - 20_000).toISOString(),
                agent:
                    status === 'active'
                        ? { name: 'Sam', avatarUrl: null }
                        : null,
                lastSeq: 0,
            });

            return state.conversation;
        },
    };
}

export type VisitorBackend = ReturnType<typeof createVisitorBackend>;
