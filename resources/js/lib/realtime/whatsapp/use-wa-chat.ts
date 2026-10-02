/**
 * Everything the open WhatsApp chat needs: its live copy and transcript (the store, fed by the page props, the websocket and REST),
 * the reply pipeline (optimistic -> stored -> acked, or failed -> retry), catch-up after a reconnect / a background tab / a poll, older
 * history on request, signed image URLs that are read again when one expires, and "mark read" while the admin is looking.
 *
 * Without a websocket (or while it is down) the hook polls `GET .../messages?after=` every 15 s, the same pace as the staff inbox.
 */
import { usePage } from '@inertiajs/react';
import {
    useCallback,
    useEffect,
    useLayoutEffect,
    useMemo,
    useReducer,
    useRef,
    useState,
    useSyncExternalStore,
} from 'react';
import { ApiError } from '@/lib/api-client';
import { newClientMsgId } from '@/lib/realtime/staff/client-id';
import {
    useWaRealtime,
    useWaRetain,
    useWaState,
    useWaWatch,
} from '@/lib/realtime/whatsapp/context';
import { POLL_INTERVAL_MS } from '@/lib/realtime/whatsapp/controller';
import type { WaApi } from '@/lib/whatsapp-api/client';
import {
    displayMessages,
    highestUlid,
    isUncertainSendFailure,
    outboxReducer,
    pendingOutbox,
    sendFailureOf,
    syncCursor,
    type ComposerBlock,
    type DisplayMessage,
    type OutboxEntry,
    type WaSendFailure,
} from '@/lib/whatsapp/transcript';
import type { WaChat, WaMessage } from '@/lib/whatsapp/types';

/** How long a mark-read waits: a tab flicked past is not reading. */
export const READ_DELAY_MS = 400;
/** A reply that has not been answered by now is given up on (it turns into a failure that a retry looks into first). */
export const SEND_TIMEOUT_MS = 20_000;
/** After the signed URLs were refreshed, a photo that still fails is broken, not expired: no second refresh for a while. */
export const MEDIA_REFRESH_COOLDOWN_MS = 20_000;
const PAGE_LIMIT = 100;
const OLDER_LIMIT = 50;
const MAX_PAGES = 10;

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

export type WaChatOptions = {
    chat: WaChat;
    messages: WaMessage[];
    /** The page props say there is older history than the transcript starts with. */
    hasOlder: boolean;
    /** `whatsapp.reply_only_to_inbound`: a chat the customer did not start cannot be answered. `undefined`: not known here, the API decides. */
    replyOnlyToInbound?: boolean;
    api?: WaApi;
};

export function useWaChat({
    chat: initialChat,
    messages: initialMessages,
    hasOlder: initialHasOlder,
    replyOnlyToInbound,
    api: injectedApi,
}: WaChatOptions) {
    const { store, api: contextApi } = useWaRealtime();
    const api = injectedApi ?? contextApi;
    const { auth } = usePage().props;
    const me = useMemo(
        () => ({ id: auth.user?.id ?? 0, name: auth.user?.name ?? '' }),
        [auth.user?.id, auth.user?.name],
    );
    const ulid = initialChat.ulid;

    // An open chat needs the live data whatever page it sits in, and polls at the page's pace while the websocket is down.
    useWaRetain();
    useWaWatch();

    const [outbox, dispatch] = useReducer(outboxReducer, []);
    const latestOutbox = useRef<OutboxEntry[]>(outbox);
    const visible = useDocumentVisible();
    const connection = useWaState((state) => state.connection);
    const [hasOlder, setHasOlder] = useState(initialHasOlder);
    const [loadingOlder, setLoadingOlder] = useState(false);
    const [pausedUntil, setPausedUntil] = useState<number | null>(null);

    useEffect(() => {
        latestOutbox.current = outbox;
    });

    // The server's props are authoritative whenever Inertia reloads them; the merge is idempotent and forward-only.
    useLayoutEffect(() => {
        store.dispatch({
            type: 'chatsLoaded',
            chats: [initialChat],
            since: store.getState().clock,
        });
        store.dispatch({
            type: 'messagesLoaded',
            chat: ulid,
            messages: initialMessages,
        });
    }, [store, ulid, initialChat, initialMessages]);

    const chat = useWaState((state) => state.chats[ulid]) ?? initialChat;
    const server =
        useWaState((state) => state.messages[ulid]) ?? initialMessages;
    const sessionStatus = useWaState(
        (state) => state.sessions[chat.session.ulid]?.status ?? null,
    );

    const heldMessages = useCallback(
        (): WaMessage[] => store.getState().messages[ulid] ?? [],
        [store, ulid],
    );

    /* ---------------------------------------------------------------- */
    /* Catch-up                                                         */
    /* ---------------------------------------------------------------- */

    const catching = useRef<Promise<void> | null>(null);
    const catchAgain = useRef(false);

    /** Read what the websocket may have missed: newer messages, and the statuses of replies that have not settled yet. */
    const catchUp = useCallback((): Promise<void> => {
        if (catching.current) {
            catchAgain.current = true;

            return catching.current;
        }

        catching.current = (async () => {
            try {
                let after = syncCursor(heldMessages(), PAGE_LIMIT);

                for (let page = 0; page < MAX_PAGES; page++) {
                    const batch = await api.messages(ulid, {
                        ...(after === null ? {} : { after }),
                        limit: PAGE_LIMIT,
                    });

                    if (batch.messages.length > 0) {
                        store.dispatch({
                            type: 'messagesLoaded',
                            chat: ulid,
                            messages: batch.messages,
                        });
                        after = highestUlid(batch.messages) ?? after;
                    }

                    if (!batch.hasMore || batch.messages.length === 0) {
                        break;
                    }
                }
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
    }, [api, ulid, store, heldMessages]);

    // No websocket (or it dropped): poll while this chat is open.
    useEffect(() => {
        if (connection === 'connected') {
            return;
        }

        const timer = setInterval(() => void catchUp(), POLL_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [connection, catchUp]);

    // The websocket (re)connected: whatever was missed while it was down is a REST call away.
    const wasConnected = useRef(connection === 'connected');

    useEffect(() => {
        if (connection === 'connected' && !wasConnected.current) {
            void catchUp();
        }

        wasConnected.current = connection === 'connected';
    }, [connection, catchUp]);

    // Back in the foreground (not the first paint: the props are fresh): timers were throttled, so look now.
    const wasVisible = useRef(visible);

    useEffect(() => {
        if (visible && !wasVisible.current) {
            void catchUp();
        }

        wasVisible.current = visible;
    }, [visible, catchUp]);

    /* ---------------------------------------------------------------- */
    /* Older history and signed URLs                                    */
    /* ---------------------------------------------------------------- */

    const loadOlder = useCallback(async (): Promise<void> => {
        const oldest = heldMessages()[0];

        if (loadingOlder || oldest === undefined) {
            return;
        }

        setLoadingOlder(true);

        try {
            const page = await api.messages(ulid, {
                before: oldest.ulid,
                limit: OLDER_LIMIT,
            });

            store.dispatch({
                type: 'messagesLoaded',
                chat: ulid,
                messages: page.messages,
            });
            setHasOlder(page.hasMore && page.messages.length > 0);
        } catch {
            // The button stays; pressing it again retries.
        } finally {
            setLoadingOlder(false);
        }
    }, [api, ulid, store, heldMessages, loadingOlder]);

    const refreshing = useRef<Promise<void> | null>(null);
    const refreshedAt = useRef(0);

    /**
     * Signed image URLs expire (60 minutes): when a photo fails to load the newest messages are read again (the server signs them afresh)
     * and merged in. Single-flight, and once per failure burst: a photo that still fails afterwards is broken, not expired.
     */
    const refreshMediaUrls = useCallback((): Promise<void> => {
        if (refreshing.current) {
            return refreshing.current;
        }

        if (Date.now() - refreshedAt.current < MEDIA_REFRESH_COOLDOWN_MS) {
            return Promise.resolve();
        }

        refreshing.current = (async () => {
            try {
                const page = await api.messages(ulid, { limit: PAGE_LIMIT });

                store.dispatch({
                    type: 'messagesLoaded',
                    chat: ulid,
                    messages: page.messages,
                });
            } catch {
                // The next failure after the cooldown tries again.
            } finally {
                refreshedAt.current = Date.now();
                refreshing.current = null;
            }
        })();

        return refreshing.current;
    }, [api, ulid, store]);

    /* ---------------------------------------------------------------- */
    /* Read state                                                       */
    /* ---------------------------------------------------------------- */

    const unread = chat.unreadByAdmin;

    useEffect(() => {
        if (!visible || unread === 0) {
            return;
        }

        const timer = setTimeout(() => {
            store.dispatch({ type: 'chatRead', ulid });
            void api.markRead(ulid).catch(() => undefined);
        }, READ_DELAY_MS);

        return () => clearTimeout(timer);
    }, [visible, unread, ulid, api, store]);

    /* ---------------------------------------------------------------- */
    /* Sending                                                          */
    /* ---------------------------------------------------------------- */

    // Replies leave one after the other, so they reach WhatsApp in the order they were typed.
    const sendChain = useRef<Promise<void>>(Promise.resolve());

    const deliver = useCallback(
        (clientMsgId: string, body: string): Promise<void> => {
            const run = async (): Promise<void> => {
                try {
                    const message = await withDeadline(
                        api.sendMessage(ulid, { clientMsgId, body }),
                        SEND_TIMEOUT_MS,
                    );

                    store.dispatch({ type: 'messageChanged', message });
                    // A retried reply the server put back in its queue: the one step back from `failed` (a no-op for anything else).
                    store.dispatch({ type: 'messageRequeued', message });
                    dispatch({
                        type: 'acked',
                        clientMsgId,
                        ulid: message.ulid,
                    });
                } catch (error) {
                    const failure: WaSendFailure = sendFailureOf(error);
                    const retryAfter =
                        error instanceof ApiError ? error.retryAfter : null;

                    dispatch({
                        type: 'failed',
                        clientMsgId,
                        failure,
                        retryAfter,
                    });

                    if (failure === 'queue_unavailable') {
                        // The server stored the reply and marked it failed: read it back so the transcript shows the stored row's
                        // real state (the status event may not come), not a bubble that still says "sending".
                        void catchUp();
                    }

                    if (
                        retryAfter !== null &&
                        (failure === 'pacing' ||
                            failure === 'rate_limited' ||
                            failure === 'daily_cap')
                    ) {
                        setPausedUntil(Date.now() + retryAfter * 1000);
                    }
                }
            };
            const next = sendChain.current.then(run);

            sendChain.current = next;

            return next;
        },
        [api, ulid, store, catchUp],
    );

    const send = useCallback(
        async (body: string): Promise<void> => {
            const text = body.trim();

            if (text === '') {
                return;
            }

            const clientMsgId = newClientMsgId();

            dispatch({
                type: 'queued',
                entry: {
                    clientMsgId,
                    body: text,
                    createdAt: new Date().toISOString(),
                    state: 'sending',
                    failure: null,
                    retryAfter: null,
                    after: highestUlid(heldMessages()),
                    serverUlid: null,
                },
            });
            await deliver(clientMsgId, text);
        },
        [deliver, heldMessages],
    );

    /**
     * Retry a reply that did not go out. After a failure that says nothing about whether the server stored it (no answer, a dropped
     * connection), the transcript is read first: when the reply is there, it did go through, and sending it again would message the
     * customer twice.
     */
    const retry = useCallback(
        async (clientMsgId: string): Promise<void> => {
            const entry = latestOutbox.current.find(
                (item) =>
                    item.clientMsgId === clientMsgId && item.state === 'failed',
            );

            if (!entry) {
                return;
            }

            dispatch({ type: 'retrying', clientMsgId });

            if (isUncertainSendFailure(entry.failure)) {
                await catchUp();

                if (
                    pendingOutbox(heldMessages(), [entry], me.id).length === 0
                ) {
                    dispatch({ type: 'removed', clientMsgId });

                    return;
                }
            }

            await deliver(clientMsgId, entry.body);
        },
        [catchUp, deliver, heldMessages, me.id],
    );

    const discard = useCallback((clientMsgId: string): void => {
        dispatch({ type: 'removed', clientMsgId });
    }, []);

    /* ---------------------------------------------------------------- */
    /* Archive                                                          */
    /* ---------------------------------------------------------------- */

    const setArchived = useCallback(
        async (archived: boolean): Promise<WaChat> => {
            const updated = archived
                ? await api.archive(ulid)
                : await api.unarchive(ulid);

            store.dispatch({ type: 'chatChanged', chat: updated });

            return updated;
        },
        [api, ulid, store],
    );

    /**
     * Delete the chat (admin hard delete). Resolves once the server did it (a `404` means it is gone already, which is what was asked);
     * any other failure is thrown for the dialog to show. The chat leaves the live state at once.
     */
    const deleteChat = useCallback(async (): Promise<void> => {
        try {
            await api.deleteChat(ulid);
        } catch (error) {
            if (!(error instanceof ApiError && error.status === 404)) {
                throw error;
            }
        }

        store.dispatch({ type: 'chatRemoved', ulid });
    }, [api, ulid, store]);

    /* ---------------------------------------------------------------- */

    const block: ComposerBlock | null =
        replyOnlyToInbound === true && !chat.inboundInitiated
            ? 'not_inbound'
            : sessionStatus !== null && sessionStatus !== 'ready'
              ? 'session_not_ready'
              : null;

    const messages: DisplayMessage[] = useMemo(
        () => displayMessages(server, outbox, ulid, me),
        [server, outbox, ulid, me],
    );

    return {
        chat,
        messages,
        hasOlder,
        loadingOlder,
        loadOlder,
        send,
        retry,
        discard,
        pausedUntil,
        block,
        connection,
        catchUp,
        refreshMediaUrls,
        setArchived,
        deleteChat,
    };
}

export type WaChatController = ReturnType<typeof useWaChat>;
