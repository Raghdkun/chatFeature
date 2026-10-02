/**
 * The Echo side of the WhatsApp pages: components that render nothing and bind `@laravel/echo-react` hooks to the controller.
 *
 *  - `private-whatsapp-admin` (administrators only; an agent can never subscribe): `wa.message.created`, `wa.message.updated`,
 *    `wa.chat.updated`, `wa.session.status`
 *  - the connection status, which drives the "reconnecting" indicator and the REST polling fallback
 *
 * One `useEcho` per event on purpose: its callback only receives the payload, so the event name must be fixed per subscription.
 */
import { useConnectionStatus, useEcho } from '@laravel/echo-react';
import { Component, useEffect, useRef, type ReactNode } from 'react';
import {
    WA_EVENT,
    waChannels,
    waEchoEvent,
    type WaEventName,
    type WaEventPayloads,
} from '@/lib/chat/events';
import type { WaController } from '@/lib/realtime/whatsapp/controller';

/** Listen to one WhatsApp event on the admin channel with a handler that may change between renders. */
export function useWaChannelEvent<E extends WaEventName>(
    event: E,
    handler: (payload: WaEventPayloads[E]) => void,
): void {
    const latest = useRef(handler);

    useEffect(() => {
        latest.current = handler;
    });

    useEcho<WaEventPayloads[E]>(
        waChannels.admin,
        waEchoEvent(event),
        (payload) => latest.current(payload),
        [waChannels.admin],
    );
}

function EventBindings({ controller }: { controller: WaController }) {
    useWaChannelEvent(WA_EVENT.messageCreated, (payload) =>
        controller.handle(WA_EVENT.messageCreated, payload),
    );
    useWaChannelEvent(WA_EVENT.messageUpdated, (payload) =>
        controller.handle(WA_EVENT.messageUpdated, payload),
    );
    useWaChannelEvent(WA_EVENT.chatUpdated, (payload) =>
        controller.handle(WA_EVENT.chatUpdated, payload),
    );
    useWaChannelEvent(WA_EVENT.sessionStatus, (payload) =>
        controller.handle(WA_EVENT.sessionStatus, payload),
    );

    return null;
}

function ConnectionBinding({ controller }: { controller: WaController }) {
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

/** Mount every WhatsApp realtime binding; renders nothing. Only ever mounted for an administrator (the channel refuses everybody else). */
export function WaRealtimeBindings({
    controller,
}: {
    controller: WaController;
}) {
    return (
        <SocketBoundary
            onFailure={() => controller.setConnection('unavailable')}
        >
            <ConnectionBinding controller={controller} />
            <EventBindings controller={controller} />
        </SocketBoundary>
    );
}
