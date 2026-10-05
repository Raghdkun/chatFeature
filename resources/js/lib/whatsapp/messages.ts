/**
 * Merging WhatsApp messages on the client. Realtime events and REST pages overlap and arrive out of order (a `wa.message.updated`
 * saying `delivered` can reach the browser after the page was refetched with `read`), so a message only ever moves forward, exactly as
 * on the server (`App\Domain\WhatsApp\Enums\WaMessageStatus`, pinned by `messages.test.ts`). Pure, no React.
 */
import type { WaMessage, WaMessageStatus } from '@/lib/whatsapp/types';

/** The statuses an outbound message may move to from each one. `received` (inbound) and `read` / `failed` are final. */
export const WA_STATUS_TRANSITIONS: Record<WaMessageStatus, WaMessageStatus[]> =
    {
        pending: ['sent', 'delivered', 'read', 'failed'],
        sent: ['delivered', 'read', 'failed'],
        delivered: ['read'],
        read: [],
        failed: [],
        received: [],
    };

export function canAdvanceWaStatus(
    from: WaMessageStatus,
    to: WaMessageStatus,
): boolean {
    return WA_STATUS_TRANSITIONS[from].includes(to);
}

/** The status to keep when `incoming` arrives for a message that is `current`: the incoming one only when it is a step forward. */
export function advanceWaStatus(
    current: WaMessageStatus,
    incoming: WaMessageStatus,
): WaMessageStatus {
    return canAdvanceWaStatus(current, incoming) ? incoming : current;
}

/**
 * Merge incoming copies of messages into a transcript: idempotent by `ulid`, the status only moves forward (the rest of an incoming
 * copy wins: it is the newer read of the same row), oldest first (WhatsApp's own time `waTimestamp`, then `createdAt`, then `ulid`, which is time-ordered). Returns the same
 * array when nothing changed.
 */
export function mergeWaMessages(
    existing: WaMessage[],
    incoming: WaMessage[],
): WaMessage[] {
    const byUlid = new Map(existing.map((message) => [message.ulid, message]));
    let changed = false;

    for (const message of incoming) {
        const known = byUlid.get(message.ulid);

        if (known === undefined) {
            byUlid.set(message.ulid, message);
            changed = true;

            continue;
        }

        const status = advanceWaStatus(known.status, message.status);
        const merged: WaMessage = { ...message, status };

        if (JSON.stringify(merged) !== JSON.stringify(known)) {
            byUlid.set(message.ulid, merged);
            changed = true;
        }
    }

    if (!changed) {
        return existing;
    }

    return [...byUlid.values()].sort(
        (a, b) =>
            compareInstants(a.waTimestamp, b.waTimestamp) ||
            a.createdAt.localeCompare(b.createdAt) ||
            a.ulid.localeCompare(b.ulid),
    );
}

/** Instants of one API (always the same ISO shape) compare as strings; an unparsable one sorts as equal, never throws. */
function compareInstants(a: string, b: string): number {
    const left = Date.parse(a);
    const right = Date.parse(b);

    return Number.isNaN(left) || Number.isNaN(right) ? 0 : left - right;
}
