/**
 * The panel's single source of truth: a pure reducer over `MachineState` (docs/contracts/chat-ui-p4.md, "Embed panel").
 *
 *   booting -> idle | prechat | category | offline        (first step, or a resumed queued / active / ended chat)
 *   idle -> prechat | category | offline | queued
 *   prechat <-> category -> queued                        (steps the widget config skips are never entered)
 *   queued -> active | offline (missed) | closed (cancelled) | ended
 *   active -> ended | closed | queued (transfer)
 *   ended -> closed          offline -> closed (ticket) | idle...  closed -> first step (a new chat is a new ticket)
 *
 * Nothing here talks to the network or the clock: the controller (`session/controller.ts`) performs the effects and feeds the
 * outcomes back as actions, with times passed in. A transition that is not in `TRANSITIONS` is ignored (the same state object
 * comes back), so a late realtime event can never drag the panel backwards.
 *
 * Unread is not stored: it is the number of agent messages the visitor has not seen, while the panel is closed (`selectUnread`).
 */
import {
    applyDelivered,
    applySeen,
    highestSeq,
    mergeMessages,
    setPendingStatus,
} from '@/lib/chat/messages';
import type {
    AgentRef,
    ConversationCloseReason,
    ConversationPublic,
    LocalMessage,
    MessageData,
    MessageFailure,
    SenderType,
} from '@/lib/chat/types';
import type { HostStatus, StatePayload } from '@/embed/protocol/messages';

export type Phase =
    | 'booting'
    | 'idle'
    | 'prechat'
    | 'category'
    | 'queued'
    | 'active'
    | 'ended'
    | 'offline'
    | 'closed';

export const TRANSITIONS: Readonly<Record<Phase, readonly Phase[]>> = {
    booting: [
        'idle',
        'prechat',
        'category',
        'offline',
        'queued',
        'active',
        'ended',
    ],
    // `active` here is a resumed chat (`409 conversation_exists`: the session already has one, e.g. from a second tab).
    idle: ['prechat', 'category', 'offline', 'queued', 'active'],
    prechat: ['category', 'queued', 'offline', 'active'],
    category: ['prechat', 'queued', 'offline', 'active'],
    queued: ['active', 'ended', 'offline', 'closed'],
    active: ['ended', 'closed', 'queued'],
    ended: ['closed'],
    offline: ['closed', 'idle', 'prechat', 'category'],
    closed: ['idle', 'prechat', 'category', 'offline'],
};

export const PHASES = Object.keys(TRANSITIONS) as Phase[];

/** What the widget config and availability allow; recomputed by the controller whenever either changes. */
export type Flow = {
    /** Nobody to talk to (outside hours, or no agent available). */
    offline: boolean;
    /** Why: drives the copy of the offline screen. */
    offlineReason: 'hours' | 'no_agents';
    offlineForm: boolean;
    /** The pre-chat form must be shown (fields or consent, and not already satisfied by a signed identity). */
    preChat: boolean;
    /** How many topics the visitor can choose from. */
    categoryCount: number;
    rating: boolean;
};

export const DEFAULT_FLOW: Flow = {
    offline: false,
    offlineReason: 'no_agents',
    offlineForm: true,
    preChat: false,
    categoryCount: 0,
    rating: true,
};

export type FormValues = {
    name: string;
    email: string;
    phone: string;
    consent: boolean;
};

export const EMPTY_FORM: FormValues = {
    name: '',
    email: '',
    phone: '',
    consent: false,
};

export type Busy = 'starting' | 'ending' | 'rating' | 'offline' | null;

export type OfflineReason = 'hours' | 'no_agents' | 'missed' | 'category';

export type ClosedReason =
    | ConversationCloseReason
    | 'ticket'
    | 'ended'
    | 'expired';

export type ConnectionStatus =
    | 'idle'
    | 'connecting'
    | 'online'
    | 'reconnecting';

export type NoticeCode =
    | 'generic'
    | 'network'
    | 'rate_limited'
    | 'unavailable'
    | 'session_expired'
    /** A signed identity the server refused (`422 details.identity_token`): retrying the same token cannot work. */
    | 'identity'
    /** The widget switched the feature off (`403 feature_disabled`). */
    | 'feature_disabled';

export type Notice = { code: NoticeCode; seconds?: number };

export type MachineState = {
    phase: Phase;
    open: boolean;
    flow: Flow;
    form: FormValues;
    /** Server-side `422` messages by field (`name`, `email`, `phone`, `category`, `message`, `consent`). */
    fieldErrors: Record<string, string>;
    category: string | null;
    /** A message handed over by `startChat({message})`, sent with the conversation. */
    initialMessage: string | null;
    conversation: ConversationPublic | null;
    messages: LocalMessage[];
    typing: boolean;
    connection: ConnectionStatus;
    busy: Busy;
    notice: Notice | null;
    /** Client clock time the visitor entered the queue (for the elapsed timer). */
    queuedAt: number | null;
    /** The queue was entered by a transfer, not a fresh request. */
    transferred: boolean;
    offline: {
        reason: OfflineReason;
        /** The visitor's own `missed` conversation, recorded on the ticket. */
        missed: string | null;
        ticket: ConversationPublic | null;
        /** The address the visitor submitted the ticket with (the confirmation names it, whatever the pre-chat form held). */
        email?: string;
    };
    closedReason: ClosedReason | null;
};

export function createInitialState(open = false): MachineState {
    return {
        phase: 'booting',
        open,
        flow: DEFAULT_FLOW,
        form: EMPTY_FORM,
        fieldErrors: {},
        category: null,
        initialMessage: null,
        conversation: null,
        messages: [],
        typing: false,
        connection: 'idle',
        busy: null,
        notice: null,
        queuedAt: null,
        transferred: false,
        offline: { reason: 'no_agents', missed: null, ticket: null },
        closedReason: null,
    };
}

export type FieldErrors = Record<string, string>;

export type CreateFailure =
    | { kind: 'no_agents' }
    | { kind: 'validation'; errors: FieldErrors }
    | { kind: 'notice'; notice: Notice };

export type Action =
    | { type: 'CONFIGURED'; flow: Flow }
    | {
          type: 'BOOTED';
          conversation: ConversationPublic | null;
          messages: MessageData[];
          now: number;
      }
    | { type: 'HOST_OPEN' }
    | { type: 'HOST_CLOSE' }
    | { type: 'PRESET'; category?: string | null; message?: string | null }
    | { type: 'PREFILL'; values: Partial<FormValues> }
    | { type: 'START' }
    | { type: 'BACK' }
    | { type: 'PRECHAT_SUBMIT'; values: FormValues }
    | { type: 'CATEGORY_PICK'; slug: string }
    | { type: 'CATEGORY_OFFLINE'; slug: string }
    | { type: 'CREATE_OK'; conversation: ConversationPublic; now: number }
    | { type: 'CREATE_FAIL'; failure: CreateFailure }
    | { type: 'RESUMED'; conversation: ConversationPublic; now: number }
    | { type: 'CLAIMED'; agent: AgentRef }
    | { type: 'TRANSFERRED'; now: number }
    | { type: 'MISSED' }
    | { type: 'CANCEL_OK' }
    | { type: 'END_REQUESTED' }
    | { type: 'END_FAILED'; notice: Notice }
    | { type: 'ENDED'; ratingRequested: boolean }
    | { type: 'CLOSED'; reason: ConversationCloseReason }
    | { type: 'RATING_REQUESTED' }
    | { type: 'RATING_FAILED'; notice: Notice }
    | { type: 'RATED' }
    | { type: 'RATING_SKIPPED' }
    | { type: 'OFFLINE_SUBMITTING' }
    | { type: 'OFFLINE_SENT'; ticket: ConversationPublic; email?: string }
    | { type: 'OFFLINE_FAILED'; failure: CreateFailure }
    | { type: 'NEW_CHAT' }
    | { type: 'SESSION_LOST' }
    | { type: 'MESSAGES'; messages: readonly (MessageData | LocalMessage)[] }
    | { type: 'MESSAGE_PENDING'; message: LocalMessage }
    | {
          type: 'MESSAGE_FAILED';
          clientMsgId: string;
          failure?: MessageFailure;
      }
    | { type: 'MESSAGE_RETRY'; clientMsgId: string }
    | { type: 'MESSAGE_REMOVED'; clientMsgId: string }
    | { type: 'DELIVERED'; upToSeq: number; by: SenderType; at: string }
    | { type: 'SEEN'; upToSeq: number; by: SenderType; at: string }
    | { type: 'TYPING'; typing: boolean }
    | { type: 'CONNECTION'; status: ConnectionStatus }
    | { type: 'NOTICE'; notice: Notice | null }
    | { type: 'RESET' };

/** Moves to `to` when the table allows it; otherwise the state is returned untouched. */
function go(
    state: MachineState,
    to: Phase,
    patch: Partial<MachineState> = {},
): MachineState {
    if (!TRANSITIONS[state.phase].includes(to)) {
        return state;
    }

    return { ...state, ...patch, phase: to };
}

/** The first screen of a new chat: where the visitor lands, or `null` when the chat can start right away. */
export function firstStep(
    state: Pick<MachineState, 'flow' | 'category'>,
): Phase | null {
    const { flow, category } = state;

    if (flow.offline) {
        return 'offline';
    }

    if (flow.preChat) {
        return 'prechat';
    }

    return flow.categoryCount > 1 && category === null ? 'category' : null;
}

function offlineReasonOf(flow: Flow): OfflineReason {
    return flow.offlineReason;
}

function sameFlow(a: Flow, b: Flow): boolean {
    return (
        a.offline === b.offline &&
        a.offlineReason === b.offlineReason &&
        a.offlineForm === b.offlineForm &&
        a.preChat === b.preChat &&
        a.categoryCount === b.categoryCount &&
        a.rating === b.rating
    );
}

/** Entering the queue: a fresh conversation, a resumed one, or a transfer. */
function enterQueue(
    state: MachineState,
    conversation: ConversationPublic,
    now: number,
    patch: Partial<MachineState> = {},
): MachineState {
    return go(state, 'queued', {
        conversation,
        queuedAt: now,
        busy: null,
        notice: null,
        fieldErrors: {},
        ...patch,
    });
}

/** Resets everything that belongs to one conversation, keeping the visitor's form values and the config. */
function cleared(state: MachineState): MachineState {
    return {
        ...state,
        category: null,
        initialMessage: null,
        conversation: null,
        messages: [],
        typing: false,
        connection: 'idle',
        busy: null,
        notice: null,
        queuedAt: null,
        transferred: false,
        fieldErrors: {},
        offline: { reason: 'no_agents', missed: null, ticket: null },
        closedReason: null,
    };
}

/** From a cleared state to the first step (phase `idle` when nothing has to be asked). */
function toFirstStep(state: MachineState): MachineState {
    const step = firstStep(state);
    const to = step ?? 'idle';

    return go(state, to, {
        offline:
            to === 'offline'
                ? {
                      reason: offlineReasonOf(state.flow),
                      missed: null,
                      ticket: null,
                  }
                : state.offline,
    });
}

function withConversation(
    state: MachineState,
    messages: LocalMessage[],
): MachineState {
    const lastSeq = highestSeq(messages);
    const conversation = state.conversation;

    return {
        ...state,
        messages,
        conversation:
            conversation !== null && lastSeq > conversation.lastSeq
                ? { ...conversation, lastSeq }
                : conversation,
    };
}

export function reduce(state: MachineState, action: Action): MachineState {
    switch (action.type) {
        case 'CONFIGURED': {
            if (
                sameFlow(state.flow, action.flow) &&
                state.phase !== 'offline'
            ) {
                return state;
            }

            const next = { ...state, flow: action.flow };

            // A config that changed under a screen the visitor has not committed to yet (availability refresh, a builder draft):
            // re-evaluate it. Never touches a running chat.
            if (
                state.phase === 'offline' &&
                state.offline.reason !== 'missed'
            ) {
                if (!action.flow.offline) {
                    return toFirstStep({ ...next, offline: state.offline });
                }

                return {
                    ...next,
                    offline: {
                        ...state.offline,
                        reason: action.flow.offlineReason,
                    },
                };
            }

            if (
                (state.phase === 'idle' ||
                    state.phase === 'prechat' ||
                    state.phase === 'category') &&
                action.flow.offline
            ) {
                return go(next, 'offline', {
                    busy: null,
                    offline: {
                        reason: action.flow.offlineReason,
                        missed: null,
                        ticket: null,
                    },
                });
            }

            return next;
        }

        case 'BOOTED': {
            if (state.phase !== 'booting') {
                return state;
            }

            const { conversation } = action;
            const messages = mergeMessages([], action.messages);

            if (conversation?.status === 'queued') {
                return withConversation(
                    enterQueue(state, conversation, action.now, { messages }),
                    messages,
                );
            }

            if (conversation?.status === 'active') {
                return withConversation(
                    go(state, 'active', { conversation, messages }),
                    messages,
                );
            }

            if (
                conversation?.status === 'ended' &&
                conversation.ratingRequested &&
                state.flow.rating
            ) {
                return withConversation(
                    go(state, 'ended', { conversation, messages }),
                    messages,
                );
            }

            return toFirstStep(state);
        }

        case 'HOST_OPEN':
            return state.open ? state : { ...state, open: true };

        case 'HOST_CLOSE':
            return state.open ? { ...state, open: false } : state;

        case 'PRESET': {
            // `setCategory` / `startChat` from the host: remembered for the first step that needs them.
            const category =
                action.category === undefined
                    ? state.category
                    : action.category;
            const initialMessage =
                action.message === undefined
                    ? state.initialMessage
                    : action.message;

            return category === state.category &&
                initialMessage === state.initialMessage
                ? state
                : { ...state, category, initialMessage };
        }

        case 'PREFILL': {
            // Host-provided or signed-identity values fill only what the visitor has not typed.
            const form = { ...state.form };
            let changed = false;

            for (const key of ['name', 'email', 'phone'] as const) {
                const value = action.values[key];

                if (value !== undefined && value !== '' && form[key] === '') {
                    form[key] = value;
                    changed = true;
                }
            }

            return changed ? { ...state, form } : state;
        }

        case 'START': {
            if (state.phase !== 'idle') {
                return state;
            }

            const base = { ...state, notice: null };
            const step = firstStep(base);

            if (step === null) {
                return { ...base, busy: 'starting' };
            }

            return go(base, step, {
                offline:
                    step === 'offline'
                        ? {
                              reason: offlineReasonOf(state.flow),
                              missed: null,
                              ticket: null,
                          }
                        : state.offline,
            });
        }

        case 'BACK':
            return state.phase === 'category' && state.flow.preChat
                ? go(state, 'prechat', { notice: null, fieldErrors: {} })
                : state;

        case 'PRECHAT_SUBMIT': {
            if (state.phase !== 'prechat') {
                return state;
            }

            const base = {
                ...state,
                form: action.values,
                fieldErrors: {},
                notice: null,
            };

            if (state.flow.categoryCount > 1 && state.category === null) {
                return go(base, 'category');
            }

            return { ...base, busy: 'starting' };
        }

        case 'CATEGORY_PICK':
            return state.phase === 'category'
                ? {
                      ...state,
                      category: action.slug,
                      busy: 'starting',
                      notice: null,
                      fieldErrors: {},
                  }
                : state;

        case 'CATEGORY_OFFLINE':
            return state.phase === 'category' && state.flow.offlineForm
                ? go(state, 'offline', {
                      category: action.slug,
                      busy: null,
                      offline: {
                          reason: 'category',
                          missed: null,
                          ticket: null,
                      },
                  })
                : state;

        case 'CREATE_OK':
            return state.busy === 'starting'
                ? enterQueue(state, action.conversation, action.now, {
                      messages: [],
                      transferred: false,
                      initialMessage: null,
                  })
                : state;

        case 'CREATE_FAIL': {
            if (state.busy !== 'starting') {
                return state;
            }

            const { failure } = action;

            if (failure.kind === 'no_agents') {
                return go(state, 'offline', {
                    busy: null,
                    offline: {
                        reason: 'no_agents',
                        missed: null,
                        ticket: null,
                    },
                });
            }

            if (failure.kind === 'validation') {
                const preChatFields = ['name', 'email', 'phone', 'consent'];
                const next: MachineState = {
                    ...state,
                    busy: null,
                    fieldErrors: failure.errors,
                    // Without a form on screen (a direct start) the visitor still has to be told something went wrong.
                    notice: state.phase === 'idle' ? { code: 'generic' } : null,
                };

                // The server rejected something the pre-chat form owns (a step that was skipped for a prefilled identity).
                return Object.keys(failure.errors).some((key) =>
                    preChatFields.includes(key),
                ) && state.phase !== 'prechat'
                    ? go(next, 'prechat', { notice: null })
                    : next;
            }

            return { ...state, busy: null, notice: failure.notice };
        }

        case 'RESUMED': {
            // `409 conversation_exists`: the visitor already has an open chat; continue it.
            const { conversation } = action;

            if (conversation.status === 'queued') {
                return enterQueue(state, conversation, action.now, {
                    busy: null,
                });
            }

            return conversation.status === 'active'
                ? go(state, 'active', {
                      conversation,
                      busy: null,
                      notice: null,
                  })
                : state;
        }

        case 'CLAIMED': {
            if (state.phase !== 'queued' || state.conversation === null) {
                return state;
            }

            return go(state, 'active', {
                conversation: {
                    ...state.conversation,
                    status: 'active',
                    agent: action.agent,
                },
                queuedAt: null,
                transferred: false,
                notice: null,
            });
        }

        case 'TRANSFERRED': {
            if (state.phase !== 'active' || state.conversation === null) {
                return state;
            }

            return go(state, 'queued', {
                conversation: {
                    ...state.conversation,
                    status: 'queued',
                    agent: null,
                },
                queuedAt: action.now,
                transferred: true,
                typing: false,
            });
        }

        case 'MISSED':
            return state.phase === 'queued' && state.flow.offlineForm
                ? go(state, 'offline', {
                      offline: {
                          reason: 'missed',
                          missed: state.conversation?.ulid ?? null,
                          ticket: null,
                      },
                      conversation: null,
                      messages: [],
                      queuedAt: null,
                      connection: 'idle',
                      busy: null,
                  })
                : state.phase === 'queued'
                  ? go(state, 'closed', {
                        closedReason: 'system',
                        conversation: null,
                        messages: [],
                        queuedAt: null,
                        connection: 'idle',
                    })
                  : state;

        case 'CANCEL_OK':
            return state.phase !== 'queued'
                ? state
                : go(state, 'closed', {
                      closedReason: 'cancelled',
                      conversation: null,
                      messages: [],
                      queuedAt: null,
                      connection: 'idle',
                      typing: false,
                      busy: null,
                  });

        case 'END_REQUESTED':
            return state.phase === 'active'
                ? { ...state, busy: 'ending', notice: null }
                : state;

        case 'END_FAILED':
            return state.busy === 'ending'
                ? { ...state, busy: null, notice: action.notice }
                : state;

        case 'ENDED': {
            const rated = action.ratingRequested && state.flow.rating;
            const conversation =
                state.conversation === null
                    ? null
                    : {
                          ...state.conversation,
                          status: 'ended' as const,
                          ratingRequested: action.ratingRequested,
                      };

            return rated
                ? go(state, 'ended', {
                      conversation,
                      busy: null,
                      typing: false,
                      connection: 'idle',
                  })
                : go(state, 'closed', {
                      closedReason: 'ended',
                      conversation: null,
                      messages: [],
                      busy: null,
                      typing: false,
                      connection: 'idle',
                  });
        }

        case 'CLOSED':
            return go(state, 'closed', {
                closedReason: action.reason,
                conversation: null,
                messages: [],
                queuedAt: null,
                busy: null,
                typing: false,
                connection: 'idle',
            });

        case 'RATING_REQUESTED':
            return state.phase === 'ended'
                ? { ...state, busy: 'rating', notice: null }
                : state;

        case 'RATING_FAILED':
            return state.busy === 'rating'
                ? { ...state, busy: null, notice: action.notice }
                : state;

        case 'RATED':
            return state.phase !== 'ended'
                ? state
                : go(state, 'closed', {
                      closedReason: 'rated',
                      conversation: null,
                      messages: [],
                      busy: null,
                  });

        case 'RATING_SKIPPED':
            return state.phase !== 'ended'
                ? state
                : go(state, 'closed', {
                      closedReason: 'skipped',
                      conversation: null,
                      messages: [],
                      busy: null,
                  });

        case 'OFFLINE_SUBMITTING':
            return state.phase === 'offline'
                ? { ...state, busy: 'offline', notice: null, fieldErrors: {} }
                : state;

        case 'OFFLINE_SENT':
            return go(state, 'closed', {
                closedReason: 'ticket',
                busy: null,
                offline: {
                    ...state.offline,
                    ticket: action.ticket,
                    ...(action.email === undefined
                        ? {}
                        : { email: action.email }),
                },
                fieldErrors: {},
            });

        case 'OFFLINE_FAILED': {
            if (state.busy !== 'offline') {
                return state;
            }

            const { failure } = action;

            if (failure.kind === 'validation') {
                return { ...state, busy: null, fieldErrors: failure.errors };
            }

            return {
                ...state,
                busy: null,
                notice:
                    failure.kind === 'notice'
                        ? failure.notice
                        : { code: 'generic' },
            };
        }

        case 'NEW_CHAT': {
            if (state.phase !== 'closed') {
                return state;
            }

            // A new chat is a new ticket: nothing of the old one survives, only what the visitor typed into the form.
            return toFirstStep(cleared(state));
        }

        case 'SESSION_LOST': {
            if (
                state.phase === 'queued' ||
                state.phase === 'active' ||
                state.phase === 'ended'
            ) {
                return go(state, 'closed', {
                    closedReason: 'expired',
                    conversation: null,
                    messages: [],
                    queuedAt: null,
                    busy: null,
                    connection: 'idle',
                    typing: false,
                });
            }

            return {
                ...state,
                busy: null,
                conversation: null,
                messages: [],
                connection: 'idle',
            };
        }

        case 'MESSAGES': {
            const messages = mergeMessages(state.messages, action.messages);

            return messages === state.messages
                ? state
                : withConversation(state, messages);
        }

        case 'MESSAGE_PENDING': {
            const messages = mergeMessages(state.messages, [action.message]);

            return messages === state.messages ? state : { ...state, messages };
        }

        case 'MESSAGE_FAILED': {
            const messages = setPendingStatus(
                state.messages,
                action.clientMsgId,
                'failed',
                action.failure,
            );

            return messages === state.messages ? state : { ...state, messages };
        }

        case 'MESSAGE_RETRY': {
            const messages = setPendingStatus(
                state.messages,
                action.clientMsgId,
                'sending',
            );

            return messages === state.messages ? state : { ...state, messages };
        }

        case 'MESSAGE_REMOVED': {
            const messages = state.messages.filter(
                (message) =>
                    !(
                        message.seq === null &&
                        message.clientMsgId === action.clientMsgId
                    ),
            );

            return messages.length === state.messages.length
                ? state
                : { ...state, messages };
        }

        case 'DELIVERED': {
            const messages = applyDelivered(state.messages, {
                upToSeq: action.upToSeq,
                by: action.by,
                at: action.at,
            });

            return messages === state.messages ? state : { ...state, messages };
        }

        case 'SEEN': {
            const messages = applySeen(state.messages, {
                upToSeq: action.upToSeq,
                by: action.by,
                at: action.at,
            });

            return messages === state.messages ? state : { ...state, messages };
        }

        case 'TYPING':
            return state.typing === action.typing
                ? state
                : { ...state, typing: action.typing };

        case 'CONNECTION':
            return state.connection === action.status
                ? state
                : { ...state, connection: action.status };

        case 'NOTICE':
            return { ...state, notice: action.notice };

        case 'RESET':
            return toFirstStep({
                ...cleared(state),
                phase: 'idle',
            });

        default:
            return state;
    }
}

/* ---------------------------------------------------------------- selectors */

/** The status the loader understands. `category` is reported as `prechat`; `booting` is not reported at all. */
export function hostStatus(phase: Phase): HostStatus | null {
    switch (phase) {
        case 'booting':
            return null;
        case 'category':
            return 'prechat';
        default:
            return phase;
    }
}

/** Agent messages the visitor has not seen, while the panel is closed. */
export function selectUnread(state: MachineState): number {
    if (state.open) {
        return 0;
    }

    return state.messages.filter(
        (message) =>
            message.sender.type === 'agent' &&
            message.seq !== null &&
            message.seenAt === null,
    ).length;
}

/** The newest unseen agent message text, for the launcher's preview (capped by the caller). */
export function selectUnreadPreview(state: MachineState): string | null {
    for (let index = state.messages.length - 1; index >= 0; index--) {
        const message = state.messages[index];

        if (
            message.sender.type === 'agent' &&
            message.seq !== null &&
            message.seenAt === null
        ) {
            return message.body ?? null;
        }
    }

    return null;
}

/** What the loader's `state` message carries, or `null` while booting. */
export function toHostState(state: MachineState): StatePayload | null {
    const status = hostStatus(state.phase);

    if (status === null) {
        return null;
    }

    const agent =
        state.phase === 'active' || state.phase === 'ended'
            ? state.conversation?.agent
            : null;

    return {
        status,
        open: state.open,
        unread: selectUnread(state),
        ...(agent
            ? {
                  agent: {
                      name: agent.name,
                      ...(agent.avatarUrl === null
                          ? {}
                          : { avatarUrl: agent.avatarUrl }),
                  },
              }
            : {}),
    };
}

export function isLiveChat(state: MachineState): boolean {
    return state.phase === 'queued' || state.phase === 'active';
}
