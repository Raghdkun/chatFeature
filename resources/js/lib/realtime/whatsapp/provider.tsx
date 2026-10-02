/**
 * The WhatsApp live session of the page, mounted by the staff host (`StaffRealtimeHost`, through `gate.tsx`, loaded on demand) for
 * ADMINISTRATORS only: everybody else gets no context, no store, no request and no subscription, and never downloads this code. It
 * renders no UI of its own.
 *
 * It does nothing until something needs it (`useWaRetain`: the sidebar badge, a WhatsApp page): the first consumer starts the unread
 * summary, the polling fallback and, when the page has a websocket, the `private-whatsapp-admin` subscriptions; the last one to leave stops
 * them. The server's `realtime` shared prop decides whether sockets are used at all, exactly as for the staff host (the host passes its
 * own `sockets` flag: no second Echo configuration).
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { waApi, type WaApi } from '@/lib/whatsapp-api/client';
import { WaRealtimeBindings } from '@/lib/realtime/whatsapp/bindings';
import {
    WaRealtimeContext,
    type WaRealtimeContextValue,
} from '@/lib/realtime/whatsapp/context';
import { createWaController } from '@/lib/realtime/whatsapp/controller';
import {
    createWaLiveStore,
    type WaLiveState,
} from '@/lib/realtime/whatsapp/store';

export type WaSessionOptions = {
    sockets: boolean;
    api?: WaApi;
    initial?: Partial<WaLiveState>;
};

/** Build the store and the controller of one administrator's session (`retain` is wired by the provider). */
export function createWaSession(
    options: WaSessionOptions,
    retain: () => () => void,
): WaRealtimeContextValue {
    const store = createWaLiveStore(options.initial);
    const api = options.api ?? waApi;

    return {
        store,
        api,
        controller: createWaController({ store, api }),
        sockets: options.sockets,
        retain,
    };
}

type RuntimeOptions = {
    /** Only an active administrator gets a session. */
    admin: boolean;
    sockets: boolean;
    api?: WaApi;
    initial?: Partial<WaLiveState>;
};

/** The session of one administrator and everything that runs it: the controller while somebody retains it, the socket bindings. */
function useWaRuntime({ admin, sockets, api, initial }: RuntimeOptions): {
    session: WaRealtimeContextValue | null;
    bindings: ReactNode;
} {
    const [consumers, setConsumers] = useState(0);
    const session = useMemo(
        () =>
            admin
                ? createWaSession({ sockets, api, initial }, () => {
                      setConsumers((count) => count + 1);

                      return () => setConsumers((count) => count - 1);
                  })
                : null,
        // The session is rebuilt only when somebody else signs in; callers pass stable doubles.
        // eslint-disable-next-line react-hooks/exhaustive-deps
        [admin, sockets, api],
    );
    const active = consumers > 0;

    useEffect(() => {
        if (!session || !active) {
            return;
        }

        session.controller.start();

        if (!session.sockets) {
            session.controller.setConnection('unavailable');
        }

        const wake = (): void => {
            if (document.visibilityState === 'visible') {
                session.controller.wake();
            }
        };

        document.addEventListener('visibilitychange', wake);
        window.addEventListener('online', wake);

        return () => {
            document.removeEventListener('visibilitychange', wake);
            window.removeEventListener('online', wake);
            session.controller.stop();
        };
    }, [session, active]);

    return {
        session,
        bindings:
            session && session.sockets && active ? (
                <WaRealtimeBindings controller={session.controller} />
            ) : null,
    };
}

/** The session, mounted around its consumers (tests, and anything that can import this module statically). */
export function WhatsAppRealtimeProvider({
    children,
    ...options
}: RuntimeOptions & { children: ReactNode }) {
    const { session, bindings } = useWaRuntime(options);

    return (
        <WaRealtimeContext.Provider value={session}>
            {bindings}
            {children}
        </WaRealtimeContext.Provider>
    );
}

/**
 * The same session, run beside its consumers instead of around them: `publish` hands the session (and `null` when it goes away) to the
 * component that provides the context. This is what the dashboard loads lazily (`gate.tsx`): the page's tree must not be re-created
 * when the code arrives, so it cannot be a wrapper that appears later. Renders no UI.
 */
export function WhatsAppRealtimeEngine({
    publish,
    ...options
}: RuntimeOptions & {
    publish: (session: WaRealtimeContextValue | null) => void;
}) {
    const { session, bindings } = useWaRuntime(options);

    useEffect(() => {
        publish(session);

        return () => publish(null);
    }, [session, publish]);

    return bindings;
}
