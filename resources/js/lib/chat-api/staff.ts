/**
 * Typed client for the management chat API (docs/contracts/rest-shapes.md, "Management (Sanctum)"), as the agent dashboard calls it:
 * session cookie + `X-XSRF-TOKEN`, the `{ data }` / `{ error }` envelopes and their error mapping come from the shared api client.
 * Shapes are the generated PHP Data types (`@/lib/chat/types`); this file only adds the request bodies the UI sends and the
 * few domain errors a screen reacts to (`409 already_claimed {by}` -> "Taken by Sam").
 */
import {
    api,
    ApiError,
    describeApiError,
    isApiError,
    readXsrfToken,
    type ApiClient,
} from '@/lib/api-client';
import type {
    AttachmentData,
    ConversationStaff,
    MessageData,
    PresenceData,
    PresenceStatus,
} from '@/lib/chat/types';

const API = '/api/v1';
const enc = encodeURIComponent;

/** Every URL of this client and of the staff pages, in one place (no screen spells a path itself). */
export const staffRoutes = {
    pages: {
        dashboard: () => '/dashboard',
        inbox: () => '/inbox',
        conversation: (ulid: string) => `/inbox/${enc(ulid)}`,
        offlineTickets: () => '/offline-tickets',
        history: () => '/history',
    },
    api: {
        conversations: () => `${API}/conversations`,
        queue: () => `${API}/conversations/queue`,
        conversation: (ulid: string) => `${API}/conversations/${enc(ulid)}`,
        messages: (ulid: string) =>
            `${API}/conversations/${enc(ulid)}/messages`,
        claim: (ulid: string) => `${API}/conversations/${enc(ulid)}/claim`,
        attachments: (ulid: string) =>
            `${API}/conversations/${enc(ulid)}/attachments`,
        receipts: (ulid: string) =>
            `${API}/conversations/${enc(ulid)}/receipts`,
        end: (ulid: string) => `${API}/conversations/${enc(ulid)}/end`,
        close: (ulid: string) => `${API}/conversations/${enc(ulid)}/close`,
        transfer: (ulid: string) =>
            `${API}/conversations/${enc(ulid)}/transfer`,
        export: () => `${API}/conversations/export`,
        presence: () => `${API}/me/presence`,
        heartbeat: () => `${API}/me/presence/heartbeat`,
    },
    /** Pusher auth for the private / presence channels (standard Laravel route). */
    broadcastingAuth: () => '/broadcasting/auth',
} as const;

/* -------------------------------------------------------------------------- */
/* Requests                                                                   */
/* -------------------------------------------------------------------------- */

export type SendMessageInput = {
    /** The client-generated ULID that makes a retry idempotent. */
    clientMsgId: string;
    body?: string | null;
    /** Ulids of attachments already uploaded to this conversation. */
    attachmentUlids?: string[];
};

/** Where a chat goes on transfer: a colleague (user id) or a category (slug). */
export type TransferTarget = { agentId: number } | { category: string };

export type ReceiptInput = { deliveredUpto?: number; seenUpto?: number };

export type ConversationListQuery = {
    status?: string;
    type?: string;
    limit?: number;
};

/** The wire body of `POST ...messages` (`client_msg_id`, optional `body`, optional `attachments`). */
export function sendMessageBody(input: SendMessageInput): {
    client_msg_id: string;
    body?: string;
    attachments?: string[];
} {
    const body: {
        client_msg_id: string;
        body?: string;
        attachments?: string[];
    } = { client_msg_id: input.clientMsgId };

    if (input.body !== undefined && input.body !== null && input.body !== '') {
        body.body = input.body;
    }

    if (input.attachmentUlids && input.attachmentUlids.length > 0) {
        body.attachments = input.attachmentUlids;
    }

    return body;
}

export function transferBody(
    target: TransferTarget,
): { agent_id: number } | { category: string } {
    return 'agentId' in target
        ? { agent_id: target.agentId }
        : { category: target.category };
}

export function receiptsBody(input: ReceiptInput): {
    delivered_upto?: number;
    seen_upto?: number;
} {
    return {
        ...(input.deliveredUpto !== undefined
            ? { delivered_upto: input.deliveredUpto }
            : {}),
        ...(input.seenUpto !== undefined ? { seen_upto: input.seenUpto } : {}),
    };
}

/* -------------------------------------------------------------------------- */
/* Attachment upload (XHR: fetch has no upload progress)                      */
/* -------------------------------------------------------------------------- */

/** The image types the server accepts (it sniffs the real type with finfo; this is only the early, friendly check). */
export const ATTACHMENT_MIME_TYPES = [
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/gif',
] as const;

/** The default of `chat.attachment_max_bytes`; the server stays the authority. */
export const ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;

export type AttachmentProblem = 'type' | 'size';

/** Client-side precheck before an upload starts; `null` = fine. */
export function checkAttachment(
    file: Pick<File, 'type' | 'size'>,
    maxBytes: number = ATTACHMENT_MAX_BYTES,
): AttachmentProblem | null {
    if (!(ATTACHMENT_MIME_TYPES as readonly string[]).includes(file.type)) {
        return 'type';
    }

    return file.size > maxBytes ? 'size' : null;
}

export type UploadHandle = {
    promise: Promise<AttachmentData>;
    abort: () => void;
};

type XhrFactory = () => XMLHttpRequest;

function parseJson(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

function errorFromXhr(status: number, body: unknown): ApiError {
    const envelope =
        typeof body === 'object' && body !== null && 'error' in body
            ? (body as { error: Record<string, unknown> }).error
            : undefined;
    const code =
        envelope && typeof envelope.code === 'string'
            ? envelope.code
            : status === 419
              ? 'csrf_mismatch'
              : status === 429
                ? 'rate_limited'
                : status >= 500
                  ? 'server_error'
                  : status === 422
                    ? 'validation_failed'
                    : 'request_failed';
    const message =
        envelope && typeof envelope.message === 'string'
            ? envelope.message
            : `Request failed (${status}).`;
    const details: Record<string, string[]> = {};

    if (envelope && typeof envelope.details === 'object' && envelope.details) {
        for (const [field, value] of Object.entries(envelope.details)) {
            const list = (Array.isArray(value) ? value : [value]).filter(
                (item): item is string => typeof item === 'string',
            );

            if (list.length > 0) {
                details[field] = list;
            }
        }
    }

    return new ApiError({ status, code, message, details });
}

/** `POST /conversations/{ulid}/attachments` as multipart with progress; the handle can abort it (remove-before-send). */
export function uploadAttachment(
    ulid: string,
    file: File,
    onProgress?: (fraction: number) => void,
    createXhr: XhrFactory = () => new XMLHttpRequest(),
): UploadHandle {
    const xhr = createXhr();
    const promise = new Promise<AttachmentData>((resolve, reject) => {
        xhr.open('POST', staffRoutes.api.attachments(ulid));
        xhr.setRequestHeader('Accept', 'application/json');
        xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest');

        const token = readXsrfToken();

        if (token) {
            xhr.setRequestHeader('X-XSRF-TOKEN', token);
        }

        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable && event.total > 0) {
                onProgress?.(event.loaded / event.total);
            }
        };
        xhr.onload = () => {
            const body = parseJson(xhr.responseText);

            if (xhr.status >= 200 && xhr.status < 300) {
                const data =
                    typeof body === 'object' && body !== null && 'data' in body
                        ? (body as { data: AttachmentData }).data
                        : undefined;

                if (data) {
                    onProgress?.(1);
                    resolve(data);

                    return;
                }

                reject(
                    new ApiError({
                        status: xhr.status,
                        code: 'invalid_response',
                        message: 'The server sent an unexpected answer.',
                    }),
                );

                return;
            }

            reject(errorFromXhr(xhr.status, body));
        };
        xhr.onerror = () =>
            reject(
                new ApiError({
                    status: 0,
                    code: 'network',
                    message: 'The server could not be reached.',
                }),
            );
        xhr.onabort = () =>
            reject(new DOMException('Upload cancelled', 'AbortError'));

        const form = new FormData();

        form.append('file', file);
        xhr.send(form);
    });

    return { promise, abort: () => xhr.abort() };
}

/* -------------------------------------------------------------------------- */
/* The client                                                                 */
/* -------------------------------------------------------------------------- */

export function createStaffApi(client: ApiClient = api) {
    return {
        /** `POST /conversations/{ulid}/claim`: the winner gets the active conversation; a loser gets `409 already_claimed`. */
        claim: (ulid: string) =>
            client.post<ConversationStaff>(staffRoutes.api.claim(ulid)),

        conversation: (ulid: string) =>
            client.get<ConversationStaff>(staffRoutes.api.conversation(ulid)),

        conversations: (query: ConversationListQuery = {}) =>
            client.get<ConversationStaff[]>(staffRoutes.api.conversations(), {
                query: { ...query },
            }),

        queue: () => client.get<ConversationStaff[]>(staffRoutes.api.queue()),

        /** `GET .../messages?after_seq=`; callers page by calling again with the highest `seq` while a full page comes back. */
        messages: (
            ulid: string,
            options: {
                afterSeq: number;
                limit?: number;
                signal?: AbortSignal;
            },
        ) =>
            client.get<MessageData[]>(staffRoutes.api.messages(ulid), {
                query: { after_seq: options.afterSeq, limit: options.limit },
                signal: options.signal,
            }),

        sendMessage: (ulid: string, input: SendMessageInput) =>
            client.post<MessageData>(
                staffRoutes.api.messages(ulid),
                sendMessageBody(input),
            ),

        receipts: (ulid: string, input: ReceiptInput) =>
            client.post<null>(
                staffRoutes.api.receipts(ulid),
                receiptsBody(input),
            ),

        end: (ulid: string) =>
            client.post<ConversationStaff>(staffRoutes.api.end(ulid)),

        close: (ulid: string) =>
            client.post<ConversationStaff>(staffRoutes.api.close(ulid)),

        transfer: (ulid: string, target: TransferTarget) =>
            client.post<ConversationStaff>(
                staffRoutes.api.transfer(ulid),
                transferBody(target),
            ),

        presence: () => client.get<PresenceData>(staffRoutes.api.presence()),

        setPresence: (status: PresenceStatus) =>
            client.put<PresenceData>(staffRoutes.api.presence(), { status }),

        heartbeat: () => client.post<null>(staffRoutes.api.heartbeat()),
    };
}

export type StaffApi = ReturnType<typeof createStaffApi>;

/** The client the dashboard uses (it resolves `fetch` lazily, so tests stub the global). */
export const staffApi: StaffApi = createStaffApi();

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

/** `409 already_claimed`: who got the chat first (`details.by`, a display name; `null` when the server did not say). */
export function alreadyClaimedBy(error: unknown): { by: string | null } | null {
    if (isApiError(error) && error.code === 'already_claimed') {
        return { by: error.firstMessage('by') ?? null };
    }

    return null;
}

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

/** A sentence for a failed chat action: the domain codes of this area first, then the shared transport / validation texts. */
export function describeStaffError(error: unknown, t: Translate): string {
    if (isApiError(error)) {
        switch (error.code) {
            case 'already_claimed': {
                const by = error.firstMessage('by');

                return by
                    ? t('inbox.error.taken_by', { name: by })
                    : t('inbox.error.taken');
            }
            case 'conversation_not_active':
                return t('inbox.error.not_active');
        }
    }

    return describeApiError(error, t);
}
