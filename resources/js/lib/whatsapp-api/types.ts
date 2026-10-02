/**
 * Request and response shapes of the WhatsApp management API that are not PHP Data classes (the session, chat and message payloads
 * are: `@/lib/whatsapp/types`). Everything here is what the UI sends or reads; the parsers in `client.ts` are tolerant (a missing
 * field takes its default, `camelCase` and `snake_case` spellings are both read) so a small difference in the server's spelling does
 * not blank a screen.
 */
import type {
    SessionStatus,
    WaChat,
    WaChatStatus,
    WaMessage,
    WaSessionRef,
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
    retentionDays: number;
    rawRetentionDays: number;
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
    retentionDays: { min: 0, max: 3650 },
    rawRetentionDays: { min: 0, max: 3650 },
    apiKeyMax: 255,
    /** `?q=` of the chat list (a longer one is a `422`). */
    searchMax: 200,
    /** The reply a message may carry (OpenWA accepts 1-4096 characters). */
    messageMax: 4096,
    /** Session names: letters, digits and hyphens, 3-50 characters (OpenWA's rule). */
    sessionName: { min: 3, max: 50, pattern: /^[A-Za-z0-9-]+$/ },
} as const;

/**
 * The result of "Test connection" (`POST /whatsapp/settings/test`, the SAVED address and key): the key's role, the engine and whether it
 * may operate (start sessions, send), or why it did not work (`reason`: `not_configured`, `blocked`, `unreachable`, `unauthorized`,
 * `rejected`, `unexpected_response`) with a one-sentence message.
 */
export type ConnectionTestResult =
    | {
          ok: true;
          role: string | null;
          engine: string | null;
          canOperate: boolean | null;
      }
    | { ok: false; reason: string; message: string };

/**
 * `GET /whatsapp/sessions/{ulid}/qr`: a base64 PNG data URL, served only while the session waits for a scan. In any other status the
 * server answers `409 qr_not_available` (`details.status`): the client turns that into `{ status, image: null }`.
 */
export type QrResult = {
    status: SessionStatus;
    image: string | null;
    /** When the picture was taken (`updatedAt`): a new one replaces it about every 20 seconds. */
    updatedAt: string | null;
};

export type WaChatListFilters = {
    status?: WaChatStatus | 'all';
    session?: string;
    widget?: string;
    category?: string;
    linked?: boolean;
    unread?: boolean;
    q?: string;
};

export type WaChatListQuery = WaChatListFilters & {
    cursor?: string | null;
    limit?: number;
};

export type WaChatPage = { chats: WaChat[]; nextCursor: string | null };

export type WaMessagesQuery = {
    /** The page after this message (a gap sync, the poll): `?after_id=`. */
    after?: string;
    /** The page before this message (scrolling up): `?before_id=`. */
    before?: string;
    limit?: number;
    signal?: AbortSignal;
};

/**
 * A page of a transcript, oldest first. `hasMore` says there is more in the direction that was asked for: older rows for the newest page
 * and for `before` (`meta.prev_cursor`), newer rows for `after` (`meta.next_cursor`).
 */
export type WaMessagePage = { messages: WaMessage[]; hasMore: boolean };

export type SendReplyInput = {
    /** The client-generated ULID that makes a retry recognisable. */
    clientMsgId: string;
    body: string;
};

/** The widget's WhatsApp link (`GET|PUT /widgets/{ulid}/whatsapp`): which session's number the hand-off offers (`null`: none). */
export type WidgetWhatsAppLink = {
    session: WaSessionRef | null;
    status: SessionStatus | null;
    maskedPhone: string | null;
    /** A `ready` session is linked: the hand-off works. */
    connected: boolean;
};

/** A session's own pacing (`PATCH /whatsapp/sessions/{ulid}`): `null` goes back to the global setting. */
export type SessionPacingInput = {
    sendMinIntervalMs?: number | null;
    dailySendCap?: number | null;
};
