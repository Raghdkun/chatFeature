/**
 * The admin's transcript as the screen shows it: the server's messages (the store) plus the replies the browser has sent but the server
 * has not confirmed yet (the outbox). Pure, no React and no clock, so the rules that keep a reply from being shown twice, or sent twice,
 * are testable on their own.
 *
 * A reply goes through three states in the outbox: `sending` (optimistic bubble), `failed` (a reason and, when it can help, a retry), and
 * gone (the server's copy took its place). Two things can make the server's copy arrive before the POST's answer (the realtime event is
 * faster), or never answer at all (a dropped connection while the server did store it): the outbox entry is therefore matched to the
 * server's message by the id the POST answer carried, and, until then, by what it is: an outbound message of this administrator, newer
 * than anything the browser knew when the reply was sent (ULIDs are time-ordered, so no clock of this browser is involved) with the
 * same text.
 */
import { classifyWaError } from '@/lib/whatsapp-api/client';
import { isApiError } from '@/lib/api-client';
import type { WaMessage } from '@/lib/whatsapp/types';

/** Why a reply did not go out, from the API error: decides the text under the bubble and whether "Retry" is offered. */
export type WaSendFailure =
    | 'session_not_ready'
    | 'daily_cap'
    | 'pacing'
    | 'rate_limited'
    | 'not_inbound'
    | 'too_long'
    | 'rejected'
    | 'forbidden'
    | 'not_found'
    | 'network'
    | 'unknown';

/** Why the reply box is replaced by a sentence: nothing can be sent at all (the session is not connected / the customer wrote nothing). */
export type ComposerBlock = 'session_not_ready' | 'not_inbound';

/** A failure no retry can fix (the same request will be refused again): only "Discard" is offered. */
export function isFinalSendFailure(failure: WaSendFailure | null): boolean {
    return (
        failure === 'not_inbound' ||
        failure === 'too_long' ||
        failure === 'rejected' ||
        failure === 'forbidden' ||
        failure === 'not_found'
    );
}

/** The server may have stored the reply even though the browser never heard back: a retry first looks, then sends. */
export function isUncertainSendFailure(failure: WaSendFailure | null): boolean {
    return failure === 'network' || failure === 'unknown';
}

export function sendFailureOf(error: unknown): WaSendFailure {
    if (!isApiError(error)) {
        return 'unknown';
    }

    const kind = classifyWaError(error);

    switch (kind) {
        case 'session_not_ready':
        case 'daily_cap':
        case 'pacing':
        case 'not_inbound':
        case 'forbidden':
        case 'not_found':
        case 'network':
        case 'rate_limited':
            return kind;
    }

    if (error.status === 422) {
        return 'body' in error.details ? 'too_long' : 'rejected';
    }

    return 'unknown';
}

export type OutboxEntry = {
    clientMsgId: string;
    body: string;
    /** This browser's clock when the reply was typed: only for ordering the bubbles. */
    createdAt: string;
    state: 'sending' | 'failed';
    failure: WaSendFailure | null;
    /** Seconds the server asked to wait (`Retry-After`) when it refused a reply for speed. */
    retryAfter: number | null;
    /** The highest message id the browser knew when the reply was sent: only newer server messages can be this reply. */
    after: string | null;
    /** The id the POST answer gave the stored reply: once the server's copy is in the transcript, this entry is done. */
    serverUlid: string | null;
};

export type OutboxAction =
    | { type: 'queued'; entry: OutboxEntry }
    | { type: 'acked'; clientMsgId: string; ulid: string }
    | {
          type: 'failed';
          clientMsgId: string;
          failure: WaSendFailure;
          retryAfter?: number | null;
      }
    | { type: 'retrying'; clientMsgId: string }
    | { type: 'removed'; clientMsgId: string };

/** Replace one entry; the SAME array when nothing was there to change (React skips the render). */
function amend(
    state: OutboxEntry[],
    clientMsgId: string,
    when: (entry: OutboxEntry) => boolean,
    patch: Partial<OutboxEntry>,
): OutboxEntry[] {
    const index = state.findIndex(
        (entry) => entry.clientMsgId === clientMsgId && when(entry),
    );

    if (index === -1) {
        return state;
    }

    return state.map((entry, i) =>
        i === index ? { ...entry, ...patch } : entry,
    );
}

export function outboxReducer(
    state: OutboxEntry[],
    action: OutboxAction,
): OutboxEntry[] {
    switch (action.type) {
        case 'queued':
            return state.some((e) => e.clientMsgId === action.entry.clientMsgId)
                ? state
                : [...state, action.entry];
        case 'acked':
            return amend(state, action.clientMsgId, () => true, {
                serverUlid: action.ulid,
            });
        case 'failed':
            return amend(
                state,
                action.clientMsgId,
                (entry) => entry.state === 'sending',
                {
                    state: 'failed',
                    failure: action.failure,
                    retryAfter: action.retryAfter ?? null,
                },
            );
        case 'retrying':
            return amend(
                state,
                action.clientMsgId,
                (entry) => entry.state === 'failed',
                { state: 'sending', failure: null, retryAfter: null },
            );
        case 'removed':
            return state.some(
                (entry) => entry.clientMsgId === action.clientMsgId,
            )
                ? state.filter(
                      (entry) => entry.clientMsgId !== action.clientMsgId,
                  )
                : state;
        default:
            return state;
    }
}

/** The highest message id of a transcript (`null` when empty): a ULID sorts by time. */
export function highestUlid(messages: readonly WaMessage[]): string | null {
    let top: string | null = null;

    for (const message of messages) {
        if (top === null || message.ulid > top) {
            top = message.ulid;
        }
    }

    return top;
}

/**
 * The outbox entries the server's copy has NOT replaced yet, in the order they were typed. An entry is matched to one server message
 * at most, and a server message answers at most one entry (two identical replies in a row stay two bubbles).
 */
export function pendingOutbox(
    server: readonly WaMessage[],
    outbox: readonly OutboxEntry[],
    me: number,
): OutboxEntry[] {
    const used = new Set<string>();
    const open: OutboxEntry[] = [];

    for (const entry of outbox) {
        const direct =
            entry.serverUlid === null
                ? undefined
                : server.find((message) => message.ulid === entry.serverUlid);

        if (direct) {
            used.add(direct.ulid);

            continue;
        }

        const body = entry.body.trim();
        const twin = server.find(
            (message) =>
                !used.has(message.ulid) &&
                message.direction === 'out' &&
                message.sentBy?.id === me &&
                (entry.after === null || message.ulid > entry.after) &&
                (message.body ?? '').trim() === body,
        );

        if (twin) {
            used.add(twin.ulid);

            continue;
        }

        open.push(entry);
    }

    return open;
}

/** A message as the transcript lists it: the server's, or an outbox entry dressed as one (`local`, with the way it failed). */
export type DisplayMessage = WaMessage & {
    local?: {
        clientMsgId: string;
        failure: WaSendFailure | null;
        retryAfter: number | null;
    };
};

export function outboxAsMessage(
    entry: OutboxEntry,
    chat: string,
    me: { id: number; name: string },
): DisplayMessage {
    return {
        // A client id is a ULID too, so the list keeps a stable, time-ordered key until the server's copy replaces it.
        ulid: entry.clientMsgId,
        chat,
        direction: 'out',
        type: 'text',
        body: entry.body,
        media: null,
        status: entry.state === 'failed' ? 'failed' : 'pending',
        error: null,
        sentBy: { id: me.id, name: me.name },
        waTimestamp: entry.createdAt,
        createdAt: entry.createdAt,
        local: {
            clientMsgId: entry.clientMsgId,
            failure: entry.failure,
            retryAfter: entry.retryAfter,
        },
    };
}

/** The transcript to draw: the server's messages, then the replies still waiting for theirs (always at the end: they are the newest). */
export function displayMessages(
    server: readonly WaMessage[],
    outbox: readonly OutboxEntry[],
    chat: string,
    me: { id: number; name: string },
): DisplayMessage[] {
    return [
        ...server,
        ...pendingOutbox(server, outbox, me.id).map((entry) =>
            outboxAsMessage(entry, chat, me),
        ),
    ];
}

/**
 * Where a gap sync starts: right after the newest message, or earlier when a reply of ours has not reached its final status yet (an ack
 * changes a row without adding one, and nothing replays an event that happened while the socket was down): then from the message before
 * the oldest of them, at most `lookback` rows back.
 */
export function syncCursor(
    server: readonly WaMessage[],
    lookback = 100,
): string | null {
    const top = highestUlid(server);

    if (top === null) {
        return null;
    }

    const window = server.slice(-lookback);
    const unsettled = window.findIndex(
        (message) =>
            message.direction === 'out' &&
            (message.status === 'pending' ||
                message.status === 'sent' ||
                message.status === 'delivered'),
    );

    if (unsettled === -1) {
        return top;
    }

    // `null`: from the start of the window (there is no message before it that we hold).
    return window[unsettled - 1]?.ulid ?? null;
}
