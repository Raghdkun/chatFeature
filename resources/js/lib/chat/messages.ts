/**
 * Message list helpers shared by the embed panel and the dashboard. Pure functions (no React, no clock, no network):
 * a list is whatever a client holds for ONE conversation, ordered by `seq` with unsent messages last.
 *
 * Messages reach a client in three ways that can interleave arbitrarily: the optimistic copy the user just typed, the REST
 * response of the send, and the `message.created` broadcast (plus `GET ...?after_seq=N` after a reconnect). `mergeMessages`
 * makes all of them converge on the same list, whatever the order and however often a message arrives.
 */
import type {
    LocalMessage,
    MessageData,
    MessageFailure,
    MessageSenderData,
    MessageStatus,
    SenderType,
} from '@/lib/chat/types';

type Incoming = MessageData | LocalMessage;

/** `true` while the server has not numbered the message (it is being sent, or the send failed). */
export function isPending(message: Pick<LocalMessage, 'seq'>): boolean {
    return message.seq === null;
}

/** Receipts only move forward: `seen` beats `delivered` beats `sent`. */
function statusFromReceipts(message: {
    deliveredAt: string | null;
    seenAt: string | null;
}): MessageStatus {
    if (message.seenAt !== null) {
        return 'seen';
    }

    return message.deliveredAt !== null ? 'delivered' : 'sent';
}

const STATUS_RANK: Record<MessageStatus, number> = {
    failed: 0,
    sending: 1,
    sent: 2,
    delivered: 3,
    seen: 4,
};

/** A message as the server sent it, ready for a list (`status` follows its receipts). */
export function toLocalMessage(message: MessageData): LocalMessage {
    return { ...message, status: statusFromReceipts(message) };
}

export type PendingMessageInput = {
    /** The client-generated ULID that makes the send idempotent (`client_msg_id`). */
    clientMsgId: string;
    /** The ulid of the conversation. */
    conversation: string;
    sender: MessageSenderData;
    body: string | null;
    /** ISO time of the optimistic copy; the server's `createdAt` replaces it. */
    createdAt: string;
    type?: MessageData['type'];
    attachments?: MessageData['attachments'];
};

/** The optimistic copy shown while the message is on its way (`status: 'sending'`, no `ulid` / `seq` yet). */
export function createPendingMessage(input: PendingMessageInput): LocalMessage {
    return {
        ulid: null,
        seq: null,
        conversation: input.conversation,
        sender: input.sender,
        type: input.type ?? (input.attachments?.length ? 'image' : 'text'),
        body: input.body,
        attachments: input.attachments ?? [],
        clientMsgId: input.clientMsgId,
        createdAt: input.createdAt,
        deliveredAt: null,
        seenAt: null,
        status: 'sending',
    };
}

function sameSender(a: MessageSenderData, b: MessageSenderData): boolean {
    return (
        a.type === b.type &&
        a.name === b.name &&
        a.avatarUrl === b.avatarUrl &&
        a.id === b.id
    );
}

function sameAttachments(
    a: MessageData['attachments'],
    b: MessageData['attachments'],
): boolean {
    return (
        a.length === b.length &&
        a.every(
            (attachment, index) =>
                attachment.ulid === b[index].ulid &&
                attachment.url === b[index].url &&
                attachment.thumbUrl === b[index].thumbUrl,
        )
    );
}

function sameMessage(a: LocalMessage, b: LocalMessage): boolean {
    return (
        a.ulid === b.ulid &&
        a.seq === b.seq &&
        a.conversation === b.conversation &&
        a.type === b.type &&
        a.body === b.body &&
        a.clientMsgId === b.clientMsgId &&
        a.createdAt === b.createdAt &&
        a.deliveredAt === b.deliveredAt &&
        a.seenAt === b.seenAt &&
        a.status === b.status &&
        sameSender(a.sender, b.sender) &&
        sameAttachments(a.attachments, b.attachments)
    );
}

function isLocal(message: Incoming): message is LocalMessage {
    return 'status' in message;
}

function later(a: string | null, b: string | null): string | null {
    if (a === null) {
        return b;
    }

    if (b === null) {
        return a;
    }

    return a >= b ? a : b;
}

/** Whether the two describe the same message: same ulid, same seq, or the same client-generated id. */
function isSameMessage(a: LocalMessage, b: LocalMessage): boolean {
    return (
        (a.ulid !== null && a.ulid === b.ulid) ||
        (a.seq !== null && a.seq === b.seq) ||
        (a.clientMsgId !== null && a.clientMsgId === b.clientMsgId)
    );
}

/**
 * What a list should hold after `incoming` met `existing` (the same message seen twice).
 *
 * - The server's copy wins over the optimistic one; an optimistic copy never replaces a server copy (the broadcast can beat the
 *   send's own response).
 * - Receipts and status only move forward: an older snapshot never un-sees a message.
 * - The result is `existing` itself when nothing changed, so React state does not churn.
 */
function combine(existing: LocalMessage, incoming: LocalMessage): LocalMessage {
    const existingSequenced = existing.seq !== null;
    const incomingSequenced = incoming.seq !== null;

    if (existingSequenced && !incomingSequenced) {
        return existing;
    }

    const base = incomingSequenced ? incoming : existing;
    const deliveredAt = later(existing.deliveredAt, incoming.deliveredAt);
    const seenAt = later(existing.seenAt, incoming.seenAt);
    let status: MessageStatus;

    if (incomingSequenced) {
        const fromReceipts = statusFromReceipts({ deliveredAt, seenAt });
        const known = existingSequenced ? existing.status : fromReceipts;
        status =
            STATUS_RANK[known] >= STATUS_RANK[fromReceipts]
                ? known
                : fromReceipts;
    } else {
        status = incoming.status;
    }

    const merged: LocalMessage = { ...base, deliveredAt, seenAt, status };

    return sameMessage(existing, merged) ? existing : merged;
}

function bySeq(a: LocalMessage, b: LocalMessage): number {
    if (a.seq !== null && b.seq !== null) {
        return a.seq - b.seq;
    }

    if (a.seq !== null) {
        return -1;
    }

    if (b.seq !== null) {
        return 1;
    }

    return 0;
}

/**
 * Merge messages into a conversation's list, idempotently.
 *
 * Messages are the same when they share a `ulid`, a `seq` or a `clientMsgId`, so the optimistic copy (matched by
 * `clientMsgId`), a replayed broadcast and a catch-up fetch all collapse into one entry. The list comes back ordered by `seq`;
 * messages without a `seq` (sending / failed) follow, in the order they were created. Input is never mutated, and the same
 * array is returned when the merge changed nothing.
 */
export function mergeMessages(
    existing: readonly LocalMessage[],
    incoming: readonly Incoming[],
): LocalMessage[] {
    const list = [...existing];
    let changed = false;

    for (const raw of incoming) {
        const message = isLocal(raw) ? raw : toLocalMessage(raw);
        const index = list.findIndex((candidate) =>
            isSameMessage(candidate, message),
        );

        if (index === -1) {
            list.push(message);
            changed = true;

            continue;
        }

        const combined = combine(list[index], message);

        if (combined !== list[index]) {
            list[index] = combined;
            changed = true;
        }
    }

    if (!changed) {
        return existing as LocalMessage[];
    }

    // `Array.prototype.sort` is stable: unsent messages keep the order they were added in.
    return list.sort(bySeq);
}

/** The highest `seq` in the list (0 when nothing has been numbered yet). */
export function highestSeq(
    messages: readonly Pick<LocalMessage, 'seq'>[],
): number {
    return messages.reduce(
        (highest, message) =>
            message.seq !== null && message.seq > highest
                ? message.seq
                : highest,
        0,
    );
}

export type SeqRange = { from: number; to: number };

export type MessageGap = {
    /** The value for `GET .../messages?after_seq=`: everything after the last message before the first hole. */
    afterSeq: number;
    /** The missing sequence numbers as inclusive ranges, ascending. */
    ranges: SeqRange[];
    /** How many messages are missing. */
    count: number;
};

/**
 * The holes in 1..`lastSeq` (`lastSeq` = the newest seq the client knows exists: the conversation's `lastSeq`, or the `seq` of a
 * message that just arrived). `null` when nothing in that span is missing. Unsent messages and messages above `lastSeq` are
 * ignored. Merge an incoming message first, then ask with `Math.max(conversation.lastSeq, highestSeq(merged))`.
 */
export function findGap(
    messages: readonly Pick<LocalMessage, 'seq'>[],
    lastSeq: number,
): MessageGap | null {
    if (!Number.isFinite(lastSeq) || lastSeq < 1) {
        return null;
    }

    const have = new Set<number>();

    for (const message of messages) {
        if (
            message.seq !== null &&
            message.seq >= 1 &&
            message.seq <= lastSeq
        ) {
            have.add(message.seq);
        }
    }

    if (have.size === lastSeq) {
        return null;
    }

    const ranges: SeqRange[] = [];
    let count = 0;
    let start: number | null = null;

    for (let seq = 1; seq <= lastSeq + 1; seq++) {
        const missing = seq <= lastSeq && !have.has(seq);

        if (missing && start === null) {
            start = seq;
        }

        if (!missing && start !== null) {
            ranges.push({ from: start, to: seq - 1 });
            count += seq - start;
            start = null;
        }
    }

    return { afterSeq: ranges[0].from - 1, ranges, count };
}

/** Set a status (retry: `sending`, give up: `failed`) on the pending message with this `clientMsgId`. */
export function setPendingStatus(
    messages: readonly LocalMessage[],
    clientMsgId: string,
    status: Extract<MessageStatus, 'sending' | 'failed'>,
    failure?: MessageFailure,
): LocalMessage[] {
    let changed = false;
    const next = messages.map((message) => {
        if (
            message.clientMsgId !== clientMsgId ||
            message.seq !== null ||
            (message.status === status && message.failure === failure)
        ) {
            return message;
        }

        changed = true;

        const { failure: _previous, ...rest } = message;

        return status === 'failed' && failure !== undefined
            ? { ...rest, status, failure }
            : { ...rest, status };
    });

    return changed ? next : (messages as LocalMessage[]);
}

/**
 * Apply a `message.seen` receipt: `by` read the conversation up to `upToSeq` (at `at`), so every message written by the other
 * side up to that point is `seen` (and `delivered`). System lines are not receipted.
 */
export function applySeen(
    messages: readonly LocalMessage[],
    receipt: { upToSeq: number; by: SenderType; at: string },
): LocalMessage[] {
    let changed = false;
    const next = messages.map((message) => {
        if (
            message.seq === null ||
            message.seq > receipt.upToSeq ||
            message.sender.type === receipt.by ||
            message.sender.type === 'system' ||
            message.seenAt !== null
        ) {
            return message;
        }

        changed = true;

        return {
            ...message,
            deliveredAt: message.deliveredAt ?? receipt.at,
            seenAt: receipt.at,
            status: 'seen' as const,
        };
    });

    return changed ? next : (messages as LocalMessage[]);
}

/**
 * Apply a `message.delivered` receipt: `by`'s client received the conversation up to `upToSeq` (at `at`), so every message written
 * by the other side up to that point is at least `delivered`. Receipts only move forward: a `seen` message stays `seen`, an
 * earlier `deliveredAt` stays, and a replayed or reordered receipt returns the same list. System lines are not receipted.
 */
export function applyDelivered(
    messages: readonly LocalMessage[],
    receipt: { upToSeq: number; by: SenderType; at: string },
): LocalMessage[] {
    if (receipt.by === 'system') {
        return messages as LocalMessage[];
    }

    let changed = false;
    const next = messages.map((message) => {
        if (
            message.seq === null ||
            message.seq > receipt.upToSeq ||
            message.sender.type === receipt.by ||
            message.sender.type === 'system' ||
            message.deliveredAt !== null ||
            message.seenAt !== null
        ) {
            return message;
        }

        changed = true;

        return {
            ...message,
            deliveredAt: receipt.at,
            status: 'delivered' as const,
        };
    });

    return changed ? next : (messages as LocalMessage[]);
}

/** The highest `seq` of the messages written by `sender` (0 when none): what a receipt for them would acknowledge. */
export function highestSeqFrom(
    messages: readonly LocalMessage[],
    sender: SenderType,
): number {
    return highestSeq(
        messages.filter((message) => message.sender.type === sender),
    );
}
