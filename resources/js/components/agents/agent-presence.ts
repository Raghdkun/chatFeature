/**
 * The status dots of the agents page. The page props carry every staff member's effective status at the moment of loading; the live
 * store (`presence.changed` events, heard whether or not the person is on the roster) says what changed since. An event older than the
 * page's own data is ignored: the store outlives page visits.
 */
import type { PresenceStatus } from '@/lib/chat/types';
import type { InboxState } from '@/lib/realtime/staff/store';

export type PresenceById = Record<number, PresenceStatus>;

export function resolvePresence(
    id: number,
    loaded: PresenceById | undefined,
    seen: InboxState['seenPresence'] | null,
    loadedAt: number,
): PresenceStatus {
    const heard = seen?.[id];

    if (heard && heard.at >= loadedAt) {
        return heard.status;
    }

    return loaded?.[id] ?? 'offline';
}

/** How many of these people take chats right now (`online` only: an away agent is offered chats late). */
export function countOnline(
    ids: number[],
    status: (id: number) => PresenceStatus,
): number {
    return ids.filter((id) => status(id) === 'online').length;
}
