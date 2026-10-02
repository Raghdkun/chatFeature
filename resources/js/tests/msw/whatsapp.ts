/**
 * A stateful fake of the WhatsApp management API (admin only), as MSW handlers: the paths of `@/lib/whatsapp-api/routes`, the `{ data }` /
 * `{ data, meta: { next_cursor } }` / `{ error }` envelopes and the failure codes the screens react to. Deliberately small: it knows
 * what the WhatsApp screens ask, not the domain.
 *
 *   const backend = createWaBackend({ chats: [...], sessions: [...] });
 *   server.use(...backend.handlers);
 */
import { http, HttpResponse } from 'msw';
import { fakeTime, fakeUlid } from '@/lib/chat/fixtures';
import { WA_SETTINGS_DEFAULTS } from '@/lib/whatsapp-api/client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaSettings } from '@/lib/whatsapp-api/types';
import {
    makeWaChatDetail,
    makeWaReply,
    makeWaSession,
} from '@/lib/whatsapp/fixtures';
import type {
    WaChat,
    WaChatDetail,
    WaMessage,
    WhatsAppSession,
} from '@/lib/whatsapp/types';

export type RecordedWaCall = {
    method: string;
    path: string;
    query: Record<string, string>;
    body: unknown;
    headers: Record<string, string>;
};

export type WaBackendOptions = {
    me?: { id: number; name: string };
    settings?: Partial<WaSettings>;
    sessions?: WhatsAppSession[];
    chats?: WaChat[];
    details?: Record<string, WaChatDetail>;
    messages?: Record<string, WaMessage[]>;
    /** ulid of a session -> the widget link (`GET /widgets/{ulid}/whatsapp`). */
    widgetLinks?: Record<string, string | null>;
};

function envelopeError(
    code: string,
    message: string,
    status: number,
    extra: {
        details?: Record<string, unknown>;
        headers?: Record<string, string>;
    } = {},
) {
    return HttpResponse.json(
        {
            error: {
                code,
                message,
                ...(extra.details ? { details: extra.details } : {}),
            },
        },
        { status, headers: extra.headers },
    );
}

export function createWaBackend(options: WaBackendOptions = {}) {
    const me = options.me ?? { id: 1, name: 'Ada' };
    const state = {
        me,
        settings: {
            ...WA_SETTINGS_DEFAULTS,
            ...options.settings,
        } as WaSettings,
        sessions: new Map<string, WhatsAppSession>(
            (options.sessions ?? []).map((s) => [s.ulid, s]),
        ),
        chats: new Map<string, WaChat>(
            (options.chats ?? []).map((c) => [c.ulid, c]),
        ),
        details: new Map<string, WaChatDetail>(
            Object.entries(options.details ?? {}),
        ),
        messages: new Map<string, WaMessage[]>(
            Object.entries(options.messages ?? {}),
        ),
        widgetLinks: new Map<string, string | null>(
            Object.entries(options.widgetLinks ?? {}),
        ),
        /** What `POST connection/test` answers (the OpenWA key's role and engine), or a failure. */
        connection: {
            ok: true,
            role: 'admin',
            engine: 'whatsapp-web.js',
        } as
            | { ok: true; role: string; engine: string }
            | { ok: false; code: string; message: string },
        /** ulid of a session -> the QR picture the poll answers (cleared = no code yet). */
        qr: new Map<string, string | null>(),
        /** Session ulids whose QR poll answers `ready` (the scan happened). */
        scanned: new Set<string>(),
        /** The next N reply sends answer this error. */
        failSends: [] as {
            status: number;
            code: string;
            message?: string;
            retryAfter?: number;
        }[],
        /** Answer every call as if the network were down. */
        offline: false,
        /** Every failing call answers `403` (an agent). */
        forbidden: false,
        /** The next create-session call answers this error. */
        createError: null as { status: number; code: string } | null,
        calls: [] as RecordedWaCall[],
        nextSession: 0,
    };

    const record = (request: Request, body?: unknown): RecordedWaCall => {
        const url = new URL(request.url);
        const call: RecordedWaCall = {
            method: request.method,
            path: url.pathname,
            query: Object.fromEntries(url.searchParams),
            body,
            headers: Object.fromEntries(request.headers),
        };

        state.calls.push(call);

        return call;
    };

    const bodyOf = async (
        request: Request,
    ): Promise<Record<string, unknown>> => {
        try {
            return (await request.json()) as Record<string, unknown>;
        } catch {
            return {};
        }
    };

    const down = () =>
        state.forbidden
            ? envelopeError(
                  'forbidden',
                  'Only administrators can do this.',
                  403,
              )
            : state.offline
              ? HttpResponse.error()
              : null;

    const messagesOf = (ulid: string): WaMessage[] =>
        state.messages.get(ulid) ?? [];

    const notFound = () => envelopeError('not_found', 'Not found.', 404);
    /** A route template for MSW: `route(waRoutes.api.session)` -> `/api/v1/whatsapp/sessions/:ulid`. */
    const api = (path: string) => path;
    const route = (build: (id: string) => string): string =>
        build('__ID__').replace('__ID__', ':ulid');

    const handlers = [
        http.get(api(waRoutes.api.settings()), ({ request }) => {
            record(request);

            return (
                down() ?? HttpResponse.json({ data: toWire(state.settings) })
            );
        }),

        http.patch(api(waRoutes.api.settings()), async ({ request }) => {
            const body = await bodyOf(request);

            record(request, body);

            const outage = down();

            if (outage) {
                return outage;
            }

            const errors: Record<string, string[]> = {};

            if (
                typeof body.handoff_text === 'string' &&
                !body.handoff_text.includes(':code')
            ) {
                errors.handoff_text = ['The hand-off text must contain :code.'];
            }

            if (
                typeof body.daily_send_cap === 'number' &&
                (body.daily_send_cap < 1 || body.daily_send_cap > 10_000)
            ) {
                errors.daily_send_cap = [
                    'The daily send cap must be between 1 and 10000.',
                ];
            }

            if (
                typeof body.base_url === 'string' &&
                body.base_url.includes('?')
            ) {
                errors.base_url = [
                    'The OpenWA address must be a plain address.',
                ];
            }

            if (Object.keys(errors).length > 0) {
                return envelopeError('validation_failed', 'Invalid.', 422, {
                    details: errors,
                });
            }

            const next = { ...state.settings };

            if (typeof body.enabled === 'boolean') {
                next.enabled = body.enabled;
            }

            if (typeof body.base_url === 'string') {
                next.baseUrl = body.base_url;
            }

            if (typeof body.handoff_text === 'string') {
                next.handoffText = body.handoff_text;
            }

            if (typeof body.handoff_ttl_minutes === 'number') {
                next.handoffTtlMinutes = body.handoff_ttl_minutes;
            }

            if (typeof body.ignore_groups === 'boolean') {
                next.ignoreGroups = body.ignore_groups;
            }

            if (typeof body.reply_only_to_inbound === 'boolean') {
                next.replyOnlyToInbound = body.reply_only_to_inbound;
            }

            if (typeof body.send_min_interval_ms === 'number') {
                next.sendMinIntervalMs = body.send_min_interval_ms;
            }

            if (typeof body.daily_send_cap === 'number') {
                next.dailySendCap = body.daily_send_cap;
            }

            if (typeof body.media_max_bytes === 'number') {
                next.mediaMaxBytes = body.media_max_bytes;
            }

            if ('api_key' in body) {
                next.hasApiKey = body.api_key !== null;
            }

            state.settings = next;

            return HttpResponse.json({ data: toWire(next) });
        }),

        http.post(api(waRoutes.api.connectionTest()), ({ request }) => {
            record(request);

            return down() ?? HttpResponse.json({ data: state.connection });
        }),

        http.get(api(waRoutes.api.sessions()), ({ request }) => {
            record(request);

            return (
                down() ??
                HttpResponse.json({ data: [...state.sessions.values()] })
            );
        }),

        http.post(api(waRoutes.api.sessions()), async ({ request }) => {
            const body = await bodyOf(request);

            record(request, body);

            const outage = down();

            if (outage) {
                return outage;
            }

            if (state.createError) {
                const { status, code } = state.createError;

                state.createError = null;

                return envelopeError(
                    code,
                    'Could not create the session.',
                    status,
                );
            }

            const name = typeof body.name === 'string' ? body.name : '';

            if (!/^[A-Za-z0-9-]{3,50}$/.test(name)) {
                return envelopeError('validation_failed', 'Invalid.', 422, {
                    details: {
                        name: [
                            'The name may only contain letters, digits and hyphens (3-50).',
                        ],
                    },
                });
            }

            if ([...state.sessions.values()].some((s) => s.name === name)) {
                return envelopeError(
                    'session_name_taken',
                    'A session with this name exists.',
                    409,
                );
            }

            state.nextSession += 1;

            const session = makeWaSession({
                ulid: fakeUlid(8000 + state.nextSession),
                name,
                status: 'created',
                phone: null,
                maskedPhone: null,
                pushName: null,
                webhookRegistered: false,
                readyAt: null,
            });

            state.sessions.set(session.ulid, session);

            return HttpResponse.json({ data: session }, { status: 201 });
        }),

        http.post(route(waRoutes.api.sessionStart), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const session = state.sessions.get(String(params.ulid));

            if (!session) {
                return notFound();
            }

            const next: WhatsAppSession = {
                ...session,
                status: 'starting',
                lastError: null,
                webhookRegistered: true,
            };

            state.sessions.set(next.ulid, next);

            return HttpResponse.json({ data: next });
        }),

        http.post(route(waRoutes.api.sessionStop), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const session = state.sessions.get(String(params.ulid));

            if (!session) {
                return notFound();
            }

            const next: WhatsAppSession = {
                ...session,
                status: 'disconnected',
            };

            state.sessions.set(next.ulid, next);

            return HttpResponse.json({ data: next });
        }),

        http.get(route(waRoutes.api.sessionQr), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const ulid = String(params.ulid);
            const session = state.sessions.get(ulid);

            if (!session) {
                return notFound();
            }

            if (state.scanned.has(ulid)) {
                const ready: WhatsAppSession = {
                    ...session,
                    status: 'ready',
                };

                state.sessions.set(ulid, ready);

                return HttpResponse.json(
                    { data: { status: 'ready', qr: null } },
                    { headers: { 'Cache-Control': 'no-store' } },
                );
            }

            const image = state.qr.get(ulid) ?? null;

            return HttpResponse.json(
                {
                    data: {
                        status: image === null ? session.status : 'qr',
                        qr: image,
                    },
                },
                { headers: { 'Cache-Control': 'no-store' } },
            );
        }),

        http.delete(route(waRoutes.api.session), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const ulid = String(params.ulid);

            if (!state.sessions.delete(ulid)) {
                return notFound();
            }

            return new HttpResponse(null, { status: 204 });
        }),

        http.get(api(waRoutes.api.chats()), ({ request }) => {
            const call = record(request);
            const outage = down();

            if (outage) {
                return outage;
            }

            const { status, session, linked, unread, q, limit, cursor } =
                call.query;
            let rows = [...state.chats.values()].filter(
                (chat) =>
                    (status === undefined ||
                        status === 'all' ||
                        chat.status === status) &&
                    (!session || chat.session.ulid === session) &&
                    (linked === undefined ||
                        chat.linked === (linked === '1')) &&
                    (!unread || chat.unreadByAdmin > 0) &&
                    (!q ||
                        [chat.phone, chat.pushName, chat.lastMessagePreview]
                            .join(' ')
                            .toLowerCase()
                            .includes(q.toLowerCase())),
            );

            rows = rows.sort((a, b) =>
                (b.lastMessageAt ?? '').localeCompare(a.lastMessageAt ?? ''),
            );

            const size = Number(limit ?? 50);
            const start = cursor ? Number(cursor) : 0;
            const page = rows.slice(start, start + size);
            const nextCursor =
                start + size < rows.length ? String(start + size) : null;

            return HttpResponse.json({
                data: page,
                meta: { next_cursor: nextCursor },
            });
        }),

        http.get(route(waRoutes.api.chat), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const ulid = String(params.ulid);
            const detail =
                state.details.get(ulid) ??
                (state.chats.has(ulid)
                    ? makeWaChatDetail({
                          chat: state.chats.get(ulid) as WaChat,
                      })
                    : null);

            return detail ? HttpResponse.json({ data: detail }) : notFound();
        }),

        http.get(route(waRoutes.api.chatMessages), ({ request, params }) => {
            const call = record(request);
            const outage = down();

            if (outage) {
                return outage;
            }

            const ulid = String(params.ulid);

            if (!state.chats.has(ulid)) {
                return notFound();
            }

            const all = [...messagesOf(ulid)].sort((a, b) =>
                a.createdAt.localeCompare(b.createdAt),
            );
            const limit = Number(call.query.limit ?? 50);
            let rows = all;

            if (call.query.after) {
                const index = all.findIndex((m) => m.ulid === call.query.after);

                rows = index === -1 ? all : all.slice(index + 1);
            } else if (call.query.before) {
                const index = all.findIndex(
                    (m) => m.ulid === call.query.before,
                );

                rows = (index === -1 ? all : all.slice(0, index)).slice(-limit);
            } else {
                rows = all.slice(-limit);
            }

            return HttpResponse.json({
                data: call.query.before ? rows : rows.slice(0, limit),
                meta: { next_cursor: null },
            });
        }),

        http.post(
            route(waRoutes.api.chatMessages),
            async ({ request, params }) => {
                const ulid = String(params.ulid);
                const body = await bodyOf(request);

                record(request, body);

                const outage = down();

                if (outage) {
                    return outage;
                }

                const failure = state.failSends.shift();

                if (failure) {
                    return envelopeError(
                        failure.code,
                        failure.message ?? 'Could not send.',
                        failure.status,
                        {
                            headers:
                                failure.retryAfter === undefined
                                    ? undefined
                                    : {
                                          'Retry-After': String(
                                              failure.retryAfter,
                                          ),
                                      },
                        },
                    );
                }

                const chat = state.chats.get(ulid);

                if (!chat) {
                    return notFound();
                }

                const text = typeof body.body === 'string' ? body.body : '';

                if (text.trim() === '' || text.length > 4096) {
                    return envelopeError('validation_failed', 'Invalid.', 422, {
                        details: {
                            body: ['The reply must be 1-4096 characters.'],
                        },
                    });
                }

                const clientId =
                    typeof body.client_msg_id === 'string'
                        ? body.client_msg_id
                        : '';
                const replay = messagesOf(ulid).find(
                    (m) =>
                        (m as WaMessage & { clientMsgId?: string })
                            .clientMsgId === clientId && clientId !== '',
                );

                if (replay) {
                    return HttpResponse.json({ data: replay }, { status: 200 });
                }

                const n = messagesOf(ulid).length + 1;
                const message: WaMessage & { clientMsgId?: string } = {
                    ...makeWaReply({
                        ulid: fakeUlid(9000 + n),
                        chat: ulid,
                        body: text,
                        status: 'pending',
                        createdAt: fakeTime(2000 + n),
                        waTimestamp: fakeTime(2000 + n),
                        sentBy: { id: me.id, name: me.name },
                    }),
                    clientMsgId: clientId,
                };

                state.messages.set(ulid, [...messagesOf(ulid), message]);
                state.chats.set(ulid, {
                    ...chat,
                    lastMessagePreview: text,
                    lastMessageAt: message.createdAt,
                });

                return HttpResponse.json({ data: message }, { status: 201 });
            },
        ),

        http.post(route(waRoutes.api.chatRead), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            const chat = state.chats.get(String(params.ulid));

            if (!chat) {
                return notFound();
            }

            const read = { ...chat, unreadByAdmin: 0 };

            state.chats.set(chat.ulid, read);

            return HttpResponse.json({ data: read });
        }),

        http.post(route(waRoutes.api.chatArchive), ({ request, params }) => {
            record(request);

            const chat = state.chats.get(String(params.ulid));

            if (!chat) {
                return notFound();
            }

            const archived: WaChat = { ...chat, status: 'archived' };

            state.chats.set(chat.ulid, archived);

            return down() ?? HttpResponse.json({ data: archived });
        }),

        http.post(route(waRoutes.api.chatUnarchive), ({ request, params }) => {
            record(request);

            const chat = state.chats.get(String(params.ulid));

            if (!chat) {
                return notFound();
            }

            const open: WaChat = { ...chat, status: 'open' };

            state.chats.set(chat.ulid, open);

            return down() ?? HttpResponse.json({ data: open });
        }),

        http.get(route(waRoutes.api.widgetWhatsApp), ({ request, params }) => {
            record(request);

            const outage = down();

            if (outage) {
                return outage;
            }

            return HttpResponse.json({
                data: {
                    session_ulid:
                        state.widgetLinks.get(String(params.ulid)) ?? null,
                },
            });
        }),

        http.put(
            route(waRoutes.api.widgetWhatsApp),
            async ({ request, params }) => {
                const body = await bodyOf(request);

                record(request, body);

                const outage = down();

                if (outage) {
                    return outage;
                }

                const session = body.session_ulid;

                if (
                    typeof session === 'string' &&
                    state.sessions.get(session)?.status !== 'ready'
                ) {
                    return envelopeError(
                        'session_not_ready',
                        'The session is not connected.',
                        409,
                    );
                }

                state.widgetLinks.set(
                    String(params.ulid),
                    typeof session === 'string' ? session : null,
                );

                return HttpResponse.json({
                    data: {
                        session_ulid:
                            typeof session === 'string' ? session : null,
                    },
                });
            },
        ),
    ];

    return { state, handlers };
}

export type WaBackend = ReturnType<typeof createWaBackend>;

/** The settings as the server spells them (snake_case); `has_api_key` instead of the key. */
function toWire(settings: WaSettings): Record<string, unknown> {
    return {
        enabled: settings.enabled,
        base_url: settings.baseUrl,
        has_api_key: settings.hasApiKey,
        handoff_text: settings.handoffText,
        handoff_ttl_minutes: settings.handoffTtlMinutes,
        ignore_groups: settings.ignoreGroups,
        reply_only_to_inbound: settings.replyOnlyToInbound,
        send_min_interval_ms: settings.sendMinIntervalMs,
        daily_send_cap: settings.dailySendCap,
        media_max_bytes: settings.mediaMaxBytes,
    };
}
