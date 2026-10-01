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
import { ApiError, isApiError } from '@/lib/api-client';
import { newClientMsgId } from '@/lib/realtime/staff/client-id';
import { failureOf } from '@/lib/realtime/staff/send-failure';
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

/** The server's fallback for the typing whisper (it cannot publish `client-*` events): `{ v, actor, typing }`. Both feed the same typing helper. */
const TYPING_FALLBACK_EVENT = echoEvent(CHAT_EVENT.typingFallback);
const MAX_PAGES = 20;
/** After the attachment URLs were refreshed, a picture that still fails is broken: no second refresh for a while. */
export const ATTACHMENT_REFRESH_COOLDOWN_MS = 20_000;
/** A send that has not been answered by now is given up on (the message turns into a retryable failure; the queue moves on). */
export const SEND_TIMEOUT_MS = 20_000;

function withDeadline<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
            () =>
                reject(
                    new ApiError({
                        status: 0,
                        code: 'network',
                        message: 'The server took too long to answer.',
                    }),
                ),
            ms,
        );

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error: unknown) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

export type ConversationViewer = {
    id: number;
    name: string;
    avatarUrl: string | null;
};

export type SendInput = { body: string; attachments?: AttachmentData[] };

/** Callbacks the Echo bindings call; stable for the life of the hook. */
export type ConversationBridge = {
    messageCreated: (message: MessageData) => void;
    delivered: (receipt: {
        upToSeq: number;
        by: 'visitor' | 'agent' | 'system';
        at: string;
    }) => void;
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

    // A chat that LEAVES the agent's lists (transferred away, taken over by an admin) is no longer sent to this open view by
    // `conversation.updated`: read it again, and when the server no longer lets this agent see it say so.
    const wasListed = useRef(listed !== null);
    const [lostAccess, setLostAccess] = useState(false);

    useEffect(() => {
        if (listed) {
            wasListed.current = true;
            setLostAccess(false);

            return;
        }

        if (!wasListed.current || viewer.isAdmin) {
            return;
        }

        wasListed.current = false;
        api.conversation(ulid).then(
            (fresh) => dispatch({ type: 'conversation', conversation: fresh }),
            (error: unknown) => {
                if (
                    isApiError(error) &&
                    (error.status === 403 || error.status === 404)
                ) {
                    setLostAccess(true);
                }
            },
        );
    }, [listed, viewer.isAdmin, api, ulid]);

    /* ---------------------------------------------------------------- */
    /* Catch-up                                                         */
    /* ---------------------------------------------------------------- */

    const catching = useRef<Promise<void> | null>(null);
    const catchAgain = useRef(false);
    const catchAgainWithReceipts = useRef(false);

    /** `receipts`: also refresh the ticks of the agent's own messages (a poll, a reconnect, the tab coming back). */
    const catchUp = useCallback(
        (receipts = false): Promise<void> => {
            if (catching.current) {
                catchAgain.current = true;
                catchAgainWithReceipts.current ||= receipts;

                return catching.current;
            }

            catching.current = (async () => {
                try {
                    const held = latest.current.messages;
                    const top = highestSeq(held);
                    // Start at the first hole when there is one (a missed broadcast), else right after the newest message ...
                    let after = findGap(held, top)?.afterSeq ?? top;
                    // ... or earlier, when receipts may have been missed: the ticks of this agent's own messages change without any
                    // new message, and nothing replays an event that happened while the socket was down (or at all, when polling).
                    // Read again from the oldest of their messages that is not seen yet (at most one page back).
                    const unread = receipts
                        ? held.find(
                              (message) =>
                                  message.sender.type === 'agent' &&
                                  message.seq !== null &&
                                  message.status !== 'seen',
                          )
                        : undefined;

                    if (unread?.seq != null) {
                        after = Math.min(
                            after,
                            Math.max(unread.seq - 1, top - PAGE_LIMIT),
                        );
                    }

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
                        const again = catchAgainWithReceipts.current;

                        catchAgain.current = false;
                        catchAgainWithReceipts.current = false;
                        void catchUp(again);
                    }
                }
            })();

            return catching.current;
        },
        [api, ulid],
    );

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

        const timer = setInterval(() => void catchUp(true), POLL_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [connection, catchUp]);

    // Back in the foreground (not the first paint: the props are fresh): timers were throttled, so look now.
    const wasVisible = useRef(visible);

    useEffect(() => {
        if (visible && !wasVisible.current) {
            void catchUp(true);
        }

        wasVisible.current = visible;
    }, [visible, catchUp]);

    /**
     * Signed attachment URLs expire: when a picture fails to load the messages are read again (the server signs them afresh) and the
     * new URLs merged in. Single-flight, and once per failure burst: a picture that still fails afterwards is broken, not expired.
     */
    const refreshing = useRef<Promise<void> | null>(null);
    const refreshedAt = useRef(0);

    const refreshAttachmentUrls = useCallback((): Promise<void> => {
        if (refreshing.current) {
            return refreshing.current;
        }

        if (Date.now() - refreshedAt.current < ATTACHMENT_REFRESH_COOLDOWN_MS) {
            return Promise.resolve();
        }

        refreshing.current = (async () => {
            try {
                let after = 0;

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
            } catch {
                // The next failure after the cooldown tries again.
            } finally {
                refreshedAt.current = Date.now();
                refreshing.current = null;
            }
        })();

        return refreshing.current;
    }, [api, ulid]);

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

    // Messages leave one after the other, so the server numbers them in the order they were typed (two quick sends can overtake each other).
    const sendChain = useRef<Promise<void>>(Promise.resolve());

    const deliver = useCallback(
        (
            clientMsgId: string,
            body: string,
            attachments: AttachmentData[],
        ): Promise<void> => {
            const run = async (): Promise<void> => {
                try {
                    const message = await withDeadline(
                        api.sendMessage(ulid, {
                            clientMsgId,
                            body,
                            attachmentUlids: attachments.map((a) => a.ulid),
                        }),
                        SEND_TIMEOUT_MS,
                    );

                    dispatch({ type: 'acked', message });
                } catch (error) {
                    const failure = failureOf(error);

                    dispatch({ type: 'failed', clientMsgId, failure });

                    if (failure === 'closed') {
                        toast.error(describeStaffError(error, t));
                        void catchUp();
                    }
                }
            };
            const next = sendChain.current.then(run);

            sendChain.current = next;

            return next;
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
            report: (message: string) => void = (message) =>
                void toast.error(message),
        ): Promise<ConversationStaff | null> => {
            try {
                const answer = await call();
                // The staff form of a conversation carries the visitor; if the answer is the public form, read the full record.
                const next =
                    'visitor' in answer ? answer : await api.conversation(ulid);

                dispatch({ type: 'conversation', conversation: next });
                store.dispatch({
                    type: 'conversationUpdated',
                    conversation: next,
                    viewer,
                });

                return next;
            } catch (error) {
                report(describeStaffError(error, t));

                return null;
            }
        },
        [store, viewer, t, api, ulid],
    );

    const end = useCallback(() => act(() => api.end(ulid)), [act, api, ulid]);
    const close = useCallback(
        () => act(() => api.close(ulid)),
        [act, api, ulid],
    );
    const transfer = useCallback(
        (target: TransferTarget, report?: (message: string) => void) =>
            act(() => api.transfer(ulid, target), report),
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
            delivered: (receipt) =>
                dispatch({
                    type: 'delivered',
                    upToSeq: receipt.upToSeq,
                    by: receipt.by,
                    at: receipt.at,
                }),
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
            connected: () => void catchUp(true),
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
        /** The server no longer lets this agent see the chat (it was handed to somebody else). */
        lostAccess,
        canSend: canSend(state.conversation),
        connection,
        send,
        retry,
        discard,
        notifyTyping,
        catchUp,
        refreshAttachmentUrls,
        end,
        close,
        transfer,
        bridge,
    };
}

export type ConversationController = ReturnType<typeof useConversation>;

/**
 * Renders nothing: binds `private-conversation.{ulid}` (`message.created`, `message.delivered`, `message.seen`, `conversation.ended`, `conversation.closed`,
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
    useChannelEvent(channel, CHAT_EVENT.messageDelivered, (payload) =>
        bridge.delivered({
            upToSeq: payload.upToSeq,
            by: payload.by,
            at: payload.at,
        }),
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
