/**
 * Typed client of the WhatsApp management API (admin only: an agent's call is `403`). Same transport as every dashboard call
 * (`@/lib/api-client`): session cookie + `X-XSRF-TOKEN`, `{ data }` / `{ error: { code, message, details? } }` envelopes, the 401 /
 * 419 / 429 handling. This file adds the request bodies the screens send, tolerant parsers for the few shapes that are not generated
 * PHP Data classes, and `describeWaError`, which turns the domain failures of this area into sentences.
 */
import {
    api,
    describeApiError,
    isApiError,
    type ApiClient,
} from '@/lib/api-client';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import {
    type ConnectionTestResult,
    type QrResult,
    type SendReplyInput,
    type SessionPacingInput,
    type WaChatListQuery,
    type WaChatPage,
    type WaMessagePage,
    type WaMessagesQuery,
    type WaSettings,
    type WaSettingsInput,
    type WidgetWhatsAppLink,
} from '@/lib/whatsapp-api/types';
import type {
    SessionStatus,
    WaChat,
    WaChatDetail,
    WaMessage,
    WhatsAppSession,
} from '@/lib/whatsapp/types';

type Wire = Record<string, unknown>;

const isRecord = (value: unknown): value is Wire =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** The first of several spellings of a key (`base_url`, `baseUrl`) that is present. */
function pick(source: Wire, ...keys: string[]): unknown {
    for (const key of keys) {
        if (key in source) {
            return source[key];
        }
    }

    return undefined;
}

const text = (value: unknown, fallback = ''): string =>
    typeof value === 'string' ? value : fallback;

const flag = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

const whole = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.trunc(value)
        : fallback;

/** The defaults of the `whatsapp.*` settings (`docs/contracts/whatsapp-data-p6.md`): what a field shows when the server says nothing. */
export const WA_SETTINGS_DEFAULTS: WaSettings = {
    enabled: false,
    baseUrl: 'http://127.0.0.1:2785',
    hasApiKey: false,
    handoffText: 'Hi! My support code is :code',
    handoffTtlMinutes: 1440,
    ignoreGroups: true,
    replyOnlyToInbound: true,
    sendMinIntervalMs: 1500,
    dailySendCap: 200,
    mediaMaxBytes: 5 * 1024 * 1024,
};

export function settingsFromWire(raw: unknown): WaSettings {
    const source = isRecord(raw) ? raw : {};
    const d = WA_SETTINGS_DEFAULTS;

    return {
        enabled: flag(pick(source, 'enabled'), d.enabled),
        baseUrl: text(pick(source, 'base_url', 'baseUrl'), d.baseUrl),
        hasApiKey: flag(
            pick(source, 'has_api_key', 'hasApiKey', 'api_key_saved'),
            d.hasApiKey,
        ),
        handoffText: text(
            pick(source, 'handoff_text', 'handoffText'),
            d.handoffText,
        ),
        handoffTtlMinutes: whole(
            pick(source, 'handoff_ttl_minutes', 'handoffTtlMinutes'),
            d.handoffTtlMinutes,
        ),
        ignoreGroups: flag(
            pick(source, 'ignore_groups', 'ignoreGroups'),
            d.ignoreGroups,
        ),
        replyOnlyToInbound: flag(
            pick(source, 'reply_only_to_inbound', 'replyOnlyToInbound'),
            d.replyOnlyToInbound,
        ),
        sendMinIntervalMs: whole(
            pick(source, 'send_min_interval_ms', 'sendMinIntervalMs'),
            d.sendMinIntervalMs,
        ),
        dailySendCap: whole(
            pick(source, 'daily_send_cap', 'dailySendCap'),
            d.dailySendCap,
        ),
        mediaMaxBytes: whole(
            pick(source, 'media_max_bytes', 'mediaMaxBytes'),
            d.mediaMaxBytes,
        ),
    };
}

/** The wire body of `PATCH /whatsapp/settings` (snake_case, like every request body of the management API). */
export function settingsBody(input: WaSettingsInput): Record<string, unknown> {
    const body: Record<string, unknown> = {};
    const map: [keyof WaSettingsInput, string][] = [
        ['enabled', 'enabled'],
        ['baseUrl', 'base_url'],
        ['handoffText', 'handoff_text'],
        ['handoffTtlMinutes', 'handoff_ttl_minutes'],
        ['ignoreGroups', 'ignore_groups'],
        ['replyOnlyToInbound', 'reply_only_to_inbound'],
        ['sendMinIntervalMs', 'send_min_interval_ms'],
        ['dailySendCap', 'daily_send_cap'],
        ['mediaMaxBytes', 'media_max_bytes'],
    ];

    for (const [key, wire] of map) {
        if (input[key] !== undefined) {
            body[wire] = input[key];
        }
    }

    // The key is write-only: a blank input is "keep what is stored", never "clear it".
    if (input.apiKey !== undefined && input.apiKey.trim() !== '') {
        body.api_key = input.apiKey.trim();
    }

    if (input.clearApiKey === true) {
        body.clear_api_key = true;
    }

    return body;
}

/** Only a base64 PNG / JPEG data URL is ever put into an `<img>` (the QR is a credential: nothing else may be shown as one). */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

const SESSION_STATUSES: readonly SessionStatus[] = [
    'created',
    'starting',
    'qr',
    'ready',
    'disconnected',
    'failed',
];

const asStatus = (value: unknown): SessionStatus | null =>
    typeof value === 'string' &&
    (SESSION_STATUSES as readonly string[]).includes(value)
        ? (value as SessionStatus)
        : null;

export function qrFromWire(raw: unknown): QrResult {
    const source = isRecord(raw) ? raw : {};
    const image = pick(source, 'qr', 'image', 'dataUrl', 'data_url');
    const updated = pick(source, 'updatedAt', 'updated_at');

    return {
        status: asStatus(pick(source, 'status')) ?? (image ? 'qr' : 'starting'),
        image:
            typeof image === 'string' && IMAGE_DATA_URL.test(image)
                ? image
                : null,
        updatedAt: typeof updated === 'string' ? updated : null,
    };
}

export function connectionResultFromWire(raw: unknown): ConnectionTestResult {
    const source = isRecord(raw) ? raw : {};

    if (flag(pick(source, 'ok'), false)) {
        const operate = pick(source, 'canOperate', 'can_operate');

        return {
            ok: true,
            role: typeof source.role === 'string' ? source.role : null,
            engine: typeof source.engine === 'string' ? source.engine : null,
            canOperate: typeof operate === 'boolean' ? operate : null,
        };
    }

    return {
        ok: false,
        reason: text(pick(source, 'reason', 'code', 'error'), 'unreachable'),
        message: text(pick(source, 'message'), ''),
    };
}

/** The widget link as `GET|PUT /widgets/{ulid}/whatsapp` answers it. */
export function widgetLinkFromWire(raw: unknown): WidgetWhatsAppLink {
    const source = isRecord(raw) ? raw : {};
    const session = isRecord(source.session) ? source.session : null;
    const masked = pick(source, 'maskedPhone', 'masked_phone');

    return {
        session:
            session !== null &&
            typeof session.ulid === 'string' &&
            typeof session.name === 'string'
                ? { ulid: session.ulid, name: session.name }
                : null,
        status: asStatus(pick(source, 'status')),
        maskedPhone: typeof masked === 'string' ? masked : null,
        connected: flag(pick(source, 'connected'), false),
    };
}

type Envelope<T> = {
    data: T;
    meta?: { next_cursor?: string | null; prev_cursor?: string | null };
};

function pageOf<T>(body: unknown): {
    rows: T[];
    next: string | null;
    prev: string | null;
} {
    if (!isRecord(body) || !Array.isArray(body.data)) {
        return { rows: [], next: null, prev: null };
    }

    const meta = isRecord(body.meta) ? body.meta : {};
    const cursor = (value: unknown): string | null =>
        typeof value === 'string' && value !== '' ? value : null;

    return {
        rows: body.data as T[],
        next: cursor(meta.next_cursor),
        prev: cursor(meta.prev_cursor),
    };
}

export function createWaApi(client: ApiClient = api) {
    return {
        /* -------------------------------------------------------- settings */

        settings: async (): Promise<WaSettings> =>
            settingsFromWire(
                await client.get<unknown>(waRoutes.api.settings()),
            ),

        saveSettings: async (input: WaSettingsInput): Promise<WaSettings> =>
            settingsFromWire(
                await client.put<unknown>(
                    waRoutes.api.settings(),
                    settingsBody(input),
                ),
            ),

        /**
         * Asks OpenWA (with the SAVED address and key) who the key is. A failure of OpenWA is a RESULT (`ok: false`, a reason and a
         * sentence): the card shows it next to the button. Only a failure of the app itself (`403`, `429` from the test limiter, a dropped
         * connection) is thrown.
         */
        testConnection: async (): Promise<ConnectionTestResult> => {
            try {
                return connectionResultFromWire(
                    await client.post<unknown>(waRoutes.api.connectionTest()),
                );
            } catch (error) {
                if (
                    isApiError(error) &&
                    error.status >= 400 &&
                    error.status !== 401 &&
                    error.status !== 403 &&
                    error.status !== 419 &&
                    error.status !== 429 &&
                    error.code !== 'network' &&
                    error.code !== 'server_error'
                ) {
                    return {
                        ok: false,
                        reason: error.code,
                        message: error.message,
                    };
                }

                throw error;
            }
        },

        /* --------------------------------------------------------- sessions */

        sessions: () => client.get<WhatsAppSession[]>(waRoutes.api.sessions()),

        createSession: (name: string) =>
            client.post<WhatsAppSession>(waRoutes.api.sessions(), { name }),

        startSession: (ulid: string) =>
            client.post<WhatsAppSession>(waRoutes.api.sessionStart(ulid)),

        stopSession: (ulid: string) =>
            client.post<WhatsAppSession>(waRoutes.api.sessionStop(ulid)),

        /**
         * `force`: delete it here even when OpenWA cannot be asked (the OpenWA session may then stay behind): offered only after a normal
         * delete failed with `openwa_unavailable`.
         */
        deleteSession: (ulid: string, force = false) =>
            client.delete<null>(waRoutes.api.session(ulid), {
                query: force ? { force: 1 } : undefined,
            }),

        /** Ask OpenWA what it knows and write that (status, number, last error). */
        syncSession: (ulid: string) =>
            client.post<WhatsAppSession>(waRoutes.api.sessionSync(ulid)),

        updateSessionPacing: (ulid: string, input: SessionPacingInput) =>
            client.patch<WhatsAppSession>(waRoutes.api.session(ulid), {
                ...(input.sendMinIntervalMs !== undefined
                    ? { send_min_interval_ms: input.sendMinIntervalMs }
                    : {}),
                ...(input.dailySendCap !== undefined
                    ? { daily_send_cap: input.dailySendCap }
                    : {}),
            }),

        /**
         * `no-store` on purpose. While the session is not waiting for a scan the server answers `409 qr_not_available`
         * (`details.status`): that is a result here (`{ status, image: null }`), the dialog uses it to follow the session to `ready`.
         */
        qr: async (ulid: string, signal?: AbortSignal): Promise<QrResult> => {
            try {
                return qrFromWire(
                    await client.get<unknown>(waRoutes.api.sessionQr(ulid), {
                        signal,
                        cache: 'no-store',
                    }),
                );
            } catch (error) {
                if (isApiError(error) && error.code === 'qr_not_available') {
                    return {
                        status:
                            asStatus(error.firstMessage('status')) ??
                            'starting',
                        image: null,
                        updatedAt: null,
                    };
                }

                throw error;
            }
        },

        /* ------------------------------------------------------------ chats */

        chats: async (query: WaChatListQuery = {}): Promise<WaChatPage> => {
            const body = await client.get<Envelope<WaChat[]>>(
                waRoutes.api.chats(),
                {
                    envelope: true,
                    query: {
                        status: query.status,
                        session: query.session,
                        widget: query.widget,
                        category: query.category,
                        linked:
                            query.linked === undefined
                                ? undefined
                                : query.linked
                                  ? 1
                                  : 0,
                        unread: query.unread ? 1 : undefined,
                        q: query.q === '' ? undefined : query.q,
                        cursor: query.cursor,
                        limit: query.limit,
                    },
                },
            );
            const { rows, next } = pageOf<WaChat>(body);

            return { chats: rows, nextCursor: next };
        },

        chat: (ulid: string) =>
            client.get<WaChatDetail>(waRoutes.api.chat(ulid)),

        messages: async (
            ulid: string,
            query: WaMessagesQuery = {},
        ): Promise<WaMessagePage> => {
            const limit = query.limit ?? 100;
            const body = await client.get<Envelope<WaMessage[]>>(
                waRoutes.api.chatMessages(ulid),
                {
                    envelope: true,
                    signal: query.signal,
                    query: {
                        after_id: query.after,
                        before_id: query.before,
                        limit,
                    },
                },
            );
            const { rows, next, prev } = pageOf<WaMessage>(body);

            return {
                messages: rows,
                // Always oldest first. More in the direction asked for: newer rows after `after`, older rows otherwise.
                hasMore:
                    query.after !== undefined ? next !== null : prev !== null,
            };
        },

        /** `201`: the stored reply (`pending` until OpenWA's acks arrive). Idempotent on `client_msg_id` when the server supports it. */
        sendMessage: (ulid: string, input: SendReplyInput) =>
            client.post<WaMessage>(waRoutes.api.chatMessages(ulid), {
                body: input.body,
                client_msg_id: input.clientMsgId,
            }),

        markRead: (ulid: string) =>
            client.post<WaChat | null>(waRoutes.api.chatRead(ulid)),

        archive: (ulid: string) =>
            client.post<WaChat>(waRoutes.api.chatArchive(ulid)),

        unarchive: (ulid: string) =>
            client.post<WaChat>(waRoutes.api.chatUnarchive(ulid)),

        /* ---------------------------------------------------------- widgets */

        widgetWhatsApp: async (
            widgetUlid: string,
        ): Promise<WidgetWhatsAppLink> =>
            widgetLinkFromWire(
                await client.get<unknown>(
                    waRoutes.api.widgetWhatsApp(widgetUlid),
                ),
            ),

        /** Link the widget to a live session (`null` unlinks it). `422` with `details.session` for an unknown or deleted one. */
        setWidgetWhatsApp: async (
            widgetUlid: string,
            sessionUlid: string | null,
        ): Promise<WidgetWhatsAppLink> =>
            widgetLinkFromWire(
                await client.put<unknown>(
                    waRoutes.api.widgetWhatsApp(widgetUlid),
                    { session: sessionUlid },
                ),
            ),
    };
}

export type WaApi = ReturnType<typeof createWaApi>;

/** The client the WhatsApp screens use (it resolves `fetch` lazily, so tests stub the global or run MSW). */
export const waApi: WaApi = createWaApi();

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** What went wrong, in the terms the screens react to (a hint, a field, a disabled composer). */
export type WaErrorKind =
    | 'session_not_ready'
    | 'daily_cap'
    | 'pacing'
    | 'not_inbound'
    | 'unreachable'
    | 'unauthorized_key'
    | 'webhook_rejected'
    | 'openwa_rejected'
    | 'session_state'
    | 'qr_not_available'
    | 'name_taken'
    | 'teardown_pending'
    | 'session_busy'
    | 'not_found'
    | 'rate_limited'
    | 'forbidden'
    | 'network'
    | 'validation'
    | 'other';

const CODES: Record<string, WaErrorKind> = {
    session_not_ready: 'session_not_ready',
    session_not_connected: 'session_not_ready',
    session_unavailable: 'session_not_ready',
    daily_cap_reached: 'daily_cap',
    daily_send_cap_reached: 'daily_cap',
    send_pacing_limited: 'pacing',
    pacing_limited: 'pacing',
    send_too_fast: 'pacing',
    reply_only_to_inbound: 'not_inbound',
    reply_not_allowed: 'not_inbound',
    chat_not_inbound_initiated: 'not_inbound',
    not_inbound_initiated: 'not_inbound',
    inbound_required: 'not_inbound',
    openwa_unavailable: 'unreachable',
    openwa_unreachable: 'unreachable',
    gateway_unavailable: 'unreachable',
    openwa_not_configured: 'unreachable',
    openwa_rejected: 'openwa_rejected',
    session_not_startable: 'session_state',
    session_not_stoppable: 'session_state',
    qr_not_available: 'qr_not_available',
    openwa_unauthorized: 'unauthorized_key',
    openwa_invalid_api_key: 'unauthorized_key',
    invalid_api_key: 'unauthorized_key',
    webhook_rejected: 'webhook_rejected',
    webhook_url_rejected: 'webhook_rejected',
    webhook_registration_failed: 'webhook_rejected',
    session_name_taken: 'name_taken',
    session_name_conflict: 'name_taken',
    session_exists: 'name_taken',
    openwa_session_exists: 'name_taken',
    session_name_teardown_pending: 'teardown_pending',
    session_busy: 'session_busy',
    session_in_use: 'session_busy',
    not_found: 'not_found',
    forbidden: 'forbidden',
    rate_limited: 'rate_limited',
    network: 'network',
};

/** Classify a failed call (case-insensitive: OpenWA's own codes are upper snake case and may be passed through as they are). */
export function classifyWaError(error: unknown): WaErrorKind {
    if (!isApiError(error)) {
        return 'other';
    }

    const known = CODES[error.code.toLowerCase()];

    if (known !== undefined) {
        return known;
    }

    if (error.isValidation) {
        return 'validation';
    }

    if (error.status === 403) {
        return 'forbidden';
    }

    if (error.status === 404) {
        return 'not_found';
    }

    if (error.status === 429) {
        return 'rate_limited';
    }

    return 'other';
}

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

/** "2 hours", "45 seconds": a wait in the largest unit that fits, written by `Intl` in the viewer's language. */
export function waitLabel(seconds: number, locale = 'en'): string {
    const s = Math.max(1, Math.ceil(seconds));
    const [value, unit] =
        s >= 3600
            ? ([Math.ceil(s / 3600), 'hour'] as const)
            : s >= 60
              ? ([Math.ceil(s / 60), 'minute'] as const)
              : ([s, 'second'] as const);

    try {
        return new Intl.NumberFormat(locale, {
            style: 'unit',
            unit,
            unitDisplay: 'long',
        }).format(value);
    } catch {
        return `${value} ${unit}${value === 1 ? '' : 's'}`;
    }
}

/** A sentence for a failed WhatsApp action: this area's domain failures first, then the shared transport / validation texts. */
export function describeWaError(
    error: unknown,
    t: Translate,
    locale = 'en',
): string {
    const kind = classifyWaError(error);

    switch (kind) {
        case 'session_not_ready':
            return t('whatsapp.error.session_not_ready');
        case 'daily_cap':
            return t('whatsapp.error.daily_cap');
        case 'pacing':
            return isApiError(error) && error.retryAfter !== null
                ? t('whatsapp.error.pacing_after', {
                      wait: waitLabel(error.retryAfter, locale),
                  })
                : t('whatsapp.error.pacing');
        case 'not_inbound':
            return t('whatsapp.error.not_inbound');
        case 'unreachable':
            return t('whatsapp.error.unreachable');
        case 'unauthorized_key':
            return t('whatsapp.error.unauthorized_key');
        case 'webhook_rejected':
            return t('whatsapp.error.webhook_rejected');
        case 'openwa_rejected':
            return t('whatsapp.error.openwa_rejected');
        case 'session_state':
            return t('whatsapp.error.session_state');
        case 'qr_not_available':
            return t('whatsapp.error.qr_not_available');
        case 'name_taken':
            return t('whatsapp.error.name_taken');
        case 'teardown_pending':
            return t('whatsapp.error.teardown_pending');
        case 'session_busy':
            return t('whatsapp.error.session_busy');
        case 'not_found':
            return t('whatsapp.error.not_found');
    }

    return describeApiError(error, t);
}
