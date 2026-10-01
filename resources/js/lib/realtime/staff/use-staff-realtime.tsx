/**
 * The Echo side of the agent dashboard: components that render nothing and bind `@laravel/echo-react` hooks to the controller.
 *
 *  - `private-staff.{userId}`: `chat.offered`, `chat.taken`, `chat.assigned`, `conversation.updated`, `unread.updated`,
 *    `queue.updated`, `session.revoked`
 *  - `private-admin` (admins): `conversation.updated`, `queue.updated`, `offline-ticket.created`
 *  - `presence-staff`: the roster (here / joining / leaving) and `presence.changed`
 *  - the connection status, which drives the "reconnecting" indicator and the REST polling fallback
 *
 * One `useEcho` per event on purpose: its callback only receives the payload, so the event name must be fixed per subscription.
 */
import {
    useConnectionStatus,
    useEcho,
    useEchoPresence,
} from '@laravel/echo-react';
import { Component, useEffect, useRef, type ReactNode } from 'react';
import {
    CHAT_EVENT,
    channels,
    echoEvent,
    type ChatEventName,
    type ChatEventPayloads,
} from '@/lib/chat/events';
import type { PresenceMemberData } from '@/lib/chat/types';
import type { StaffController } from '@/lib/realtime/staff/controller';
import type { InboxStore } from '@/lib/realtime/staff/store';

/** Listen to one server event on a private channel with a handler that may change between renders. */
export function useChannelEvent<E extends ChatEventName>(
    channel: string,
    event: E,
    handler: (payload: ChatEventPayloads[E]) => void,
): void {
    const latest = useRef(handler);

    useEffect(() => {
        latest.current = handler;
    });

    useEcho<ChatEventPayloads[E]>(
        channel,
        echoEvent(event),
        (payload) => latest.current(payload),
        [channel],
    );
}

function StaffChannelBindings({
    controller,
    userId,
}: {
    controller: StaffController;
    userId: number;
}) {
    const channel = channels.staff(userId);

    useChannelEvent(channel, CHAT_EVENT.offered, (payload) =>
        controller.handle('chat.offered', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.taken, (payload) =>
        controller.handle('chat.taken', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.assigned, (payload) =>
        controller.handle('chat.assigned', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.conversationUpdated, (payload) =>
        controller.handle('conversation.updated', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.unreadUpdated, (payload) =>
        controller.handle('unread.updated', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.queueUpdated, (payload) =>
        controller.handle('queue.updated', payload),
    );
    useChannelEvent(channel, CHAT_EVENT.sessionRevoked, (payload) =>
        controller.handle('session.revoked', payload),
    );

    return null;
}

function AdminChannelBindings({ controller }: { controller: StaffController }) {
    useChannelEvent(channels.admin, CHAT_EVENT.conversationUpdated, (payload) =>
        controller.handle('conversation.updated', payload),
    );
    useChannelEvent(channels.admin, CHAT_EVENT.queueUpdated, (payload) =>
        controller.handle('queue.updated', payload),
    );
    useChannelEvent(
        channels.admin,
        CHAT_EVENT.offlineTicketCreated,
        (payload) => controller.handle('offline-ticket.created', payload),
    );

    return null;
}

function PresenceBindings({
    controller,
    store,
}: {
    controller: StaffController;
    store: InboxStore;
}) {
    const presence = useEchoPresence<ChatEventPayloads['presence.changed']>(
        channels.presenceStaff,
        echoEvent(CHAT_EVENT.presenceChanged),
        (payload) => controller.handle('presence.changed', payload),
        [controller],
    );

    useEffect(() => {
        const channel = presence.channel();

        // Member info is `{id, name, avatarUrl, status}` (the channel authoriser's `user_info`).
        channel
            ?.here((members: PresenceMemberData[]) =>
                store.dispatch({ type: 'rosterHere', members }),
            )
            .joining((member: PresenceMemberData) =>
                store.dispatch({ type: 'rosterJoin', member }),
            )
            .leaving((member: PresenceMemberData) =>
                store.dispatch({ type: 'rosterLeave', id: member.id }),
            );
    }, [presence, store]);

    return null;
}

function ConnectionBinding({ controller }: { controller: StaffController }) {
    const status = useConnectionStatus();

    useEffect(() => {
        controller.setConnection(status);
    }, [controller, status]);

    return null;
}

/** Keeps a socket problem (a constructor that throws on a missing key, a bad host) from taking the whole dashboard down. */
class SocketBoundary extends Component<
    { onFailure: () => void; children: ReactNode },
    { failed: boolean }
> {
    state = { failed: false };

    static getDerivedStateFromError(): { failed: boolean } {
        return { failed: true };
    }

    componentDidCatch(): void {
        this.props.onFailure();
    }

    render(): ReactNode {
        return this.state.failed ? null : this.props.children;
    }
}

/** Mount every realtime binding; renders nothing. */
export function StaffRealtimeBindings({
    controller,
    store,
    userId,
    isAdmin,
}: {
    controller: StaffController;
    store: InboxStore;
    userId: number;
    isAdmin: boolean;
}) {
    return (
        <SocketBoundary
            onFailure={() => controller.setConnection('unavailable')}
        >
            <ConnectionBinding controller={controller} />
            <StaffChannelBindings controller={controller} userId={userId} />
            {isAdmin && <AdminChannelBindings controller={controller} />}
            <PresenceBindings controller={controller} store={store} />
        </SocketBoundary>
    );
}
