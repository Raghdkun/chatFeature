/**
 * Everything the open conversation needs: its message list and send pipeline (optimistic -> ack -> receipts, failed -> retry), the
 * typing indicator, receipts for what the agent has read, catch-up after a reconnect / a gap / a background tab, and the actions
 * (end, close, transfer). `ConversationChannelBindings` renders nothing and wires `private-conversation.{ulid}` to the hook's
 * `bridge`; without a websocket the hook still works, polling `GET ...?after_seq=` every 15 s.
 */
import { useConnectionStatus, useEcho } from '@laravel/echo-react';
import {
    useCallback,
    useEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { toast } from 'sonner';
import { useTrans } from '@/hooks/use-trans';
import {
    describeStaffError,
    staffApi,
    type StaffApi,
    type TransferTarget,
} from '@/lib/chat-api/staff';
import { CHAT_EVENT, channels, echoEvent } from '@/lib/chat/events';
import { findGap, highestSeq, highestSeqFrom } from '@/lib/chat/messages';
import { createTypingTracker } from '@/lib/chat/typing';
import type {
    AttachmentData,
    ConversationStaff,
    LocalMessage,
    MessageData,
    TypingWhisper,
} from '@/lib/chat/types';
import { isApiError } from '@/lib/api-client';
import { newClientMsgId } from '@/lib/realtime/staff/client-id';
import {
    canSend,
    conversationReducer,
    createConversationState,
} from '@/lib/realtime/staff/conversation-state';
import {
    useInbox,
    useStaffRealtimeContext,
} from '@/lib/realtime/staff/context';
import { POLL_INTERVAL_MS } from '@/lib/realtime/staff/controller';
import { useChannelEvent } from '@/lib/realtime/staff/use-staff-realtime';

/** How long a visitor's message must be on screen before it is acknowledged as read (a quick tab flick is not reading). */
export const RECEIPT_DELAY_MS = 400;
const PAGE_LIMIT = 100;

/**
 * The server's fallback for the typing whisper (it cannot publish `client-*` events): `{ v, actor, typing }` on the conversation
 * channel. Both feed the same typing helper. The shared `CHAT_EVENT` will carry this name; until then it lives here.
 */
const TYPING_FALLBACK_EVENT = '.typing';
const MAX_PAGES = 20;

export type ConversationViewer = {
    id: number;
    name: string;
    avatarUrl: string | null;
};

export type SendInput = { body: string; attachments?: AttachmentData[] };

/** Callbacks the Echo bindings call; stable for the life of the hook. */
export type ConversationBridge = {
    messageCreated: (message: MessageData) => void;
    seen: (receipt: {
        upToSeq: number;
        by: 'visitor' | 'agent' | 'system';
        at: string;
    }) => void;
    ended: (payload: { ratingRequested: boolean }) => void;
    closed: () => void;
    typing: (whisper: TypingWhisper) => void;
    /** The websocket (re)connected: catch up on whatever was missed. */
    connected: () => void;
    /** Hand over the function that sends the `client-typing` whisper (or `null` on unmount). */
    setWhisper: (send: ((whisper: TypingWhisper) => void) | null) => void;
};

function subscribeVisibility(notify: () => void): () => void {
    document.addEventListener('visibilitychange', notify);

    return () => document.removeEventListener('visibilitychange', notify);
}

/** Whether the tab is in front. */
export function useDocumentVisible(): boolean {
    return useSyncExternalStore(
        subscribeVisibility,
        () => document.visibilityState === 'visible',
        () => true,
    );
}

export function useConversation({
    conversation: initialConversation,
    messages: initialMessages,
    me,
    api = staffApi,
}: {
    conversation: ConversationStaff;
    messages: MessageData[];
    me: ConversationViewer;
    api?: StaffApi;
}) {
    const { t } = useTrans();
    const { store, setViewing, viewer } = useStaffRealtimeContext();
    const ulid = initialConversation.ulid;
    const [state, dispatch] = useReducer(conversationReducer, undefined, () =>
        createConversationState(initialConversation, initialMessages),
    );
    const latest = useRef(state);
    const visible = useDocumentVisible();
    const connection = useInbox((s) => s.connection);

    useEffect(() => {
        latest.current = state;
    });

    // The server's props are authoritative whenever Inertia reloads them; the merge is idempotent.
    useEffect(() => {
        dispatch({ type: 'conversation', conversation: initialConversation });
        dispatch({ type: 'received', messages: initialMessages });
    }, [initialConversation, initialMessages]);

    // The live copy of this chat in the inbox lists (`conversation.updated`): status, assignee, category.
    const listed = useInbox(
        (s) =>
            s.mine.find((item) => item.ulid === ulid) ??
            s.tickets.find((item) => item.ulid === ulid) ??
            null,
    );

    useEffect(() => {
        if (listed) {
            dispatch({ type: 'conversation', conversation: listed });
        }
    }, [listed]);

    /* ---------------------------------------------------------------- */
    /* Catch-up                                                         */
    /* ---------------------------------------------------------------- */

    const catching = useRef<Promise<void> | null>(null);
    const catchAgain = useRef(false);

    const catchUp = useCallback((): Promise<void> => {
        if (catching.current) {
            catchAgain.current = true;

            return catching.current;
        }

        catching.current = (async () => {
            try {
                const held = latest.current.messages;
                const top = highestSeq(held);
                // Start at the first hole when there is one (a missed broadcast), else right after the newest message.
                let after = findGap(held, top)?.afterSeq ?? top;

                for (let page = 0; page < MAX_PAGES; page++) {
                    const batch = await api.messages(ulid, {
                        afterSeq: after,
                        limit: PAGE_LIMIT,
                    });

                    if (batch.length > 0) {
                        dispatch({ type: 'received', messages: batch });
                        after = Math.max(after, ...batch.map((m) => m.seq));
                    }

                    if (batch.length < PAGE_LIMIT) {
                        break;
                    }
                }

                dispatch({
                    type: 'conversation',
                    conversation: await api.conversation(ulid),
                });
            } catch {
                // The next trigger (poll tick, reconnect, visibility) retries.
            } finally {
                catching.current = null;

                if (catchAgain.current) {
                    catchAgain.current = false;
                    void catchUp();
                }
            }
        })();

        return catching.current;
    }, [api, ulid]);

    // A hole in `seq` (a missed broadcast) is fetched as soon as it is noticed, at most once per distinct hole.
    const gapAttempt = useRef<string | null>(null);

    useEffect(() => {
        const top = highestSeq(state.messages);
        const gap = findGap(
            state.messages,
            Math.max(top, state.conversation.lastSeq),
        );

        if (!gap) {
            gapAttempt.current = null;

            return;
        }

        const key = `${gap.afterSeq}:${gap.count}`;

        if (gapAttempt.current !== key) {
            gapAttempt.current = key;
            void catchUp();
        }
    }, [state.messages, state.conversation.lastSeq, catchUp]);

    // No websocket (or it dropped): poll while this chat is open.
    useEffect(() => {
        if (connection === 'connected') {
            return;
        }

        const timer = setInterval(() => void catchUp(), POLL_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [connection, catchUp]);

    // Back in the foreground: timers were throttled, so look now.
    useEffect(() => {
        if (visible) {
            void catchUp();
        }
    }, [visible, catchUp]);

    /* ---------------------------------------------------------------- */
    /* Typing                                                           */
    /* ---------------------------------------------------------------- */

    const [tracker] = useState(() => createTypingTracker());
    const [typing, setTyping] = useState(false);
    const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const whisper = useRef<((w: TypingWhisper) => void) | null>(null);

    const refreshTyping = useCallback(() => {
        if (typingTimer.current !== null) {
            clearTimeout(typingTimer.current);
            typingTimer.current = null;
        }

        setTyping(tracker.isTyping('visitor'));

        const ms = tracker.msUntilExpiry();

        if (ms !== null) {
            typingTimer.current = setTimeout(refreshTyping, ms + 25);
        }
    }, [tracker]);

    const notifyTyping = useCallback(
        (isTyping: boolean) => {
            const toSend = tracker.local(isTyping);

            if (toSend !== null) {
                whisper.current?.({ actor: 'agent', typing: toSend });
            }
        },
        [tracker],
    );

    useEffect(
        () => () => {
            if (typingTimer.current !== null) {
                clearTimeout(typingTimer.current);
            }

            notifyTyping(false);
        },
        [notifyTyping],
    );

    /* ---------------------------------------------------------------- */
    /* Receipts: what the agent has read                                */
    /* ---------------------------------------------------------------- */

    const acknowledged = useRef(0);
    const mine =
        state.conversation.assignedAgent?.id === viewer.id &&
        state.conversation.type === 'live';

    useEffect(() => {
        setViewing(ulid);

        return () => setViewing(null);
    }, [ulid, setViewing]);

    useEffect(() => {
        // Only the agent who owns the chat reads it on the visitor's behalf (an admin watching must not mark it seen).
        if (!visible || !mine || state.conversation.status === 'closed') {
            return;
        }

        const seq = highestSeqFrom(state.messages, 'visitor');
        const unread = state.messages.some(
            (m) => m.sender.type === 'visitor' && m.seenAt === null,
        );

        if (seq === 0 || seq <= acknowledged.current || !unread) {
            return;
        }

        const timer = setTimeout(() => {
            const previous = acknowledged.current;

            acknowledged.current = seq;
            store.dispatch({ type: 'seen', conversation: ulid });
            api.receipts(ulid, { deliveredUpto: seq, seenUpto: seq }).then(
                () =>
                    dispatch({
                        type: 'seen',
                        upToSeq: seq,
                        by: 'agent',
                        at: new Date().toISOString(),
                    }),
                () => {
                    acknowledged.current = previous;
                },
            );
        }, RECEIPT_DELAY_MS);

        return () => clearTimeout(timer);
    }, [
        visible,
        mine,
        state.messages,
        state.conversation.status,
        ulid,
        api,
        store,
    ]);

    /* ---------------------------------------------------------------- */
    /* Sending                                                          */
    /* ---------------------------------------------------------------- */

    const deliver = useCallback(
        async (
            clientMsgId: string,
            body: string,
            attachments: AttachmentData[],
        ): Promise<void> => {
            try {
                const message = await api.sendMessage(ulid, {
                    clientMsgId,
                    body,
                    attachmentUlids: attachments.map((a) => a.ulid),
                });

                dispatch({ type: 'acked', message });
            } catch (error) {
                dispatch({ type: 'failed', clientMsgId });

                if (
                    isApiError(error) &&
                    error.code === 'conversation_not_active'
                ) {
                    toast.error(describeStaffError(error, t));
                    void catchUp();
                }
            }
        },
        [api, ulid, catchUp, t],
    );

    const send = useCallback(
        async ({ body, attachments = [] }: SendInput): Promise<void> => {
            const text = body.trim();

            if (text === '' && attachments.length === 0) {
                return;
            }

            const clientMsgId = newClientMsgId();

            notifyTyping(false);
            dispatch({
                type: 'pending',
                input: {
                    clientMsgId,
                    conversation: ulid,
                    sender: {
                        type: 'agent',
                        name: me.name,
                        avatarUrl: me.avatarUrl,
                        id: me.id,
                    },
                    body: text === '' ? null : text,
                    createdAt: new Date().toISOString(),
                    attachments,
                },
            });
            await deliver(clientMsgId, text, attachments);
        },
        [ulid, me.id, me.name, me.avatarUrl, notifyTyping, deliver],
    );

    const retry = useCallback(
        (clientMsgId: string): void => {
            const failed = latest.current.messages.find(
                (m) => m.clientMsgId === clientMsgId && m.seq === null,
            );

            if (!failed) {
                return;
            }

            dispatch({ type: 'retrying', clientMsgId });
            void deliver(clientMsgId, failed.body ?? '', failed.attachments);
        },
        [deliver],
    );

    const discard = useCallback((clientMsgId: string): void => {
        dispatch({ type: 'discard', clientMsgId });
    }, []);

    /* ---------------------------------------------------------------- */
    /* Actions                                                          */
    /* ---------------------------------------------------------------- */

    const act = useCallback(
        async (
            call: () => Promise<ConversationStaff>,
        ): Promise<ConversationStaff | null> => {
            try {
                const next = await call();

                dispatch({ type: 'conversation', conversation: next });
                store.dispatch({
                    type: 'conversationUpdated',
                    conversation: next,
                    viewer,
                });

                return next;
            } catch (error) {
                toast.error(describeStaffError(error, t));

                return null;
            }
        },
        [store, viewer, t],
    );

    const end = useCallback(() => act(() => api.end(ulid)), [act, api, ulid]);
    const close = useCallback(
        () => act(() => api.close(ulid)),
        [act, api, ulid],
    );
    const transfer = useCallback(
        (target: TransferTarget) => act(() => api.transfer(ulid, target)),
        [act, api, ulid],
    );

    /* ---------------------------------------------------------------- */
    /* The bridge to the Echo bindings                                  */
    /* ---------------------------------------------------------------- */

    const bridge = useMemo<ConversationBridge>(
        () => ({
            messageCreated: (message) => {
                dispatch({ type: 'received', messages: [message] });

                if (message.sender.type === 'visitor') {
                    tracker.receive({ actor: 'visitor', typing: false });
                    refreshTyping();
                }
            },
            seen: (receipt) =>
                dispatch({
                    type: 'seen',
                    upToSeq: receipt.upToSeq,
                    by: receipt.by,
                    at: receipt.at,
                }),
            ended: ({ ratingRequested }) =>
                dispatch({
                    type: 'ended',
                    ratingRequested,
                    at: new Date().toISOString(),
                }),
            closed: () =>
                dispatch({ type: 'closed', at: new Date().toISOString() }),
            typing: (incoming) => {
                if (incoming.actor !== 'visitor') {
                    return;
                }

                tracker.receive(incoming);
                refreshTyping();
            },
            connected: () => void catchUp(),
            setWhisper: (fn) => {
                whisper.current = fn;
            },
        }),
        [tracker, refreshTyping, catchUp],
    );

    return {
        conversation: state.conversation,
        messages: state.messages as LocalMessage[],
        typing,
        canSend: canSend(state.conversation),
        connection,
        send,
        retry,
        discard,
        notifyTyping,
        catchUp,
        end,
        close,
        transfer,
        bridge,
    };
}

export type ConversationController = ReturnType<typeof useConversation>;

/**
 * Renders nothing: binds `private-conversation.{ulid}` (`message.created`, `message.seen`, `conversation.ended`, `conversation.closed`,
 * the `client-typing` whisper) to the bridge, hands it the whisper sender and reports reconnects.
 */
export function ConversationChannelBindings({
    ulid,
    bridge,
}: {
    ulid: string;
    bridge: ConversationBridge;
}) {
    const channel = channels.conversation(ulid);
    const status = useConnectionStatus();
    const previous = useRef(status);

    useChannelEvent(channel, CHAT_EVENT.messageCreated, (payload) =>
        bridge.messageCreated(payload.message),
    );
    useChannelEvent(channel, CHAT_EVENT.messageSeen, (payload) =>
        bridge.seen({
            upToSeq: payload.upToSeq,
            by: payload.by,
            at: payload.at,
        }),
    );
    useChannelEvent(channel, CHAT_EVENT.conversationEnded, (payload) =>
        bridge.ended({ ratingRequested: payload.ratingRequested }),
    );
    useChannelEvent(channel, CHAT_EVENT.conversationClosed, () =>
        bridge.closed(),
    );

    const typing = useEcho<TypingWhisper>(
        channel,
        echoEvent(CHAT_EVENT.typing),
        (payload) => bridge.typing(payload),
        [channel],
    );

    useEcho<TypingWhisper & { v?: number }>(
        channel,
        TYPING_FALLBACK_EVENT,
        (payload) => {
            if (payload.v === 1) {
                bridge.typing({ actor: payload.actor, typing: payload.typing });
            }
        },
        [channel],
    );

    useEffect(() => {
        bridge.setWhisper((payload) => {
            // `whisper('typing', ...)` is sent as the client event `client-typing`.
            const handle = typing.channel() as {
                whisper?: (name: string, data: TypingWhisper) => void;
            } | null;

            handle?.whisper?.('typing', payload);
        });

        return () => bridge.setWhisper(null);
    }, [bridge, typing]);

    useEffect(() => {
        if (status === 'connected' && previous.current !== 'connected') {
            bridge.connected();
        }

        previous.current = status;
    }, [status, bridge]);

    return null;
}
