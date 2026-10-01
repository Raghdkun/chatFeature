/**
 * Envelope and message shapes of the host page <-> chat iframe protocol (docs/contracts/postmessage-protocol.md, the panel side).
 *
 * Everything that crosses `postMessage` is untrusted until `parseHostMessage` has looked at it: the envelope must be
 * `{ns:'chatfeature', v:1, type, payload}`, and a message whose payload is not what its `type` promises is dropped, never repaired.
 */
import type { VisitorFields } from '@/lib/chat-api/visitor';

export const NAMESPACE = 'chatfeature';
export const PROTOCOL_VERSION = 1;

export type Envelope<T extends string = string, P = unknown> = {
    ns: typeof NAMESPACE;
    v: typeof PROTOCOL_VERSION;
    type: T;
    id?: string;
    payload: P;
};

export type Dict = Record<string, unknown>;

export function isRecord(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------- host -> panel */

export type ViewportPayload = {
    width: number;
    height: number;
    keyboardInset: number;
};

export type InitPayload = {
    /** The rebuilt boot config (see `PanelBoot` in `config/boot.ts`). */
    boot: Dict;
    visitorSession?: { token: string; expiresAt: string };
    identityToken?: string;
    visitor?: VisitorFields;
    page: { url: string; title: string; referrer: string };
    overrides: Dict;
    embedMode: 'launcher';
    viewport: ViewportPayload;
};

export type HostMessage =
    | { type: 'init'; id?: string; payload: InitPayload }
    | { type: 'open' }
    | { type: 'close' }
    | { type: 'shutdown' }
    | { type: 'update'; payload: { overrides: Dict } }
    | {
          type: 'identify';
          payload: { token?: string; visitor?: VisitorFields };
      }
    | { type: 'setCategory'; payload: { slug: string } }
    | { type: 'startChat'; payload: { category?: string; message?: string } }
    | { type: 'viewport'; payload: ViewportPayload }
    /** The answer to a panel `session { drop }`: the newer session another tab stored (adopt it), or `null` (cleared). */
    | { type: 'session'; payload: { token: string; expiresAt: string } | null }
    | { type: 'draft'; payload: { config: Dict; greetings: unknown } };

export type HostMessageType = HostMessage['type'];

const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const num = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) ? value : undefined;

function parseVisitor(value: unknown): VisitorFields | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const out: VisitorFields = {};

    for (const key of ['name', 'email', 'phone'] as const) {
        const field = str(value[key]);

        if (field !== undefined) {
            out[key] = field;
        }
    }

    if (isRecord(value.meta)) {
        const meta: Record<string, string | number | boolean> = {};

        for (const [key, item] of Object.entries(value.meta)) {
            if (
                typeof item === 'string' ||
                typeof item === 'number' ||
                typeof item === 'boolean'
            ) {
                meta[key] = item;
            }
        }

        out.meta = meta;
    }

    return out;
}

function parseViewport(value: unknown): ViewportPayload | undefined {
    if (!isRecord(value)) {
        return undefined;
    }

    const width = num(value.width);
    const height = num(value.height);
    const keyboardInset = num(value.keyboardInset) ?? 0;

    return width === undefined || height === undefined
        ? undefined
        : { width, height, keyboardInset: Math.max(0, keyboardInset) };
}

function parseInit(value: unknown): InitPayload | null {
    if (!isRecord(value) || !isRecord(value.boot)) {
        return null;
    }

    const page = isRecord(value.page) ? value.page : {};
    const session = isRecord(value.visitorSession) ? value.visitorSession : {};
    const token = str(session.token);
    const expiresAt = str(session.expiresAt);

    return {
        boot: value.boot,
        ...(token !== undefined && expiresAt !== undefined && token !== ''
            ? { visitorSession: { token, expiresAt } }
            : {}),
        ...(str(value.identityToken) === undefined
            ? {}
            : { identityToken: str(value.identityToken) }),
        ...(parseVisitor(value.visitor) === undefined
            ? {}
            : { visitor: parseVisitor(value.visitor) }),
        page: {
            url: str(page.url) ?? '',
            title: str(page.title) ?? '',
            referrer: str(page.referrer) ?? '',
        },
        overrides: isRecord(value.overrides) ? value.overrides : {},
        embedMode: 'launcher',
        viewport: parseViewport(value.viewport) ?? {
            width: 0,
            height: 0,
            keyboardInset: 0,
        },
    };
}

/**
 * Validates an inbound message. `null` for anything that is not a well-formed envelope, an unknown `type`, or a payload that does
 * not match its type (unknown types are ignored silently by contract).
 */
export function parseHostMessage(data: unknown): HostMessage | null {
    if (
        !isRecord(data) ||
        data.ns !== NAMESPACE ||
        data.v !== PROTOCOL_VERSION ||
        typeof data.type !== 'string'
    ) {
        return null;
    }

    const payload = isRecord(data.payload) ? data.payload : {};

    switch (data.type) {
        case 'init': {
            const init = parseInit(payload);

            return init === null
                ? null
                : { type: 'init', id: str(data.id), payload: init };
        }
        case 'open':
        case 'close':
        case 'shutdown':
            return { type: data.type };
        case 'update':
            return {
                type: 'update',
                payload: {
                    overrides: isRecord(payload.overrides)
                        ? payload.overrides
                        : {},
                },
            };
        case 'identify':
            return {
                type: 'identify',
                payload: {
                    token: str(payload.token),
                    visitor: parseVisitor(payload.visitor),
                },
            };
        case 'setCategory': {
            const slug = str(payload.slug);

            return slug === undefined || slug === ''
                ? null
                : { type: 'setCategory', payload: { slug } };
        }
        case 'startChat':
            return {
                type: 'startChat',
                payload: {
                    category: str(payload.category),
                    message: str(payload.message),
                },
            };
        case 'viewport': {
            const viewport = parseViewport(payload);

            return viewport === undefined
                ? null
                : { type: 'viewport', payload: viewport };
        }
        case 'session': {
            const token = str(payload.token);
            const expiresAt = str(payload.expiresAt);

            return {
                type: 'session',
                payload:
                    token !== undefined &&
                    token !== '' &&
                    expiresAt !== undefined
                        ? { token, expiresAt }
                        : null,
            };
        }
        case 'draft':
            return isRecord(payload.config)
                ? {
                      type: 'draft',
                      payload: {
                          config: payload.config,
                          greetings: payload.greetings,
                      },
                  }
                : null;
        default:
            return null;
    }
}

/* ------------------------------------------------------------- panel -> host */

/** The statuses the loader understands (`category` is the visitor still picking a topic: reported as `prechat`). */
export type HostStatus =
    | 'idle'
    | 'prechat'
    | 'queued'
    | 'active'
    | 'ended'
    | 'offline'
    | 'closed';

export type HostAgent = { name: string; avatarUrl?: string };

export type StatePayload = {
    status: HostStatus;
    open: boolean;
    unread: number;
    agent?: HostAgent;
};

export type PanelEventName =
    | 'chat-started'
    | 'chat-ended'
    | 'agent-joined'
    | 'message-sent'
    | 'message-received'
    | 'rating-submitted';

export type PanelMessage =
    | { type: 'ready'; payload: { protocol: 1 } }
    | { type: 'init:result'; payload: Dict; id: string }
    | {
          type: 'session';
          /**
           * `{ token, expiresAt }`: a new session. `{ drop }`: compare-and-clear, the host removes its stored copy only while it
           * still holds that token and answers with the newer one otherwise. `null`: unconditional clear (legacy).
           */
          payload:
              | { token: string; expiresAt: string }
              | { drop: string }
              | null;
      }
    | { type: 'state'; payload: StatePayload }
    | {
          type: 'unread';
          payload: { count: number; preview?: string; agent?: HostAgent };
      }
    | { type: 'resize'; payload: { mode: 'panel' | 'fullscreen' } }
    | { type: 'close'; payload: Dict }
    | { type: 'event'; payload: { name: PanelEventName; data?: Dict } }
    | { type: 'error'; payload: { code: string; message: string } };

export function envelope(message: PanelMessage): Envelope {
    return {
        ns: NAMESPACE,
        v: PROTOCOL_VERSION,
        type: message.type,
        ...('id' in message ? { id: message.id } : {}),
        payload: message.payload,
    };
}
