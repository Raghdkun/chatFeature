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
    type WaChatListQuery,
    type WaChatPage,
    type WaMessagePage,
    type WaMessagesQuery,
    type WaSettings,
    type WaSettingsInput,
    type WidgetWhatsApp,
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
        body.api_key = null;
    }

    return body;
}

/** Only a base64 PNG / JPEG data URL is ever put into an `<img>` (the QR is a credential: nothing else may be shown as one). */
const IMAGE_DATA_URL = /^data:image\/(?:png|jpeg);base64,[A-Za-z0-9+/]+={0,2}$/;

export function qrFromWire(raw: unknown): QrResult {
    const source = isRecord(raw) ? raw : {};
    const image = pick(source, 'qr', 'image', 'dataUrl', 'data_url');
    const status = pick(source, 'status');

    return {
        status:
            typeof status === 'string'
                ? (status as SessionStatus)
                : image
                  ? 'qr'
                  : 'starting',
        image:
            typeof image === 'string' && IMAGE_DATA_URL.test(image)
                ? image
                : null,
        expiresAt:
            typeof pick(source, 'expires_at', 'expiresAt') === 'string'
                ? (pick(source, 'expires_at', 'expiresAt') as string)
                : null,
    };
}

export function connectionResultFromWire(raw: unknown): ConnectionTestResult {
    const source = isRecord(raw) ? raw : {};

    if (flag(pick(source, 'ok', 'success', 'valid'), false)) {
        return {
            ok: true,
            role: typeof source.role === 'string' ? source.role : null,
            engine: typeof source.engine === 'string' ? source.engine : null,
        };
    }

    return {
        ok: false,
        code: text(pick(source, 'code', 'error'), 'connection_failed'),
        message: text(pick(source, 'message', 'reason'), ''),
    };
}

type Envelope<T> = { data: T; meta?: { next_cursor?: string | null } };

function pageOf<T>(body: unknown): { rows: T[]; next: string | null } {
    if (!isRecord(body) || !Array.isArray(body.data)) {
        return { rows: [], next: null };
    }

    const meta = isRecord(body.meta) ? body.meta : {};

    return {
        rows: body.data as T[],
        next:
            typeof meta.next_cursor === 'string' && meta.next_cursor !== ''
                ? meta.next_cursor
                : null,
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
                await client.patch<unknown>(
                    waRoutes.api.settings(),
                    settingsBody(input),
                ),
            ),

        /**
         * Asks OpenWA (with the SAVED address and key) who the key is. A failure is a result, not an exception: the card shows the
         * reason next to the button. Only a failure of the app itself (`403`, a dropped connection) is thrown.
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
                        code: error.code,
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

        deleteSession: (ulid: string) =>
            client.delete<null>(waRoutes.api.session(ulid)),

        /** `no-store` on purpose; a `400`-like answer while the session is not waiting for a scan is `{status, image: null}`. */
        qr: async (ulid: string, signal?: AbortSignal): Promise<QrResult> =>
            qrFromWire(
                await client.get<unknown>(waRoutes.api.sessionQr(ulid), {
                    signal,
                    cache: 'no-store',
                }),
            ),

        /* ------------------------------------------------------------ chats */

        chats: async (query: WaChatListQuery = {}): Promise<WaChatPage> => {
            const body = await client.get<Envelope<WaChat[]>>(
                waRoutes.api.chats(),
                {
                    envelope: true,
                    query: {
                        status: query.status,
                        session: query.session,
                        linked:
                            query.linked === undefined
                                ? undefined
                                : query.linked
                                  ? 1
                                  : 0,
                        unread: query.unread ? 1 : undefined,
                        q: query.q === '' ? undefined : query.q,
                        sort: query.sort,
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
            const limit = query.limit ?? 50;
            const body = await client.get<Envelope<WaMessage[]>>(
                waRoutes.api.chatMessages(ulid),
                {
                    envelope: true,
                    signal: query.signal,
                    query: {
                        after: query.after,
                        before: query.before,
                        limit,
                    },
                },
            );
            const { rows, next } = pageOf<WaMessage>(body);

            return {
                messages: rows,
                // A full page, or a cursor, says there is more beyond it.
                hasMore: next !== null || rows.length >= limit,
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

        widgetWhatsApp: async (widgetUlid: string): Promise<WidgetWhatsApp> => {
            const raw = await client.get<unknown>(
                waRoutes.api.widgetWhatsApp(widgetUlid),
            );
            const source = isRecord(raw) ? raw : {};
            const session = pick(source, 'session_ulid', 'sessionUlid');

            return {
                sessionUlid: typeof session === 'string' ? session : null,
            };
        },

        setWidgetWhatsApp: async (
            widgetUlid: string,
            sessionUlid: string | null,
        ): Promise<WidgetWhatsApp> => {
            const raw = await client.put<unknown>(
                waRoutes.api.widgetWhatsApp(widgetUlid),
                { session_ulid: sessionUlid },
            );
            const source = isRecord(raw) ? raw : {};
            const session = pick(source, 'session_ulid', 'sessionUlid');

            return {
                sessionUlid:
                    typeof session === 'string' ? session : sessionUlid,
            };
        },
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
    chat_not_inbound_initiated: 'not_inbound',
    not_inbound_initiated: 'not_inbound',
    inbound_required: 'not_inbound',
    openwa_unavailable: 'unreachable',
    openwa_unreachable: 'unreachable',
    gateway_unavailable: 'unreachable',
    openwa_not_configured: 'unreachable',
    openwa_unauthorized: 'unauthorized_key',
    openwa_invalid_api_key: 'unauthorized_key',
    invalid_api_key: 'unauthorized_key',
    webhook_rejected: 'webhook_rejected',
    webhook_url_rejected: 'webhook_rejected',
    webhook_registration_failed: 'webhook_rejected',
    session_name_taken: 'name_taken',
    session_name_conflict: 'name_taken',
    session_exists: 'name_taken',
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
