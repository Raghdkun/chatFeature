/**
 * The WhatsApp management API (P6) as a test helper (no UI), written against `docs/rest-api.md` "WhatsApp API (P6)" (track 6A): admin only,
 * every path under `/api/v1/whatsapp`. Use it with the Sanctum-cookie `Api` of a saved login (`adminApi` fixture, `StaffActor.api.api`).
 *
 * Paths and shapes live HERE and nowhere else in the specs: when 6A changes a route, this is the one file to touch.
 */
import type { Api, ApiResult } from './api';

export type WaSessionStatus =
    | 'created'
    | 'starting'
    | 'qr'
    | 'ready'
    | 'disconnected'
    | 'failed';

/** `WhatsAppSessionData` (the fields the specs read). */
export type WaSession = {
    ulid: string;
    name: string;
    status: WaSessionStatus;
    phone: string | null;
    maskedPhone: string | null;
    qrAvailable: boolean;
    webhookRegistered: boolean;
    lastError: string | null;
};

/** `WaChatData` (the fields the specs read). */
export type WaChat = {
    ulid: string;
    phone: string | null;
    pushName: string | null;
    isGroup: boolean;
    linked: boolean;
    widget: { ulid: string; name: string } | null;
    category: { slug: string; label: string } | null;
    unreadByAdmin: number;
    inboundInitiated: boolean;
    lastMessagePreview: string | null;
};

/** `WaMessageData` (the fields the specs read). */
export type WaMessage = {
    ulid: string;
    direction: 'in' | 'out';
    type: string;
    body: string | null;
    status: 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'received';
    error: string | null;
};

export class WaAdminApi {
    constructor(readonly api: Api) {}

    sessions = () => this.api.get('/api/v1/whatsapp/sessions');
    createSession = (name: string) =>
        this.api.post('/api/v1/whatsapp/sessions', { name });
    session = (ulid: string) =>
        this.api.get(`/api/v1/whatsapp/sessions/${ulid}`);
    /** `202` with status `starting`: the engine starts in a queued job (inline in the e2e suite, `QUEUE_CONNECTION=sync`). */
    startSession = (ulid: string) =>
        this.api.post(`/api/v1/whatsapp/sessions/${ulid}/start`);
    stopSession = (ulid: string) =>
        this.api.post(`/api/v1/whatsapp/sessions/${ulid}/stop`);
    deleteSession = (ulid: string, force = false) =>
        this.api.delete(
            `/api/v1/whatsapp/sessions/${ulid}${force ? '?force=1' : ''}`,
        );
    sessionQr = (ulid: string) =>
        this.api.get(`/api/v1/whatsapp/sessions/${ulid}/qr`);
    syncSession = (ulid: string) =>
        this.api.post(`/api/v1/whatsapp/sessions/${ulid}/sync`);

    settings = () => this.api.get('/api/v1/whatsapp/settings');
    saveSettings = (body: Record<string, unknown>) =>
        this.api.put('/api/v1/whatsapp/settings', body);
    testSettings = () => this.api.post('/api/v1/whatsapp/settings/test');

    chats = (query: Record<string, string> = {}) =>
        this.api.get(
            `/api/v1/whatsapp/chats?${new URLSearchParams(query).toString()}`,
        );
    chat = (ulid: string) => this.api.get(`/api/v1/whatsapp/chats/${ulid}`);
    messages = (ulid: string) =>
        this.api.get(`/api/v1/whatsapp/chats/${ulid}/messages`);
    reply = (ulid: string, body: string, clientMsgId?: string) =>
        this.api.post(`/api/v1/whatsapp/chats/${ulid}/messages`, {
            body,
            ...(clientMsgId === undefined
                ? {}
                : { client_msg_id: clientMsgId }),
        });
    markRead = (ulid: string) =>
        this.api.post(`/api/v1/whatsapp/chats/${ulid}/read`);
    exportChats = () => this.api.get('/api/v1/whatsapp/export?format=json');

    /** Links a widget to a live session (or unlinks it with null). */
    linkWidget = (widgetUlid: string, sessionUlid: string | null) =>
        this.api.put(`/api/v1/widgets/${widgetUlid}/whatsapp`, {
            session: sessionUlid,
        });
}

/** The data of a result, or an error naming the call. */
export function data<T = any>(result: ApiResult, what: string): T {
    if (!result.ok) {
        throw new Error(
            `${what} failed: HTTP ${result.status} ${JSON.stringify(result.body)}`,
        );
    }

    return result.data as T;
}

/** Polls `read` until it returns something (not undefined / null / false): realtime and webhooks are asynchronous. */
export async function eventually<T>(
    read: () => Promise<T | undefined | null | false>,
    what: string,
    timeoutMs = 15_000,
): Promise<T> {
    const until = Date.now() + timeoutMs;

    for (;;) {
        const value = await read();

        if (value !== undefined && value !== null && value !== false) {
            return value;
        }

        if (Date.now() > until) {
            throw new Error(
                `Timed out after ${timeoutMs} ms waiting for ${what}.`,
            );
        }

        await new Promise((done) => setTimeout(done, 150));
    }
}
