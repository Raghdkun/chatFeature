/**
 * Pure selectors over the live WhatsApp state. Their own module on purpose: the sidebar badge and the document title (part of the
 * dashboard's initial bundle, for every signed-in member) need them, but not the store, the controller or the API client, which load
 * only for administrators (`gate.tsx`). Type imports only.
 */
import type { WaLiveState } from '@/lib/realtime/whatsapp/store';
import type { WaChat } from '@/lib/whatsapp/types';

/** Unread messages across the open chats (an archived chat is out of sight and out of the count): the badge and the title. */
export function selectUnreadTotal(state: WaLiveState): number {
    let total = 0;

    for (const chat of Object.values(state.chats)) {
        if (chat.status === 'open' && chat.unreadByAdmin > 0) {
            total += chat.unreadByAdmin;
        }
    }

    return total;
}

/** How many open chats have something unread. */
export function selectUnreadChats(state: WaLiveState): number {
    return Object.values(state.chats).filter(
        (chat) => chat.status === 'open' && chat.unreadByAdmin > 0,
    ).length;
}

/** Newest first: the time of the last message, then the id (a ULID is time-ordered). */
export function byRecency(a: WaChat, b: WaChat): number {
    return (
        (b.lastMessageAt ?? b.createdAt).localeCompare(
            a.lastMessageAt ?? a.createdAt,
        ) || b.ulid.localeCompare(a.ulid)
    );
}
