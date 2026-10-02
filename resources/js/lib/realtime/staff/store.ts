/**
 * The agent dashboard's live lists: the queue of offers, "My chats", the offline tickets, presence, the colleague roster and the
 * websocket's health. Pure state (a reducer) behind a tiny external store, so the same data feeds the inbox page, the sidebar badge
 * and the document title, and every rule (who sees which chat, how an offer expires, how a claim race resolves) is testable
 * without React, a socket or a clock. Time always comes in through the action (`nowMs`).
 *
 * Sources, in order of authority: the server props / REST snapshot (`hydrate`), then the realtime events (`offered`, `taken`,
 * `conversationUpdated`, `unread`, ...). Every action is idempotent: a replayed or reordered event never duplicates a row.
 */
import type {
    CategoryRef,
    ConversationStaff,
    OfferData,
    PresenceMemberData,
    PresenceStatus,
} from '@/lib/chat/types';

export type QueueItemState = 'open' | 'taken' | 'expired';

/**
 * An offer as the server may send it. `ttlSeconds` (seconds until `expiresAt`, computed when the payload was built) is newer than the
 * generated type: a backend without it simply never sets it.
 */
export type OfferPayload = OfferData & { ttlSeconds?: number | null };

/** One pending request in the Queue column: a `chat.offered` payload, or a queued conversation known only from a snapshot. */
export type QueueItem = {
    conversation: string;
    ticketNo: string | null;
    category: CategoryRef | null;
    visitorName: string | null;
    verified: boolean;
    preview: string | null;
    widgetName: string | null;
    wave: number | null;
    /** ISO time the visitor started waiting (a snapshot) or the offer arrived (an offer without a snapshot). */
    waitingSince: string;
    /**
     * When the offer lapses, in THIS browser's clock: an offer that carries `ttlSeconds` is counted from the moment it arrived here
     * (the agent's clock may be minutes off the server's), otherwise the server's `expiresAt` / `queueExpiresAt` is used as sent.
     * `null` when nothing says (the UI counts up instead).
     */
    expiresAt: string | null;
    /** The length of the wait the deadline belongs to, in seconds (for the countdown ring); `null` when unknown. */
    totalSeconds: number | null;
    state: QueueItemState;
    /** Who won the race (`state === 'taken'`). */
    takenBy: string | null;
};

export type ConnectionState =
    | 'connected'
    | 'connecting'
    | 'reconnecting'
    | 'disconnected'
    | 'failed'
    /** No websocket in this page (not configured, or it threw): REST polling only. */
    | 'unavailable';

/** Who is looking: decides which conversations land in "My chats". */
export type Viewer = { id: number; isAdmin: boolean };

export type InboxState = {
    /** A snapshot (page props or REST) has been applied; before that the lists are unknown, not empty. */
    hydrated: boolean;
    queue: QueueItem[];
    /** Live chats being worked on (admins: everyone's), newest activity first. */
    mine: ConversationStaff[];
    /** Open offline tickets. */
    tickets: ConversationStaff[];
    /** The caller's own status; `null` until known. */
    presence: PresenceStatus | null;
    roster: PresenceMemberData[];
    /**
     * The last `presence.changed` heard for each member of staff (with the time it was heard): live updates for pages that list people
     * who are not on the roster (the agents page). Not a snapshot: ignore entries older than your own data.
     */
    seenPresence: Record<number, { status: PresenceStatus; at: number }>;
    connection: ConnectionState;
    /**
     * A counter bumped by every change to a conversation, and the value it had when each conversation last changed. A REST snapshot
     * remembers the clock it was requested at (`hydrate.since`), so an event that arrived while it was in flight is never overwritten
     * by the older picture the snapshot describes.
     */
    clock: number;
    touched: Record<string, number>;
};

export const EMPTY_INBOX: InboxState = {
    hydrated: false,
    queue: [],
    mine: [],
    tickets: [],
    presence: null,
    roster: [],
    seenPresence: {},
    connection: 'connecting',
    clock: 0,
    touched: {},
};

export type InboxAction =
    | {
          type: 'hydrate';
          queue?: ConversationStaff[];
          mine?: ConversationStaff[];
          tickets?: ConversationStaff[];
          /**
           * `mine` is a partial snapshot (REST only lists active chats): keep the finished ones already held instead of
           * dropping them.
           */
          keepFinished?: boolean;
          /** The store's `clock` when the snapshot was requested: conversations that changed since keep their live copy. */
          since?: number;
      }
    | { type: 'offered'; offer: OfferPayload; nowMs: number }
    | { type: 'taken'; conversation: string; by: string | null }
    | { type: 'dismiss'; conversation: string }
    | { type: 'expire'; nowMs: number }
    | {
          type: 'conversationUpdated';
          conversation: ConversationStaff;
          viewer: Viewer;
      }
    | { type: 'unread'; conversation: string; unseen: number }
    | { type: 'seen'; conversation: string }
    | { type: 'removed'; conversation: string }
    | { type: 'connection'; status: ConnectionState }
    | { type: 'presence'; status: PresenceStatus }
    | { type: 'rosterHere'; members: PresenceMemberData[] }
    | { type: 'rosterJoin'; member: PresenceMemberData }
    | { type: 'rosterLeave'; id: number }
    | { type: 'rosterStatus'; id: number; status: PresenceStatus }
    | { type: 'presenceSeen'; id: number; status: PresenceStatus; at: number };

/** How long a lost / lapsed offer card stays on screen (to be read) before it is removed. */
export const OFFER_EXIT_MS = 1_600;

function parseMs(iso: string | null | undefined, fallback: number): number {
    if (!iso) {
        return fallback;
    }

    const ms = Date.parse(iso);

    return Number.isNaN(ms) ? fallback : ms;
}

/** The time a conversation last did something: sorts "My chats". */
export function activityMs(conversation: ConversationStaff): number {
    return parseMs(
        conversation.lastMessageAt ??
            conversation.claimedAt ??
            conversation.createdAt,
        0,
    );
}

function byActivity(a: ConversationStaff, b: ConversationStaff): number {
    return activityMs(b) - activityMs(a);
}

function upsertSorted(
    list: ConversationStaff[],
    conversation: ConversationStaff,
): ConversationStaff[] {
    const rest = list.filter((item) => item.ulid !== conversation.ulid);

    // Times have second precision and the sort is stable: the conversation that just changed goes first, so among chats with the
    // same activity second the one that moved last is on top.
    return [conversation, ...rest].sort(byActivity);
}

function without<T extends { ulid: string }>(list: T[], ulid: string): T[] {
    return list.some((item) => item.ulid === ulid)
        ? list.filter((item) => item.ulid !== ulid)
        : list;
}

/** Rank used to ignore a stale `conversation.updated` that arrives after a later state (a chat never goes back from ended). */
const STATUS_RANK: Record<ConversationStaff['status'], number> = {
    queued: 0,
    active: 1,
    ended: 2,
    closed: 3,
    missed: 3,
};

/** True when `incoming` describes an earlier life of `current` (it must not overwrite it). Moving back to `queued` is a transfer: legal. */
export function isStaleUpdate(
    current: Pick<ConversationStaff, 'status' | 'lastSeq'>,
    incoming: Pick<ConversationStaff, 'status' | 'lastSeq'>,
): boolean {
    if (incoming.status === 'queued') {
        return false;
    }

    return (
        STATUS_RANK[incoming.status] < STATUS_RANK[current.status] ||
        (incoming.status === current.status &&
            incoming.lastSeq < current.lastSeq)
    );
}

/* -------------------------------------------------------------------------- */
/* Queue items                                                                */
/* -------------------------------------------------------------------------- */

/** How long the queue wait of a snapshot row lasts (a difference of two server times: the clocks cancel out). */
function queueSeconds(conversation: ConversationStaff): number | null {
    const start = Date.parse(conversation.createdAt);
    const end = Date.parse(conversation.queueExpiresAt ?? '');

    return Number.isNaN(start) || Number.isNaN(end)
        ? null
        : Math.max(1, Math.round((end - start) / 1000));
}

function itemFromConversation(
    conversation: ConversationStaff,
    existing?: QueueItem,
): QueueItem {
    return {
        conversation: conversation.ulid,
        ticketNo: conversation.ticketNo,
        category: conversation.category,
        visitorName: conversation.visitor.name,
        verified: conversation.visitor.verified,
        preview: conversation.lastMessagePreview ?? existing?.preview ?? null,
        widgetName: conversation.widget.name,
        wave: existing?.wave ?? null,
        waitingSince: conversation.createdAt,
        // An offer already counting in this browser's clock keeps its deadline; a snapshot row falls back to the queue deadline.
        expiresAt: existing?.expiresAt ?? conversation.queueExpiresAt ?? null,
        totalSeconds:
            existing?.totalSeconds ?? queueSeconds(conversation) ?? null,
        state: existing?.state === 'taken' ? 'taken' : 'open',
        takenBy: existing?.takenBy ?? null,
    };
}

function itemFromOffer(
    offer: OfferPayload,
    nowMs: number,
    existing?: QueueItem,
): QueueItem {
    const ttl =
        typeof offer.ttlSeconds === 'number' &&
        Number.isFinite(offer.ttlSeconds) &&
        offer.ttlSeconds >= 0
            ? offer.ttlSeconds
            : null;

    return {
        conversation: offer.conversation,
        ticketNo: existing?.ticketNo ?? null,
        category: offer.category,
        visitorName: offer.visitor.name,
        verified: offer.visitor.verified,
        preview: offer.preview ?? existing?.preview ?? null,
        widgetName: offer.widget.name,
        wave: offer.wave,
        waitingSince: existing?.waitingSince ?? new Date(nowMs).toISOString(),
        expiresAt:
            ttl === null
                ? offer.expiresAt
                : new Date(nowMs + ttl * 1000).toISOString(),
        totalSeconds: ttl,
        state: 'open',
        takenBy: null,
    };
}

function upsertItem(queue: QueueItem[], item: QueueItem): QueueItem[] {
    const index = queue.findIndex(
        (existing) => existing.conversation === item.conversation,
    );

    if (index === -1) {
        return [...queue, item].sort(byWaiting);
    }

    const next = [...queue];

    next[index] = item;

    return next;
}

function byWaiting(a: QueueItem, b: QueueItem): number {
    return parseMs(a.waitingSince, 0) - parseMs(b.waitingSince, 0);
}

function dropItem(queue: QueueItem[], ulid: string): QueueItem[] {
    return queue.some((item) => item.conversation === ulid)
        ? queue.filter((item) => item.conversation !== ulid)
        : queue;
}

/* -------------------------------------------------------------------------- */
/* Placement of a conversation snapshot                                       */
/* -------------------------------------------------------------------------- */

/** Offline tickets live in their own list while they are open (unclaimed, or claimed by the viewer / any, for an admin). */
function placeTicket(
    state: InboxState,
    conversation: ConversationStaff,
    viewer: Viewer,
): InboxState {
    const open =
        conversation.status === 'queued' ||
        (conversation.status === 'active' &&
            (viewer.isAdmin || conversation.assignedAgent?.id === viewer.id));

    return {
        ...state,
        tickets: open
            ? [...without(state.tickets, conversation.ulid), conversation].sort(
                  (a, b) => parseMs(a.createdAt, 0) - parseMs(b.createdAt, 0),
              )
            : without(state.tickets, conversation.ulid),
    };
}

function placeLive(
    state: InboxState,
    conversation: ConversationStaff,
    viewer: Viewer,
): InboxState {
    const item = state.queue.find(
        (candidate) => candidate.conversation === conversation.ulid,
    );

    if (conversation.status === 'queued') {
        // A re-queued chat (transfer) leaves "My chats". It joins the queue only for an admin (who sees every request) or where an
        // offer already put it there: an agent gets their own requests through `chat.offered` / the REST snapshot, so the former agent
        // of a transferred chat must not find it in their queue just because they are told it changed.
        const queue =
            viewer.isAdmin || item
                ? upsertItem(
                      state.queue,
                      itemFromConversation(
                          conversation,
                          item?.state === 'open' ? item : undefined,
                      ),
                  )
                : state.queue;

        return {
            ...state,
            mine: without(state.mine, conversation.ulid),
            queue,
        };
    }

    const winner = conversation.assignedAgent;
    let queue = state.queue;

    if (item) {
        if (
            conversation.status === 'missed' ||
            conversation.status === 'closed'
        ) {
            queue = dropItem(queue, conversation.ulid);
        } else if (winner?.id === viewer.id) {
            queue = dropItem(queue, conversation.ulid);
        } else if (winner !== null && item.state === 'open') {
            // Somebody else won and `chat.taken` has not said so yet: show who, then let the card leave.
            queue = upsertItem(queue, {
                ...item,
                state: 'taken',
                takenBy: winner.name,
            });
        }
    }

    const mine =
        conversation.status !== 'missed' &&
        (viewer.isAdmin || winner?.id === viewer.id)
            ? upsertSorted(state.mine, conversation)
            : without(state.mine, conversation.ulid);

    return { ...state, queue, mine };
}

function applyConversation(
    state: InboxState,
    conversation: ConversationStaff,
    viewer: Viewer,
): InboxState {
    const known =
        state.mine.find((item) => item.ulid === conversation.ulid) ??
        state.tickets.find((item) => item.ulid === conversation.ulid);

    if (known && isStaleUpdate(known, conversation)) {
        return state;
    }

    return conversation.type === 'offline'
        ? placeTicket(state, conversation, viewer)
        : placeLive(state, conversation, viewer);
}

/* -------------------------------------------------------------------------- */
/* Reducer                                                                    */
/* -------------------------------------------------------------------------- */

function sameList<T>(a: T[], b: T[]): boolean {
    return a.length === b.length && a.every((item, index) => item === b[index]);
}

/** The conversation an action is about (what `touched` tracks), when it is about one. */
function conversationOf(action: InboxAction): string | null {
    switch (action.type) {
        case 'offered':
            return action.offer.conversation;
        case 'conversationUpdated':
            return action.conversation.ulid;
        case 'taken':
        case 'unread':
        case 'seen':
        case 'removed':
            return action.conversation;
        default:
            return null;
    }
}

export function inboxReducer(
    state: InboxState,
    action: InboxAction,
): InboxState {
    const next = reduce(state, action);
    const ulid = conversationOf(action);

    if (next === state || ulid === null) {
        return next;
    }

    const clock = state.clock + 1;

    return { ...next, clock, touched: { ...next.touched, [ulid]: clock } };
}

type SnapshotAction = Extract<InboxAction, { type: 'hydrate' }>;

/**
 * Apply a snapshot (the page props, or a REST read). With `since`, whatever changed after the snapshot was requested stays as the live
 * events left it; the rest is replaced by the snapshot, which is the truth for everything it describes.
 */
function applySnapshot(state: InboxState, action: SnapshotAction): InboxState {
    const newer = (ulid: string): boolean =>
        action.since !== undefined && (state.touched[ulid] ?? 0) > action.since;
    const queueRows = action.queue?.filter((row) => !newer(row.ulid));
    const mineRows = action.mine?.filter((row) => !newer(row.ulid));
    const ticketRows = action.tickets?.filter((row) => !newer(row.ulid));

    const queue =
        queueRows === undefined
            ? state.queue
            : [
                  ...queueRows.map((conversation) =>
                      itemFromConversation(
                          conversation,
                          state.queue.find(
                              (item) => item.conversation === conversation.ulid,
                          ),
                      ),
                  ),
                  // A card that is mid-exit stays until its timer removes it; one that changed since stays as it is.
                  ...state.queue.filter(
                      (item) =>
                          newer(item.conversation) ||
                          (item.state !== 'open' &&
                              !queueRows.some(
                                  (row) => row.ulid === item.conversation,
                              )),
                  ),
              ].sort(byWaiting);

    const mine =
        mineRows === undefined
            ? state.mine
            : [
                  ...mineRows,
                  ...state.mine.filter(
                      (item) =>
                          newer(item.ulid) ||
                          (action.keepFinished === true &&
                              (item.status === 'ended' ||
                                  item.status === 'closed') &&
                              !mineRows.some((row) => row.ulid === item.ulid)),
                  ),
              ].sort(byActivity);

    const tickets =
        ticketRows === undefined
            ? state.tickets
            : [
                  ...ticketRows,
                  ...state.tickets.filter((item) => newer(item.ulid)),
              ].sort(
                  (a, b) => parseMs(a.createdAt, 0) - parseMs(b.createdAt, 0),
              );

    return {
        ...state,
        // The queue / my chats are known once a snapshot carried them (the offline tickets page only brings tickets).
        hydrated:
            state.hydrated ||
            action.queue !== undefined ||
            action.mine !== undefined,
        queue: sameList(queue, state.queue) ? state.queue : queue,
        mine,
        tickets,
        touched:
            action.since === undefined
                ? state.touched
                : Object.fromEntries(
                      Object.entries(state.touched).filter(
                          ([, at]) => at > (action.since as number),
                      ),
                  ),
    };
}

function reduce(state: InboxState, action: InboxAction): InboxState {
    switch (action.type) {
        case 'hydrate':
            return applySnapshot(state, action);

        case 'offered': {
            const existing = state.queue.find(
                (item) => item.conversation === action.offer.conversation,
            );

            if (existing?.state === 'taken') {
                return state;
            }

            return {
                ...state,
                queue: upsertItem(
                    state.queue,
                    itemFromOffer(action.offer, action.nowMs, existing),
                ),
            };
        }

        case 'taken': {
            const existing = state.queue.find(
                (item) => item.conversation === action.conversation,
            );

            if (!existing) {
                return state;
            }

            return {
                ...state,
                queue: upsertItem(state.queue, {
                    ...existing,
                    state: 'taken',
                    takenBy: action.by,
                }),
            };
        }

        case 'dismiss':
            return {
                ...state,
                queue: dropItem(state.queue, action.conversation),
            };

        case 'expire': {
            let changed = false;
            const queue = state.queue.map((item) => {
                if (
                    item.state === 'open' &&
                    item.expiresAt !== null &&
                    parseMs(item.expiresAt, Infinity) <= action.nowMs
                ) {
                    changed = true;

                    return { ...item, state: 'expired' as const };
                }

                return item;
            });

            return changed ? { ...state, queue } : state;
        }

        case 'conversationUpdated':
            return applyConversation(state, action.conversation, action.viewer);

        case 'unread': {
            const current = state.mine.find(
                (item) => item.ulid === action.conversation,
            );

            if (!current || current.unseenByAgent === action.unseen) {
                return state;
            }

            return {
                ...state,
                mine: state.mine.map((item) =>
                    item === current
                        ? { ...item, unseenByAgent: action.unseen }
                        : item,
                ),
            };
        }

        case 'seen': {
            const current = state.mine.find(
                (item) => item.ulid === action.conversation,
            );

            if (!current || current.unseenByAgent === 0) {
                return state;
            }

            return {
                ...state,
                mine: state.mine.map((item) =>
                    item === current ? { ...item, unseenByAgent: 0 } : item,
                ),
            };
        }

        case 'removed':
            return {
                ...state,
                queue: dropItem(state.queue, action.conversation),
                mine: without(state.mine, action.conversation),
                tickets: without(state.tickets, action.conversation),
            };

        case 'connection':
            return state.connection === action.status
                ? state
                : { ...state, connection: action.status };

        case 'presence':
            return state.presence === action.status
                ? state
                : { ...state, presence: action.status };

        case 'rosterHere':
            return { ...state, roster: action.members };

        case 'rosterJoin':
            return {
                ...state,
                roster: [
                    ...state.roster.filter(
                        (member) => member.id !== action.member.id,
                    ),
                    action.member,
                ],
            };

        case 'rosterLeave':
            return state.roster.some((member) => member.id === action.id)
                ? {
                      ...state,
                      roster: state.roster.filter(
                          (member) => member.id !== action.id,
                      ),
                  }
                : state;

        case 'presenceSeen':
            return state.seenPresence[action.id]?.status === action.status &&
                state.seenPresence[action.id].at >= action.at
                ? state
                : {
                      ...state,
                      seenPresence: {
                          ...state.seenPresence,
                          [action.id]: { status: action.status, at: action.at },
                      },
                  };

        case 'rosterStatus':
            return state.roster.some(
                (member) =>
                    member.id === action.id && member.status !== action.status,
            )
                ? {
                      ...state,
                      roster: state.roster.map((member) =>
                          member.id === action.id
                              ? { ...member, status: action.status }
                              : member,
                      ),
                  }
                : state;
    }
}

/* -------------------------------------------------------------------------- */
/* Selectors (primitives or state slices: stable between unrelated changes)   */
/* -------------------------------------------------------------------------- */

export function selectUnseenTotal(state: InboxState): number {
    return state.mine.reduce((sum, item) => sum + item.unseenByAgent, 0);
}

export function selectOpenQueueCount(state: InboxState): number {
    return state.queue.filter((item) => item.state === 'open').length;
}

/** What needs the agent's attention right now: offers waiting + unread messages (the document title and the sidebar badge). */
export function selectAttentionCount(state: InboxState): number {
    return selectOpenQueueCount(state) + selectUnseenTotal(state);
}

export function selectTicketCount(state: InboxState): number {
    return state.tickets.filter((ticket) => ticket.status === 'queued').length;
}

/** The next moment an open offer lapses (ms since epoch), or `null` when none has a deadline. */
export function nextExpiryMs(state: InboxState): number | null {
    let next: number | null = null;

    for (const item of state.queue) {
        if (item.state === 'open' && item.expiresAt !== null) {
            const at = parseMs(item.expiresAt, Infinity);

            if (next === null || at < next) {
                next = at;
            }
        }
    }

    return next;
}

/* -------------------------------------------------------------------------- */
/* External store                                                             */
/* -------------------------------------------------------------------------- */

export type InboxStore = {
    getState: () => InboxState;
    subscribe: (listener: () => void) => () => void;
    dispatch: (action: InboxAction) => void;
};

export function createInboxStore(
    initial: Partial<InboxState> = {},
): InboxStore {
    let state: InboxState = { ...EMPTY_INBOX, ...initial };
    const listeners = new Set<() => void>();

    return {
        getState: () => state,
        subscribe(listener) {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        dispatch(action) {
            const next = inboxReducer(state, action);

            if (next === state) {
                return;
            }

            state = next;
            listeners.forEach((listener) => listener());
        },
    };
}
