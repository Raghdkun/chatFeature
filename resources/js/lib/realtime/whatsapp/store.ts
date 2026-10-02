/**
 * The admin's live WhatsApp state: the chats the browser knows (with their unread counts), the transcripts it has opened, the
 * sessions and the websocket's health. Pure state (a reducer) behind a tiny external store, so the same data feeds the inbox, the
 * settings page, the sidebar badge and the document title, and every rule is testable without React, a socket or a clock.
 *
 * Sources, in order of authority: the server props / a REST snapshot (`chatsLoaded`, `sessionsLoaded`, `messagesLoaded`), then the
 * realtime events (`chatChanged`, `messageChanged`, `sessionChanged`). Every action is idempotent: a replayed or reordered event never
 * duplicates a row, and a message only ever moves forward in status (`mergeWaMessages`). A REST snapshot remembers the clock it was
 * requested at, so an event that arrived while it was in flight is never overwritten by the older picture the snapshot describes.
 */
import type { ConnectionState } from '@/lib/realtime/staff/store';
import { mergeWaMessages } from '@/lib/whatsapp/messages';
import type { WaChat, WaMessage, WhatsAppSession } from '@/lib/whatsapp/types';

export type { ConnectionState };

export type WaLiveState = {
    /** A snapshot of the chats has been applied; before that the unread count is unknown, not zero. */
    hydrated: boolean;
    chats: Record<string, WaChat>;
    /** Transcripts that were opened, oldest first, by chat ulid (an event for a chat that was never opened is dropped: the page reads it). */
    messages: Record<string, WaMessage[]>;
    sessions: Record<string, WhatsAppSession>;
    sessionsHydrated: boolean;
    connection: ConnectionState;
    /** Bumped by every change an EVENT brings, and the value it had when each chat / session last changed that way. */
    clock: number;
    touched: Record<string, number>;
};

export const EMPTY_WA_STATE: WaLiveState = {
    hydrated: false,
    chats: {},
    messages: {},
    sessions: {},
    sessionsHydrated: false,
    connection: 'connecting',
    clock: 0,
    touched: {},
};

export type WaLiveAction =
    | {
          type: 'chatsLoaded';
          chats: WaChat[];
          /** The store's `clock` when the snapshot was requested: chats an event changed since keep their live copy. */
          since?: number;
          /**
           * The snapshot lists only the chats with something unread: a chat the store still counts as unread that is NOT in it was read
           * elsewhere (another tab, the phone), so its count drops to zero.
           */
          unreadOnly?: boolean;
      }
    | { type: 'chatChanged'; chat: WaChat }
    /** The admin opened the chat: its unread count is zero (the server is told separately). */
    | { type: 'chatRead'; ulid: string }
    /** The chat was deleted (here): it and its transcript leave the live state (and a snapshot older than this must not bring it back). */
    | { type: 'chatRemoved'; ulid: string }
    | { type: 'messagesLoaded'; chat: string; messages: WaMessage[] }
    | { type: 'messageChanged'; message: WaMessage }
    /**
     * The server answered a retry of a reply it had marked `failed` (it never reached WhatsApp) by putting it back in its queue: the one
     * step backwards a message makes (`failed` is final for events). Applies only to a held `failed` outbound row and a `pending` answer.
     */
    | { type: 'messageRequeued'; message: WaMessage }
    | { type: 'sessionsLoaded'; sessions: WhatsAppSession[]; since?: number }
    | { type: 'sessionChanged'; session: WhatsAppSession }
    | { type: 'sessionRemoved'; ulid: string }
    | { type: 'connection'; status: ConnectionState };

const sameChat = (a: WaChat, b: WaChat): boolean =>
    JSON.stringify(a) === JSON.stringify(b);

function touch(
    state: WaLiveState,
    key: string,
): Pick<WaLiveState, 'clock' | 'touched'> {
    const clock = state.clock + 1;

    return { clock, touched: { ...state.touched, [key]: clock } };
}

/** `true` when an event changed `key` after the snapshot at clock `since` was requested. */
function newerThanSnapshot(
    state: WaLiveState,
    key: string,
    since: number | undefined,
): boolean {
    return since !== undefined && (state.touched[key] ?? 0) > since;
}

export function waLiveReducer(
    state: WaLiveState,
    action: WaLiveAction,
): WaLiveState {
    switch (action.type) {
        case 'chatsLoaded': {
            const chats = { ...state.chats };
            let changed = !state.hydrated;

            for (const chat of action.chats) {
                if (newerThanSnapshot(state, chat.ulid, action.since)) {
                    continue;
                }

                const known = chats[chat.ulid];

                if (known === undefined || !sameChat(known, chat)) {
                    chats[chat.ulid] = chat;
                    changed = true;
                }
            }

            if (action.unreadOnly) {
                const listed = new Set(action.chats.map((chat) => chat.ulid));

                for (const chat of Object.values(chats)) {
                    if (
                        chat.unreadByAdmin > 0 &&
                        !listed.has(chat.ulid) &&
                        !newerThanSnapshot(state, chat.ulid, action.since)
                    ) {
                        chats[chat.ulid] = { ...chat, unreadByAdmin: 0 };
                        changed = true;
                    }
                }
            }

            return changed ? { ...state, hydrated: true, chats } : state;
        }

        case 'chatChanged': {
            const known = state.chats[action.chat.ulid];

            if (known !== undefined && sameChat(known, action.chat)) {
                return state;
            }

            return {
                ...state,
                chats: { ...state.chats, [action.chat.ulid]: action.chat },
                ...touch(state, action.chat.ulid),
            };
        }

        case 'chatRemoved': {
            if (
                !(action.ulid in state.chats) &&
                !(action.ulid in state.messages)
            ) {
                return state;
            }

            const chats = { ...state.chats };
            const messages = { ...state.messages };

            delete chats[action.ulid];
            delete messages[action.ulid];

            return { ...state, chats, messages, ...touch(state, action.ulid) };
        }

        case 'chatRead': {
            const known = state.chats[action.ulid];

            if (known === undefined || known.unreadByAdmin === 0) {
                return state;
            }

            return {
                ...state,
                chats: {
                    ...state.chats,
                    [action.ulid]: { ...known, unreadByAdmin: 0 },
                },
                ...touch(state, action.ulid),
            };
        }

        case 'messagesLoaded': {
            const held = state.messages[action.chat] ?? [];
            const merged = mergeWaMessages(held, action.messages);

            return merged === held && action.chat in state.messages
                ? state
                : {
                      ...state,
                      messages: { ...state.messages, [action.chat]: merged },
                  };
        }

        case 'messageChanged': {
            const held = state.messages[action.message.chat];

            if (held === undefined) {
                return state;
            }

            const merged = mergeWaMessages(held, [action.message]);

            return merged === held
                ? state
                : {
                      ...state,
                      messages: {
                          ...state.messages,
                          [action.message.chat]: merged,
                      },
                  };
        }

        case 'messageRequeued': {
            const held = state.messages[action.message.chat];
            const known = held?.find(
                (message) => message.ulid === action.message.ulid,
            );

            if (
                held === undefined ||
                known === undefined ||
                known.direction !== 'out' ||
                known.status !== 'failed' ||
                action.message.status !== 'pending'
            ) {
                return state;
            }

            return {
                ...state,
                messages: {
                    ...state.messages,
                    [action.message.chat]: held.map((message) =>
                        message.ulid === known.ulid ? action.message : message,
                    ),
                },
            };
        }

        case 'sessionsLoaded': {
            const sessions = { ...state.sessions };
            let changed = !state.sessionsHydrated;
            const listed = new Set(action.sessions.map((s) => s.ulid));

            for (const session of action.sessions) {
                if (newerThanSnapshot(state, session.ulid, action.since)) {
                    continue;
                }

                const known = sessions[session.ulid];

                if (
                    known === undefined ||
                    JSON.stringify(known) !== JSON.stringify(session)
                ) {
                    sessions[session.ulid] = session;
                    changed = true;
                }
            }

            // A full list is the truth: a session that is not in it was deleted (unless an event just created it).
            for (const ulid of Object.keys(sessions)) {
                if (
                    !listed.has(ulid) &&
                    !newerThanSnapshot(state, ulid, action.since)
                ) {
                    delete sessions[ulid];
                    changed = true;
                }
            }

            return changed
                ? { ...state, sessionsHydrated: true, sessions }
                : state;
        }

        case 'sessionChanged': {
            const known = state.sessions[action.session.ulid];

            if (
                known !== undefined &&
                JSON.stringify(known) === JSON.stringify(action.session)
            ) {
                return state;
            }

            return {
                ...state,
                sessions: {
                    ...state.sessions,
                    [action.session.ulid]: action.session,
                },
                ...touch(state, action.session.ulid),
            };
        }

        case 'sessionRemoved': {
            if (!(action.ulid in state.sessions)) {
                return state;
            }

            const sessions = { ...state.sessions };

            delete sessions[action.ulid];

            return { ...state, sessions, ...touch(state, action.ulid) };
        }

        case 'connection':
            return state.connection === action.status
                ? state
                : { ...state, connection: action.status };

        default:
            return state;
    }
}

/* Selectors live in ./selectors (a tiny module the dashboard's initial bundle can import without this store); re-exported for the rest. */
export {
    byRecency,
    selectUnreadChats,
    selectUnreadTotal,
} from '@/lib/realtime/whatsapp/selectors';

/* -------------------------------------------------------------------------- */
/* The store                                                                  */
/* -------------------------------------------------------------------------- */

export type WaLiveStore = {
    getState: () => WaLiveState;
    subscribe: (listener: () => void) => () => void;
    dispatch: (action: WaLiveAction) => void;
};

export function createWaLiveStore(
    initial: Partial<WaLiveState> = {},
): WaLiveStore {
    let state: WaLiveState = { ...EMPTY_WA_STATE, ...initial };
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
            const next = waLiveReducer(state, action);

            if (next === state) {
                return;
            }

            state = next;
            listeners.forEach((listener) => listener());
        },
    };
}
