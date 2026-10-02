/**
 * Request and response shapes of the WhatsApp management API that are not PHP Data classes (the session, chat and message payloads
 * are: `@/lib/whatsapp/types`). Everything here is what the UI sends or reads; the parsers in `client.ts` are tolerant (a missing
 * field takes its default, `camelCase` and `snake_case` spellings are both read) so a small difference in the server's spelling does
 * not blank a screen.
 */
import type {
    SessionStatus,
    WaChat,
    WaMessage,
    WaChatStatus,
} from '@/lib/whatsapp/types';

/** The behaviour settings and the connection to OpenWA (`whatsapp.*`). The API key never comes back: only `hasApiKey`. */
export type WaSettings = {
    enabled: boolean;
    baseUrl: string;
    hasApiKey: boolean;
    handoffText: string;
    handoffTtlMinutes: number;
    ignoreGroups: boolean;
    replyOnlyToInbound: boolean;
    sendMinIntervalMs: number;
    dailySendCap: number;
    mediaMaxBytes: number;
};

/** What `PATCH /whatsapp/settings` takes: only the keys that changed. A blank `apiKey` is never sent (the stored one stays). */
export type WaSettingsInput = Partial<
    Omit<WaSettings, 'hasApiKey'> & { apiKey: string; clearApiKey: boolean }
>;

/** The limits the server validates the settings with (`docs/contracts/whatsapp-data-p6.md`, "Settings"); the form says them early. */
export const WA_LIMITS = {
    handoffTextMax: 200,
    handoffTtlMinutes: { min: 5, max: 10_080 },
    sendMinIntervalMs: { min: 0, max: 60_000 },
    dailySendCap: { min: 1, max: 10_000 },
    mediaMaxBytes: { min: 10 * 1024, max: 25 * 1024 * 1024 },
    apiKeyMax: 255,
    /** The reply a message may carry (OpenWA accepts 1-4096 characters). */
    messageMax: 4096,
    /** Session names: letters, digits and hyphens, 3-50 characters (OpenWA's rule). */
    sessionName: { min: 3, max: 50, pattern: /^[A-Za-z0-9-]+$/ },
} as const;

/** The result of "Test connection": the key's role and the engine, or why it did not work. */
export type ConnectionTestResult =
    | { ok: true; role: string | null; engine: string | null }
    | { ok: false; code: string; message: string };

/** `GET /whatsapp/sessions/{ulid}/qr`: the picture is a base64 PNG data URL, present only while the session waits for a scan. */
export type QrResult = {
    status: SessionStatus;
    image: string | null;
    /** When the code stops working, when the server knows. */
    expiresAt: string | null;
};

export type WaChatListFilters = {
    status?: WaChatStatus | 'all';
    session?: string;
    linked?: boolean;
    unread?: boolean;
    q?: string;
    sort?: 'recent' | 'unread';
};

export type WaChatListQuery = WaChatListFilters & {
    cursor?: string | null;
    limit?: number;
};

export type WaChatPage = { chats: WaChat[]; nextCursor: string | null };

export type WaMessagesQuery = {
    /** Messages newer than this one (a gap sync, the poll). */
    after?: string;
    /** Messages older than this one (scrolling up). */
    before?: string;
    limit?: number;
    signal?: AbortSignal;
};

/** A page of a transcript, oldest first; `hasMore` says there are older (`before`) or newer (`after`) rows beyond the page. */
export type WaMessagePage = { messages: WaMessage[]; hasMore: boolean };

export type SendReplyInput = {
    /** The client-generated ULID that makes a retry recognisable. */
    clientMsgId: string;
    body: string;
};

/** The widget's WhatsApp link: which session's number the hand-off offers (`null`: none). */
export type WidgetWhatsApp = { sessionUlid: string | null };
