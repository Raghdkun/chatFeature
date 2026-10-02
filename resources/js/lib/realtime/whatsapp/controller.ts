/**
 * The side effects behind the WhatsApp live store: the realtime events go in (`handle`), and what an event cannot tell (a gap while the
 * websocket was down, the first picture, an unread count changed elsewhere) is read over REST (`sync`). It owns the polling fallback:
 * while the websocket is not connected the unread summary is read again every `POLL_INTERVAL_MS` (15 s) when a WhatsApp page is open and
 * every minute otherwise, so a dashboard without realtime still shows the badge.
 *
 * Page-level data (a transcript, the chat list with its filters, the session list) is read by the hooks of those pages; this controller
 * only keeps the unread summary and the store's connection state, and routes the four broadcast events.
 */
import { isApiError } from '@/lib/api-client';
import { PAYLOAD_VERSION, WA_EVENT } from '@/lib/chat/events';
import type { WaEventName, WaEventPayloads } from '@/lib/chat/events';
import { POLL_INTERVAL_MS } from '@/lib/realtime/staff/controller';
import type {
    ConnectionState,
    WaLiveStore,
} from '@/lib/realtime/whatsapp/store';
import type { WaApi } from '@/lib/whatsapp-api/client';

export { POLL_INTERVAL_MS };

/** The poll while nothing WhatsApp is on screen (the badge only). */
export const BACKGROUND_POLL_INTERVAL_MS = 60_000;

/** How many unread chats the summary reads (an inbox with more has a worse problem than a stale badge). */
export const UNREAD_PAGE_LIMIT = 100;

export const WA_EVENTS: readonly WaEventName[] = Object.values(WA_EVENT);

export type WaControllerDeps = {
    store: WaLiveStore;
    api: WaApi;
};

export function createWaController(deps: WaControllerDeps) {
    const { store, api } = deps;
    let started = false;
    let syncing: Promise<void> | null = null;
    let syncAgain = false;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let watchers = 0;
    /** The API answered 403 / 404: nothing to poll for (not an administrator, or the area is not there). Retried when the tab returns. */
    let unavailable = false;

    /* ---------------------------------------------------------------- */
    /* Events                                                           */
    /* ---------------------------------------------------------------- */

    function handle<E extends WaEventName>(
        event: E,
        payload: WaEventPayloads[E],
    ): void {
        // Only the payload version this client understands (docs/contracts/whatsapp-data-p6.md: every payload starts with `v: 1`).
        if ((payload as { v?: number }).v !== PAYLOAD_VERSION) {
            return;
        }

        switch (event) {
            case WA_EVENT.messageCreated: {
                const { chat, message } =
                    payload as WaEventPayloads['wa.message.created'];

                store.dispatch({ type: 'chatChanged', chat });
                store.dispatch({ type: 'messageChanged', message });
                break;
            }
            case WA_EVENT.messageUpdated:
                store.dispatch({
                    type: 'messageChanged',
                    message: (payload as WaEventPayloads['wa.message.updated'])
                        .message,
                });
                break;
            case WA_EVENT.chatUpdated:
                store.dispatch({
                    type: 'chatChanged',
                    chat: (payload as WaEventPayloads['wa.chat.updated']).chat,
                });
                break;
            case WA_EVENT.sessionStatus:
                store.dispatch({
                    type: 'sessionChanged',
                    session: (payload as WaEventPayloads['wa.session.status'])
                        .session,
                });
                break;
        }
    }

    /* ---------------------------------------------------------------- */
    /* REST                                                             */
    /* ---------------------------------------------------------------- */

    /** The unread summary: the open chats with something unread. Single-flight; a call that arrives meanwhile runs once more after it. */
    function sync(): Promise<void> {
        if (syncing) {
            syncAgain = true;

            return syncing;
        }

        syncing = (async () => {
            const since = store.getState().clock;

            try {
                const page = await api.chats({
                    status: 'open',
                    unread: true,
                    limit: UNREAD_PAGE_LIMIT,
                });

                unavailable = false;
                store.dispatch({
                    type: 'chatsLoaded',
                    chats: page.chats.filter((chat) => chat.unreadByAdmin > 0),
                    since,
                    unreadOnly: true,
                });
            } catch (error) {
                if (
                    isApiError(error) &&
                    (error.status === 403 || error.status === 404)
                ) {
                    unavailable = true;
                }
                // Anything else: the next poll, reconnect or wake tries again.
            } finally {
                syncing = null;

                if (syncAgain) {
                    syncAgain = false;
                    void sync();
                }
            }
        })();

        return syncing;
    }

    /* ---------------------------------------------------------------- */
    /* Connection and lifecycle                                         */
    /* ---------------------------------------------------------------- */

    function setConnection(status: ConnectionState): void {
        const previous = store.getState().connection;

        store.dispatch({ type: 'connection', status });

        // Back online after a drop: whatever happened meanwhile is a REST call away.
        if (status === 'connected' && previous !== 'connected' && started) {
            void sync();
        }
    }

    function schedule(): void {
        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        if (!started) {
            return;
        }

        pollTimer = setInterval(
            () => {
                if (
                    store.getState().connection !== 'connected' &&
                    !unavailable
                ) {
                    void sync();
                }
            },
            watchers > 0 ? POLL_INTERVAL_MS : BACKGROUND_POLL_INTERVAL_MS,
        );
    }

    /** A WhatsApp page is on screen: poll at the page's pace while the websocket is down. Returns the function that says it left. */
    function watch(): () => void {
        watchers += 1;
        schedule();

        let released = false;

        return () => {
            if (released) {
                return;
            }

            released = true;
            watchers -= 1;
            schedule();
        };
    }

    /** The tab came back to the foreground: timers may have been throttled, so look now (and try again after a refusal). */
    function wake(): void {
        if (!started) {
            return;
        }

        unavailable = false;
        void sync();
    }

    function start(): void {
        if (started) {
            return;
        }

        started = true;
        schedule();
        void sync();
    }

    function stop(): void {
        started = false;

        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }
    }

    return {
        start,
        stop,
        handle,
        sync,
        wake,
        watch,
        setConnection,
    };
}

export type WaController = ReturnType<typeof createWaController>;
