/**
 * The state of the ONE conversation an agent has open: the conversation record, its message list and the send pipeline
 * (optimistic copy -> server ack -> receipts, or failed -> retry). Pure reducer on top of the shared message helpers
 * (`@/lib/chat/messages`), so the broadcast, the REST response of a send and a catch-up fetch converge on the same list in any order.
 */
import {
    applySeen,
    createPendingMessage,
    mergeMessages,
    setPendingStatus,
    type PendingMessageInput,
} from '@/lib/chat/messages';
import type {
    ConversationStaff,
    LocalMessage,
    MessageData,
    MessageFailure,
    SenderType,
} from '@/lib/chat/types';
import { isStaleUpdate } from '@/lib/realtime/staff/store';

export type ConversationViewState = {
    conversation: ConversationStaff;
    messages: LocalMessage[];
};

export type ConversationViewAction =
    /** Server messages from any source (broadcast, REST page, send response). */
    | { type: 'received'; messages: MessageData[] }
    /** The optimistic copy of a message being sent. */
    | { type: 'pending'; input: PendingMessageInput }
    | { type: 'acked'; message: MessageData }
    | { type: 'failed'; clientMsgId: string; failure?: MessageFailure }
    | { type: 'retrying'; clientMsgId: string }
    /** Remove a message that never reached the server (the agent gave up on a failed send). */
    | { type: 'discard'; clientMsgId: string }
    | { type: 'seen'; upToSeq: number; by: SenderType; at: string }
    | { type: 'conversation'; conversation: ConversationStaff }
    | { type: 'ended'; ratingRequested: boolean; at: string }
    | { type: 'closed'; at: string };

export function createConversationState(
    conversation: ConversationStaff,
    messages: MessageData[],
): ConversationViewState {
    return { conversation, messages: mergeMessages([], messages) };
}

/** The conversation's `lastSeq` follows the messages it holds (so a gap check never compares against a stale number). */
function withLastSeq(
    conversation: ConversationStaff,
    messages: LocalMessage[],
): ConversationStaff {
    const highest = messages.reduce(
        (max, message) =>
            message.seq !== null && message.seq > max ? message.seq : max,
        0,
    );

    return highest > conversation.lastSeq
        ? { ...conversation, lastSeq: highest }
        : conversation;
}

function settle(
    state: ConversationViewState,
    messages: LocalMessage[],
): ConversationViewState {
    if (messages === state.messages) {
        return state;
    }

    return {
        conversation: withLastSeq(state.conversation, messages),
        messages,
    };
}

export function conversationReducer(
    state: ConversationViewState,
    action: ConversationViewAction,
): ConversationViewState {
    switch (action.type) {
        case 'received':
            return settle(
                state,
                mergeMessages(state.messages, action.messages),
            );

        case 'pending':
            return settle(
                state,
                mergeMessages(state.messages, [
                    createPendingMessage(action.input),
                ]),
            );

        case 'acked':
            return settle(
                state,
                mergeMessages(state.messages, [action.message]),
            );

        case 'failed':
            return settle(
                state,
                setPendingStatus(
                    state.messages,
                    action.clientMsgId,
                    'failed',
                    action.failure,
                ),
            );

        case 'retrying':
            return settle(
                state,
                setPendingStatus(state.messages, action.clientMsgId, 'sending'),
            );

        case 'discard': {
            const messages = state.messages.filter(
                (message) =>
                    !(
                        message.clientMsgId === action.clientMsgId &&
                        message.seq === null
                    ),
            );

            return messages.length === state.messages.length
                ? state
                : settle(state, messages);
        }

        case 'seen':
            return settle(
                state,
                applySeen(state.messages, {
                    upToSeq: action.upToSeq,
                    by: action.by,
                    at: action.at,
                }),
            );

        case 'conversation':
            // A snapshot of an earlier life of this chat (a reordered `conversation.updated`) never wins.
            if (isStaleUpdate(state.conversation, action.conversation)) {
                return state;
            }

            return {
                ...state,
                conversation: withLastSeq(action.conversation, state.messages),
            };

        case 'ended':
            if (
                state.conversation.status === 'ended' ||
                state.conversation.status === 'closed'
            ) {
                return state;
            }

            return {
                ...state,
                conversation: {
                    ...state.conversation,
                    status: 'ended',
                    endedAt: state.conversation.endedAt ?? action.at,
                    ratingRequested: action.ratingRequested,
                },
            };

        case 'closed':
            return state.conversation.status === 'closed'
                ? state
                : {
                      ...state,
                      conversation: {
                          ...state.conversation,
                          status: 'closed',
                          endedAt: state.conversation.endedAt ?? action.at,
                      },
                  };
    }
}

/** Whether the agent can write in this conversation right now (policy `send`: an active chat the agent or an admin owns). */
export function canSend(conversation: ConversationStaff): boolean {
    return conversation.status === 'active';
}
