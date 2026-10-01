/**
 * The visitor's realtime connection for ONE conversation: opens the socket, decodes the events of
 * docs/contracts/realtime-events.md into typed handler calls, and keeps the panel correct when the socket is not.
 *
 * - **Events** are validated before they reach a handler (`v: 1`, shapes); anything else is ignored.
 * - **Catch-up**: `handlers.sync(reason)` is called whenever local state may be behind the server: the socket connected, it
 *   reconnected, the tab became visible again, or (while the socket is down) every `pollMs` (default 10 s, the REST-polling
 *   fallback). The owner answers with `GET /public/conversation` + `GET .../messages?after_seq=`; this module never fetches.
 * - **Status** is reported as `connecting | online | reconnecting | polling` so the UI can show a calm "Reconnecting…" line;
 *   `polling` is not a fault: there is no usable socket (the server sent no `ws` block, the channel auth answered `503
 *   realtime_unavailable`, or the socket could not be created five times) and REST polling is the only channel.
 * - A socket that cannot even be created (chunk blocked, Reverb unreachable) leaves the polling fallback running and retries.
 * - Every binding made on the socket is undone by `close()` (and the socket is closed): nothing is left listening.
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
export type RealtimeStatus =
    | 'connecting'
    | 'online'
    | 'reconnecting'
    | 'polling';

export type RealtimeHandlers = {
    onMessage: (message: MessageData) => void;
    onSeen: (receipt: { upToSeq: number; by: SenderType; at: string }) => void;
    onClaimed: (payload: { agent: AgentRef; claimedAt: string }) => void;
    onEnded: (payload: {
        endedBy: ConversationEndedBy;
        ratingRequested: boolean;
    }) => void;
    onClosed: (payload: { reason: ConversationCloseReason }) => void;
    /** A queued chat nobody accepted in time (`conversation.missed`): the offline form takes over. */
    onMissed: () => void;
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
    /** `null` when the server sent no `ws` block (Reverb not configured): there is no socket, REST polling only. */
    input: SocketInput | null;
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

const TYPING_FALLBACK = echoEvent(CHAT_EVENT.typingFallback);
const CONVERSATION_MISSED = echoEvent(CHAT_EVENT.conversationMissed);
const MAX_OPEN_ATTEMPTS = 5;

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
    const input = options.input;
    let socket: ConversationSocket | null = null;
    let unbinders: (() => void)[] = [];
    let closed = false;
    let everUp = false;
    let up = false;
    let connected = false;
    let subscribed = false;
    let degraded = false;
    /** The channel auth answered `503 realtime_unavailable`: quiet polling until a later subscription goes through. */
    let unavailable = false;
    /** No socket will ever exist (no `ws` block, or it could not be created five times). */
    let pollingOnly = input === null;
    let reported: RealtimeStatus | null = null;
    let attempts = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;

    const setStatus = (status: RealtimeStatus): void => {
        if (!closed && status !== reported) {
            reported = status;
            handlers.onStatus(status);
        }
    };

    /**
     * "Up" means the websocket is connected AND the channel subscription went through: a socket whose subscription was refused
     * (`503 realtime_unavailable`) is connected but delivers nothing, so it counts as down and the polling fallback covers it.
     */
    const refresh = (): void => {
        if (closed) {
            return;
        }

        const was = up;

        up = connected && subscribed && !degraded && !pollingOnly;

        setStatus(
            pollingOnly || unavailable
                ? 'polling'
                : up
                  ? 'online'
                  : everUp || (!connected && reported === 'reconnecting')
                    ? 'reconnecting'
                    : 'connecting',
        );

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
            unavailable = false;
        }

        refresh();
    };

    /** REST polling is all there is from here on (not a fault, so no "Reconnecting…" line). */
    const fallBackToPolling = (): void => {
        pollingOnly = true;
        refresh();
    };

    const unbindAll = (): void => {
        const undo = unbinders;

        unbinders = [];

        for (const off of undo) {
            try {
                off();
            } catch {
                // the socket is already gone
            }
        }
    };

    function bind(next: ConversationSocket): void {
        const on = (
            event: string,
            handle: (payload: unknown) => void,
        ): void => {
            unbinders.push(next.listen(event, handle));
        };

        on(echoEvent(CHAT_EVENT.messageCreated), (payload) => {
            const message = asMessage(payload);

            if (message !== null) {
                handlers.onMessage(message);
            }
        });

        on(echoEvent(CHAT_EVENT.messageSeen), (payload) => {
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

        on(echoEvent(CHAT_EVENT.claimed), (payload) => {
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

        on(echoEvent(CHAT_EVENT.conversationEnded), (payload) => {
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

        on(echoEvent(CHAT_EVENT.conversationClosed), (payload) => {
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

        on(CONVERSATION_MISSED, (payload) => {
            if (isVersioned(payload)) {
                handlers.onMissed();
            }
        });

        on(echoEvent(CHAT_EVENT.conversationTransferred), (payload) => {
            if (isVersioned(payload)) {
                handlers.onTransferred();
            }
        });

        // The whisper (`client-typing`, from the agent's browser) and the server's REST fallback (`typing`) feed one helper.
        const typing = (payload: unknown): void => {
            if (
                isRecord(payload) &&
                payload.actor === 'agent' &&
                typeof payload.typing === 'boolean'
            ) {
                handlers.onTyping({ actor: 'agent', typing: payload.typing });
            }
        };

        on(echoEvent(CHAT_EVENT.typing), typing);
        on(TYPING_FALLBACK, typing);

        unbinders.push(
            next.onSubscribed(() => {
                subscribed = true;
                degraded = false;
                unavailable = false;
                refresh();
            }),
            next.onSubscriptionError((status) => {
                if (status === 401 || status === 403) {
                    handlers.onAuthFailure();

                    return;
                }

                subscribed = false;

                // `503 realtime_unavailable` (Reverb is not usable on the server) is not a fault the visitor can do anything about:
                // nothing arrives on this socket, so poll quietly. Any other refusal is shown as a reconnecting socket.
                unavailable = status === 503;
                degraded = !unavailable;
                refresh();
            }),
            next.onStatus(report),
        );
        report(next.status());
    }

    async function open(): Promise<void> {
        if (closed || input === null) {
            return;
        }

        try {
            const next = await options.factory(input);

            if (closed) {
                next.close();

                return;
            }

            socket = next;
            bind(next);
        } catch {
            if (attempts++ < MAX_OPEN_ATTEMPTS) {
                setStatus('reconnecting');
                retryTimer = setTimeout(
                    () => void open(),
                    options.retryMs ?? 15_000,
                );
            } else {
                fallBackToPolling();
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

    if (pollingOnly) {
        setStatus('polling');
    } else {
        setStatus('connecting');
        await open();
    }

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
            unbindAll();
            socket?.close();
            socket = null;
        },
    };
}
