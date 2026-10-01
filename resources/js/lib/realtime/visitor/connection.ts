/**
 * The visitor's realtime connection for ONE conversation: opens the socket, decodes the events of
 * docs/contracts/realtime-events.md into typed handler calls, and keeps the panel correct when the socket is not.
 *
 * - **Events** are validated before they reach a handler (`v: 1`, shapes); anything else is ignored.
 * - **Catch-up**: `handlers.sync(reason)` is called whenever local state may be behind the server: the socket connected, it
 *   reconnected, the tab became visible again, or (while the socket is down) every `pollMs` (default 10 s, the REST-polling
 *   fallback). The owner answers with `GET /public/conversation` + `GET .../messages?after_seq=`; this module never fetches.
 * - **Status** is reported as `connecting | online | reconnecting` so the UI can show a calm "Reconnecting…" line.
 * - A socket that cannot even be created (chunk blocked, Reverb unreachable) leaves the polling fallback running and retries.
 */
import { CHAT_EVENT, echoEvent, PAYLOAD_VERSION } from '@/lib/chat/events';
import type {
    AgentRef,
    ConversationCloseReason,
    ConversationEndedBy,
    MessageData,
    SenderType,
    TypingWhisper,
} from '@/lib/chat/types';
import type {
    ConversationSocket,
    SocketFactory,
    SocketInput,
    SocketStatus,
} from '@/lib/realtime/visitor/types';

export type SyncReason = 'connect' | 'reconnect' | 'visible' | 'poll';
export type RealtimeStatus = 'connecting' | 'online' | 'reconnecting';

export type RealtimeHandlers = {
    onMessage: (message: MessageData) => void;
    onSeen: (receipt: { upToSeq: number; by: SenderType; at: string }) => void;
    onClaimed: (payload: { agent: AgentRef; claimedAt: string }) => void;
    onEnded: (payload: {
        endedBy: ConversationEndedBy;
        ratingRequested: boolean;
    }) => void;
    onClosed: (payload: { reason: ConversationCloseReason }) => void;
    onTransferred: () => void;
    onTyping: (whisper: TypingWhisper) => void;
    onStatus: (status: RealtimeStatus) => void;
    sync: (reason: SyncReason) => void;
    /** The auth endpoint refused the token: the session is revoked or expired. */
    onAuthFailure: () => void;
};

export type ConversationRealtime = {
    /** Whispers `client-typing`; `false` when the socket is not up (the caller falls back to REST). */
    whisperTyping(typing: boolean): boolean;
    /** The socket is connected right now. */
    isUp(): boolean;
    close(): void;
};

export type RealtimeOptions = {
    factory: SocketFactory;
    input: SocketInput;
    handlers: RealtimeHandlers;
    /** Polling interval while the socket is down (default 10 000 ms). */
    pollMs?: number;
    /** How long to wait before trying to create the socket again after it failed (default 15 000 ms, 5 attempts). */
    retryMs?: number;
    document?: Document;
    window?: Window;
};

type Dict = Record<string, unknown>;

const isRecord = (value: unknown): value is Dict =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isVersioned = (value: unknown): value is Dict =>
    isRecord(value) && value.v === PAYLOAD_VERSION;

function asMessage(payload: unknown): MessageData | null {
    return isVersioned(payload) &&
        isRecord(payload.message) &&
        typeof payload.message.ulid === 'string' &&
        typeof payload.message.seq === 'number'
        ? (payload.message as unknown as MessageData)
        : null;
}

/** The server's REST-typing fallback is broadcast as `typing` (docs/contracts/realtime-events.md, 4B); the whisper is `client-typing`. */
const TYPING_FALLBACK = 'typing';

const SENDERS: readonly string[] = ['visitor', 'agent', 'system'];
const ENDERS: readonly string[] = ['visitor', 'agent', 'admin', 'system'];
const REASONS: readonly string[] = [
    'rated',
    'skipped',
    'idle',
    'timeout',
    'system',
    'cancelled',
];

export async function openConversationRealtime(
    options: RealtimeOptions,
): Promise<ConversationRealtime> {
    const { handlers } = options;
    const doc = options.document ?? document;
    const win = options.window ?? window;
    let socket: ConversationSocket | null = null;
    let closed = false;
    let everUp = false;
    let up = false;
    let connected = false;
    let subscribed = false;
    let degraded = false;
    let reported: RealtimeStatus | null = null;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    /**
     * "Up" means the websocket is connected AND the channel subscription went through: a socket whose subscription was refused
     * (`503 realtime_unavailable`) is connected but delivers nothing, so it counts as down and the polling fallback covers it.
     */
    const refresh = (): void => {
        if (closed) {
            return;
        }

        const was = up;

        up = connected && subscribed && !degraded;

        const status: RealtimeStatus = up
            ? 'online'
            : everUp || degraded || (!connected && reported === 'reconnecting')
              ? 'reconnecting'
              : 'connecting';

        if (status !== reported) {
            reported = status;
            handlers.onStatus(status);
        }

        if (up && !was) {
            handlers.sync(everUp ? 'reconnect' : 'connect');
            everUp = true;
        }
    };

    const report = (status: SocketStatus): void => {
        connected = status === 'connected';

        if (!connected) {
            subscribed = false;
            degraded = false;
        }

        refresh();
    };

    function bind(next: ConversationSocket): void {
        const on = (
            event: (typeof CHAT_EVENT)[keyof typeof CHAT_EVENT],
            handle: (payload: unknown) => void,
        ): void => {
            next.listen(
                event === CHAT_EVENT.typing ? event : echoEvent(event),
                handle,
            );
        };

        on(CHAT_EVENT.messageCreated, (payload) => {
            const message = asMessage(payload);

            if (message !== null) {
                handlers.onMessage(message);
            }
        });

        on(CHAT_EVENT.messageSeen, (payload) => {
            if (
                isVersioned(payload) &&
                typeof payload.upToSeq === 'number' &&
                typeof payload.by === 'string' &&
                SENDERS.includes(payload.by) &&
                typeof payload.at === 'string'
            ) {
                handlers.onSeen({
                    upToSeq: payload.upToSeq,
                    by: payload.by as SenderType,
                    at: payload.at,
                });
            }
        });

        on(CHAT_EVENT.claimed, (payload) => {
            if (
                isVersioned(payload) &&
                isRecord(payload.agent) &&
                typeof payload.agent.name === 'string'
            ) {
                handlers.onClaimed({
                    agent: {
                        name: payload.agent.name,
                        avatarUrl:
                            typeof payload.agent.avatarUrl === 'string'
                                ? payload.agent.avatarUrl
                                : null,
                    },
                    claimedAt:
                        typeof payload.claimedAt === 'string'
                            ? payload.claimedAt
                            : '',
                });
            }
        });

        on(CHAT_EVENT.conversationEnded, (payload) => {
            if (
                isVersioned(payload) &&
                typeof payload.endedBy === 'string' &&
                ENDERS.includes(payload.endedBy)
            ) {
                handlers.onEnded({
                    endedBy: payload.endedBy as ConversationEndedBy,
                    ratingRequested: payload.ratingRequested === true,
                });
            }
        });

        on(CHAT_EVENT.conversationClosed, (payload) => {
            if (
                isVersioned(payload) &&
                typeof payload.reason === 'string' &&
                REASONS.includes(payload.reason)
            ) {
                handlers.onClosed({
                    reason: payload.reason as ConversationCloseReason,
                });
            }
        });

        on(CHAT_EVENT.conversationTransferred, (payload) => {
            if (isVersioned(payload)) {
                handlers.onTransferred();
            }
        });

        const typing = (payload: unknown): void => {
            if (
                isRecord(payload) &&
                payload.actor === 'agent' &&
                typeof payload.typing === 'boolean'
            ) {
                handlers.onTyping({ actor: 'agent', typing: payload.typing });
            }
        };

        on(CHAT_EVENT.typing, typing);
        next.listen(`.${TYPING_FALLBACK}`, typing);

        next.onSubscribed(() => {
            subscribed = true;
            degraded = false;
            refresh();
        });
        next.onSubscriptionError((status) => {
            if (status === 401 || status === 403) {
                handlers.onAuthFailure();

                return;
            }

            degraded = true;
            subscribed = false;
            refresh();
        });
        next.onStatus(report);
        report(next.status());
    }

    async function open(): Promise<void> {
        if (closed) {
            return;
        }

        try {
            const next = await options.factory(options.input);

            if (closed) {
                next.close();

                return;
            }

            socket = next;
            bind(next);
        } catch {
            reported = 'reconnecting';
            handlers.onStatus('reconnecting');

            if (attempts++ < 5) {
                retryTimer = setTimeout(
                    () => void open(),
                    options.retryMs ?? 15_000,
                );
            }
        }
    }

    // The REST fallback: while the socket is down, ask the server every `pollMs` instead.
    const poll = setInterval(() => {
        if (!closed && !up) {
            handlers.sync('poll');
        }
    }, options.pollMs ?? 10_000);

    const onVisible = (): void => {
        if (doc.visibilityState === 'visible') {
            handlers.sync('visible');
        }
    };
    const onOnline = (): void => handlers.sync('visible');

    doc.addEventListener('visibilitychange', onVisible);
    win.addEventListener('online', onOnline);

    reported = 'connecting';
    handlers.onStatus('connecting');
    await open();

    return {
        whisperTyping(typing) {
            if (socket === null || !up) {
                return false;
            }

            try {
                socket.whisper(CHAT_EVENT.typing, { actor: 'visitor', typing });

                return true;
            } catch {
                return false;
            }
        },
        isUp: () => up,
        close() {
            closed = true;
            up = false;
            clearInterval(poll);
            clearTimeout(retryTimer);
            doc.removeEventListener('visibilitychange', onVisible);
            win.removeEventListener('online', onOnline);
            socket?.close();
            socket = null;
        },
    };
}
