/**
 * The brain of the agent's live inbox, framework-free: it turns realtime events and REST snapshots into store actions, and owns
 * every timer (offer expiry and exit, the 30 s presence heartbeat, the 15 s polling fallback). The React layer
 * (`use-staff-realtime.ts`) only feeds it Echo callbacks and the connection status, so each rule is covered by plain unit tests
 * with fake timers, a fake API and a recording `effects` object.
 */
import { isApiError } from '@/lib/api-client';
import {
    alreadyClaimedBy,
    describeStaffError,
    type StaffApi,
} from '@/lib/chat-api/staff';
import type { ChatEventPayloads } from '@/lib/chat/events';
import type {
    ConversationStaff,
    OfferData,
    PresenceStatus,
    SessionRevokeReason,
} from '@/lib/chat/types';
import {
    nextExpiryMs,
    OFFER_EXIT_MS,
    type ConnectionState,
    type InboxStore,
    type Viewer,
} from '@/lib/realtime/staff/store';
import type { SoundKind } from '@/lib/realtime/staff/sound';
import type { OsNotificationOptions } from '@/lib/realtime/staff/os-notification';

/** The REST polling interval while the websocket is down, and the presence heartbeat interval (docs/contracts/rest-shapes.md). */
export const POLL_INTERVAL_MS = 15_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;
/**
 * The management API does not extend the session lifetime (it never writes the session), so an inbox left open all shift would be
 * signed out when the lifetime runs out: `GET /session/keepalive` is sent every 20 minutes and when a tab that was hidden for more
 * than 10 minutes comes back (its timers were throttled and the lifetime may be close).
 */
export const KEEPALIVE_INTERVAL_MS = 20 * 60_000;
export const KEEPALIVE_AFTER_HIDDEN_MS = 10 * 60_000;
/**
 * The server may have changed the agent's status while this tab could not hear it (a sleeping laptop, a background tab whose timers were
 * throttled, a socket that was down): after a gap this long between two beats, or a tab hidden this long, the status is asked again once
 * the beat is out, so the selector never keeps saying "Online" for an agent the server already considers offline.
 */
export const PRESENCE_RESYNC_AFTER_MS = 3 * HEARTBEAT_INTERVAL_MS;
/** `setTimeout` takes a 32-bit delay; a longer wait (a deadline days away) fires early and is simply re-planned. */
const MAX_TIMER_MS = 2_000_000_000;
/** Coalesces a burst of `queue.updated` events into one refetch. */
export const SYNC_DEBOUNCE_MS = 400;

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

export type ToastKind = 'offer' | 'info' | 'success' | 'error';

export type ToastOptions = {
    description?: string;
    action?: { label: string; onClick: () => void };
    /** Milliseconds; `Infinity` keeps it until dismissed. */
    duration?: number;
    /** Same id replaces the previous toast (an offer's toast is dismissed when somebody else takes the chat). */
    id?: string;
};

/** Everything the controller does to the outside world; the React layer supplies the real ones, tests record them. */
export type StaffEffects = {
    playSound: (kind: SoundKind) => void;
    toast: (kind: ToastKind, message: string, options?: ToastOptions) => void;
    dismissToast: (id: string) => void;
    notify: (options: OsNotificationOptions) => void;
    closeNotification: (tag: string) => void;
    /** The websocket said this session is over: leave. */
    signOut: (reason: SessionRevokeReason) => void;
    /** Open a conversation (toast action, notification click). */
    openConversation: (ulid: string) => void;
};

export type StaffControllerDeps = {
    store: InboxStore;
    api: StaffApi;
    viewer: Viewer & { isAgent: boolean };
    t: Translate;
    effects: StaffEffects;
    /** Whether the agent is looking at this conversation right now (open in the view, tab visible). */
    isViewing: (ulid: string) => boolean;
    /** Whether this tab is in the foreground; every heartbeat says so (default: `document.visibilityState`). */
    isVisible?: () => boolean;
    now?: () => number;
};

export type StaffEventName =
    | 'chat.offered'
    | 'chat.taken'
    | 'chat.assigned'
    | 'conversation.updated'
    | 'unread.updated'
    | 'queue.updated'
    | 'session.revoked'
    | 'presence.changed'
    | 'offline-ticket.created';

/** The events of `private-staff.{id}` (and, for admins, `private-admin`) the controller understands. */
export const STAFF_EVENTS: readonly StaffEventName[] = [
    'chat.offered',
    'chat.taken',
    'chat.assigned',
    'conversation.updated',
    'unread.updated',
    'queue.updated',
    'session.revoked',
    'presence.changed',
    'offline-ticket.created',
];

export type ClaimOutcome =
    | { ok: true; conversation: ConversationStaff }
    | { ok: false; reason: 'taken' | 'failed' };

export function offerTag(ulid: string): string {
    return `offer-${ulid}`;
}

export function createStaffController(deps: StaffControllerDeps) {
    const { store, api, viewer, t, effects } = deps;
    const now = deps.now ?? Date.now;
    const isVisible =
        deps.isVisible ??
        (() =>
            typeof document === 'undefined' ||
            document.visibilityState === 'visible');

    let started = false;
    let syncing: Promise<void> | null = null;
    let syncAgain = false;
    let syncTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryTimer: ReturnType<typeof setTimeout> | null = null;
    let expiryAt: number | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let keepAliveTimer: ReturnType<typeof setInterval> | null = null;
    let hiddenSince: number | null = null;
    let lastBeatTick = 0;
    /** Bumped by every own status change (a choice, an event): an answer to an older `GET /me/presence` is not applied. */
    let presenceEpoch = 0;
    let unsubscribe: (() => void) | null = null;
    const exitTimers = new Map<string, ReturnType<typeof setTimeout>>();

    function visitorLabel(name: string | null): string {
        return name && name.trim() !== '' ? name : t('inbox.visitor.anonymous');
    }

    /* ---------------------------------------------------------------- */
    /* Snapshots                                                        */
    /* ---------------------------------------------------------------- */

    /** Re-read the lists over REST (a poll tick, a reconnect, `queue.updated`). Overlapping calls collapse into one more run. */
    function sync(): Promise<void> {
        if (syncing) {
            syncAgain = true;

            return syncing;
        }

        syncing = (async () => {
            // Whatever the events change while the requests are out is newer than the snapshot they bring back.
            const since = store.getState().clock;

            try {
                const [queue, active, queuedTickets, activeTickets] =
                    await Promise.all([
                        api.queue(),
                        api.conversations({
                            status: 'active',
                            type: 'live',
                            limit: 100,
                        }),
                        api.conversations({
                            status: 'queued',
                            type: 'offline',
                            limit: 100,
                        }),
                        api.conversations({
                            status: 'active',
                            type: 'offline',
                            limit: 100,
                        }),
                    ]);

                store.dispatch({
                    type: 'hydrate',
                    queue: queue.filter((item) => item.type === 'live'),
                    mine: active,
                    tickets: [...queuedTickets, ...activeTickets].filter(
                        (ticket) =>
                            viewer.isAdmin ||
                            ticket.status === 'queued' ||
                            ticket.assignedAgent?.id === viewer.id,
                    ),
                    keepFinished: true,
                    since,
                });
            } catch {
                // Offline or signed out: the next tick tries again; the 401 handler of the api client deals with sign-out.
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

    function scheduleSync(): void {
        if (syncTimer !== null) {
            return;
        }

        syncTimer = setTimeout(() => {
            syncTimer = null;
            void sync();
        }, SYNC_DEBOUNCE_MS);
    }

    /**
     * A live chat that is `queued` and that an agent holds no card for (a direct transfer made to them, an offer whose push was missed)
     * reaches them as a plain list refresh, which places nothing in their queue but does count as newer than a snapshot that is
     * already on its way: that snapshot's row for the chat would be thrown away and nothing would ask again. Ask once more.
     */
    function syncIfQueuedForNobodyHere(conversation: ConversationStaff): void {
        if (
            viewer.isAdmin ||
            conversation.status !== 'queued' ||
            conversation.type !== 'live' ||
            store
                .getState()
                .queue.some((item) => item.conversation === conversation.ulid)
        ) {
            return;
        }

        scheduleSync();
    }

    /* ---------------------------------------------------------------- */
    /* Offers: expiry and exit                                          */
    /* ---------------------------------------------------------------- */

    function dismissLater(conversation: string): void {
        if (exitTimers.has(conversation)) {
            return;
        }

        exitTimers.set(
            conversation,
            setTimeout(() => {
                exitTimers.delete(conversation);
                store.dispatch({ type: 'dismiss', conversation });
            }, OFFER_EXIT_MS),
        );
    }

    /** Re-plan the single timer for the earliest open offer, and the exit timers of cards that lost or lapsed. */
    function plan(): void {
        const state = store.getState();

        for (const item of state.queue) {
            if (item.state !== 'open') {
                dismissLater(item.conversation);
            }
        }

        const next = nextExpiryMs(state);

        if (next === expiryAt) {
            return;
        }

        if (expiryTimer !== null) {
            clearTimeout(expiryTimer);
            expiryTimer = null;
        }

        expiryAt = next;

        if (next !== null) {
            expiryTimer = setTimeout(
                () => {
                    expiryTimer = null;
                    expiryAt = null;
                    store.dispatch({ type: 'expire', nowMs: now() });
                    plan();
                },
                Math.min(Math.max(0, next - now()), MAX_TIMER_MS),
            );
        }
    }

    /* ---------------------------------------------------------------- */
    /* Claim                                                            */
    /* ---------------------------------------------------------------- */

    /** Accept a request. `409 already_claimed` is not an error to the agent: the card turns into "Taken by Sam". */
    async function claim(ulid: string): Promise<ClaimOutcome> {
        try {
            const conversation = await api.claim(ulid);

            effects.closeNotification(offerTag(ulid));
            effects.dismissToast(offerTag(ulid));
            store.dispatch({
                type: 'conversationUpdated',
                conversation,
                viewer,
            });
            store.dispatch({ type: 'dismiss', conversation: ulid });

            return { ok: true, conversation };
        } catch (error) {
            const lost = alreadyClaimedBy(error);

            if (lost) {
                store.dispatch({
                    type: 'taken',
                    conversation: ulid,
                    by: lost.by,
                });
                effects.dismissToast(offerTag(ulid));
                effects.toast(
                    'info',
                    lost.by
                        ? t('inbox.error.taken_by', { name: lost.by })
                        : t('inbox.error.taken'),
                );

                return { ok: false, reason: 'taken' };
            }

            effects.toast('error', describeStaffError(error, t));

            return { ok: false, reason: 'failed' };
        }
    }

    /* ---------------------------------------------------------------- */
    /* Presence                                                         */
    /* ---------------------------------------------------------------- */

    async function setPresence(status: PresenceStatus): Promise<boolean> {
        const previous = store.getState().presence;

        presenceEpoch++;
        store.dispatch({ type: 'presence', status });

        try {
            const saved = await api.setPresence(status);
            // The answer carries the stored status; an empty answer means the request itself is the confirmation.
            const stored = saved?.status ?? status;

            store.dispatch({ type: 'presence', status: stored });

            if (stored !== 'offline') {
                void sendHeartbeat();
            }

            return true;
        } catch (error) {
            if (previous !== null) {
                store.dispatch({ type: 'presence', status: previous });
            }

            effects.toast('error', describeStaffError(error, t));

            return false;
        }
    }

    /** The caller's own status, when the page did not bring it (any page but the inbox): then the first beat. */
    async function loadPresence(): Promise<void> {
        if (store.getState().presence !== null) {
            return sendHeartbeat();
        }

        try {
            const own = await api.presence();

            store.dispatch({ type: 'presence', status: own.status });

            return sendHeartbeat();
        } catch {
            // Unknown stays unknown: the selector shows "unavailable" and the next page load tries again.
        }
    }

    async function sendHeartbeat(): Promise<void> {
        const status = store.getState().presence;

        if (status !== 'online' && status !== 'away') {
            return;
        }

        try {
            await api.heartbeat(isVisible());
        } catch {
            // A missed beat is covered by the 90 s window; the next one retries.
        }
    }

    /** What the server says my status is now (the beat that was just sent may have changed it), unless I changed it myself meanwhile. */
    async function refreshPresence(): Promise<void> {
        const epoch = presenceEpoch;

        try {
            const own = await api.presence();

            if (started && epoch === presenceEpoch) {
                store.dispatch({ type: 'presence', status: own.status });
            }
        } catch {
            // Unknown stays as it is: the next resync or event settles it.
        }
    }

    /** The interval beat; a long gap since the last one (the timers were suspended) also re-reads the status. */
    async function heartbeatTick(): Promise<void> {
        const gap = now() - lastBeatTick;

        lastBeatTick = now();
        await sendHeartbeat();

        if (gap > PRESENCE_RESYNC_AFTER_MS) {
            await refreshPresence();
        }
    }

    /**
     * Extends the session lifetime. A failure proves nothing (offline, a hiccup: the next tick tries again) except `401` / `419`: the
     * session is over, which is handled like a confirmed revocation.
     */
    async function keepAlive(): Promise<void> {
        try {
            await api.keepAlive();
        } catch (error) {
            if (
                isApiError(error) &&
                (error.status === 401 || error.status === 419)
            ) {
                effects.signOut('auth_revoked');
            }
        }
    }

    /**
     * `session.revoked` reaches every open tab of that person, whichever session was revoked. So the event is only a hint: ask the
     * server (any authenticated call) and leave only when it confirms THIS session is over (`401`, or `403 no_chat_access` once the
     * role is gone). A call that succeeds means another session was revoked; one that fails for any other reason proves nothing, and
     * the next heartbeat or poll will meet the same `401` anyway.
     */
    async function confirmRevoked(reason: SessionRevokeReason): Promise<void> {
        try {
            await api.presence();
        } catch (error) {
            if (
                isApiError(error) &&
                (error.status === 401 || error.code === 'no_chat_access')
            ) {
                effects.signOut(reason);
            }
        }
    }

    /* ---------------------------------------------------------------- */
    /* Events                                                           */
    /* ---------------------------------------------------------------- */

    function onOffered(offer: OfferData): void {
        if (!viewer.isAgent) {
            return;
        }

        store.dispatch({ type: 'offered', offer, nowMs: now() });
        effects.playSound('offer');

        const who = visitorLabel(offer.visitor.name);
        const topic = offer.category?.label ?? t('inbox.category.none');

        effects.toast('offer', t('inbox.toast.offer_title'), {
            id: offerTag(offer.conversation),
            description: t('inbox.toast.offer_body', { name: who, topic }),
            action: {
                label: t('inbox.accept'),
                onClick: () => {
                    void claim(offer.conversation).then((outcome) => {
                        if (outcome.ok) {
                            effects.openConversation(offer.conversation);
                        }
                    });
                },
            },
            duration: 12_000,
        });
        effects.notify({
            title: t('inbox.toast.offer_title'),
            body: t('inbox.toast.offer_body', { name: who, topic }),
            tag: offerTag(offer.conversation),
            kind: 'offer',
            // With previews off the page says what the push says: the topic (admin-defined), nothing the visitor typed or is called.
            generic: { title: t('inbox.toast.offer_title'), body: topic },
            onClick: () => effects.openConversation(offer.conversation),
        });
    }

    function onTaken(payload: ChatEventPayloads['chat.taken']): void {
        store.dispatch({
            type: 'taken',
            conversation: payload.conversation,
            by: payload.by.name,
        });
        effects.dismissToast(offerTag(payload.conversation));
        effects.closeNotification(offerTag(payload.conversation));
    }

    async function onAssigned(
        payload: ChatEventPayloads['chat.assigned'],
    ): Promise<void> {
        try {
            const conversation = await api.conversation(payload.conversation);

            store.dispatch({
                type: 'conversationUpdated',
                conversation,
                viewer,
            });
            syncIfQueuedForNobodyHere(conversation);
            effects.playSound('offer');
            effects.toast('info', t('inbox.toast.assigned'), {
                description: visitorLabel(conversation.visitor.name),
                action: {
                    label: t('inbox.toast.open'),
                    onClick: () =>
                        effects.openConversation(payload.conversation),
                },
            });
        } catch {
            scheduleSync();
        }
    }

    function onUnread(payload: ChatEventPayloads['unread.updated']): void {
        const before = store
            .getState()
            .mine.find((item) => item.ulid === payload.conversation);

        if (deps.isViewing(payload.conversation)) {
            // The agent is reading it: the view posts the receipt, the badge must not flash.
            store.dispatch({
                type: 'seen',
                conversation: payload.conversation,
            });

            return;
        }

        store.dispatch({
            type: 'unread',
            conversation: payload.conversation,
            unseen: payload.unseen,
        });

        if (before && payload.unseen > before.unseenByAgent) {
            const who = visitorLabel(before.visitor.name);

            effects.playSound('message');
            effects.notify({
                title: t('inbox.toast.message_title', { name: who }),
                body: before.lastMessagePreview ?? undefined,
                tag: `message-${payload.conversation}`,
                kind: 'message',
                generic: {
                    title: t('notifications.push.message_title_private'),
                    body: t('notifications.push.message_body_private'),
                },
                onClick: () => effects.openConversation(payload.conversation),
            });
        }
    }

    /** Dispatch one server event. Unknown versions are ignored (a newer server must not break an older tab). */
    function handle<E extends StaffEventName>(
        event: E,
        payload: ChatEventPayloads[E],
    ): void {
        if ((payload as { v?: number }).v !== 1) {
            return;
        }

        switch (event) {
            case 'chat.offered':
                onOffered(payload as OfferData);
                break;
            case 'chat.taken':
                onTaken(payload as ChatEventPayloads['chat.taken']);
                break;
            case 'chat.assigned':
                void onAssigned(payload as ChatEventPayloads['chat.assigned']);
                break;
            case 'conversation.updated': {
                const { conversation } =
                    payload as ChatEventPayloads['conversation.updated'];

                store.dispatch({
                    type: 'conversationUpdated',
                    conversation,
                    viewer,
                });
                syncIfQueuedForNobodyHere(conversation);
                break;
            }
            case 'unread.updated':
                onUnread(payload as ChatEventPayloads['unread.updated']);
                break;
            case 'queue.updated':
                scheduleSync();
                break;
            case 'session.revoked':
                void confirmRevoked(
                    (payload as ChatEventPayloads['session.revoked']).reason,
                );
                break;
            case 'presence.changed': {
                const change = payload as ChatEventPayloads['presence.changed'];

                store.dispatch({
                    type: 'rosterStatus',
                    id: change.userId,
                    status: change.status,
                });
                store.dispatch({
                    type: 'presenceSeen',
                    id: change.userId,
                    status: change.status,
                    at: now(),
                });

                if (change.userId === viewer.id) {
                    presenceEpoch++;
                    store.dispatch({ type: 'presence', status: change.status });
                }

                break;
            }
            case 'offline-ticket.created': {
                const created =
                    payload as ChatEventPayloads['offline-ticket.created'];

                store.dispatch({
                    type: 'conversationUpdated',
                    conversation: created.conversation,
                    viewer,
                });
                effects.playSound('message');
                effects.toast('info', t('inbox.toast.ticket'), {
                    description: visitorLabel(
                        created.conversation.visitor.name,
                    ),
                    action: {
                        label: t('inbox.toast.open'),
                        onClick: () =>
                            effects.openConversation(created.conversation.ulid),
                    },
                });
                break;
            }
        }
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

    /** The tab went to the background: remember since when, to know on its return whether the session needs a keep-alive. */
    function sleep(): void {
        if (started && hiddenSince === null) {
            hiddenSince = now();
        }
    }

    /** The tab came back to the foreground: timers may have been throttled, so catch up now. */
    function wake(): void {
        if (!started) {
            return;
        }

        const away = hiddenSince === null ? 0 : now() - hiddenSince;

        hiddenSince = null;
        lastBeatTick = now();
        void sync();
        // The tab is visible again: say so at once (a visible beat brings an agent who went away back online), then, after a long absence,
        // learn what the server made of it.
        void sendHeartbeat().then(() =>
            away > PRESENCE_RESYNC_AFTER_MS ? refreshPresence() : undefined,
        );

        if (away > KEEPALIVE_AFTER_HIDDEN_MS) {
            void keepAlive();
        }
    }

    function start(): void {
        if (started) {
            return;
        }

        started = true;
        unsubscribe = store.subscribe(plan);
        plan();
        pollTimer = setInterval(() => {
            if (store.getState().connection !== 'connected') {
                void sync();
            }
        }, POLL_INTERVAL_MS);
        lastBeatTick = now();
        heartbeatTimer = setInterval(
            () => void heartbeatTick(),
            HEARTBEAT_INTERVAL_MS,
        );
        keepAliveTimer = setInterval(
            () => void keepAlive(),
            KEEPALIVE_INTERVAL_MS,
        );
        void loadPresence();

        if (!store.getState().hydrated) {
            void sync();
        }
    }

    function stop(): void {
        started = false;
        unsubscribe?.();
        unsubscribe = null;

        for (const timer of [syncTimer, expiryTimer]) {
            if (timer !== null) {
                clearTimeout(timer);
            }
        }

        syncTimer = null;
        expiryTimer = null;
        expiryAt = null;

        if (pollTimer !== null) {
            clearInterval(pollTimer);
            pollTimer = null;
        }

        if (heartbeatTimer !== null) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }

        if (keepAliveTimer !== null) {
            clearInterval(keepAliveTimer);
            keepAliveTimer = null;
        }

        hiddenSince = null;

        exitTimers.forEach((timer) => clearTimeout(timer));
        exitTimers.clear();
    }

    return {
        start,
        stop,
        handle,
        sync,
        wake,
        claim,
        setPresence,
        setConnection,
        sleep,
        /** Exposed for tests. */
        heartbeat: sendHeartbeat,
    };
}

export type StaffController = ReturnType<typeof createStaffController>;
