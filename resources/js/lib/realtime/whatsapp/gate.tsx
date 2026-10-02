/**
 * The door to the WhatsApp live session for the staff host. It is the only part of the WhatsApp realtime code in the dashboard's initial
 * bundle: a context provider and a lazy reference to the engine (`provider.tsx`: the store, the controller, the API client, the socket
 * bindings). The engine is requested only when the signed-in member is an administrator, so an agent never downloads, parses or runs
 * it; an administrator gets it right after the first paint.
 *
 * The tree below must not be re-created when the engine arrives, so the engine runs BESIDE the children and publishes the session into
 * this provider (a wrapper that appeared later would remount the whole page). Until then the context is `null`, exactly as for somebody
 * who is not an administrator: the sidebar badge and the title count show nothing, and the WhatsApp pages wait (`WaReady`).
 */
import { lazy, Suspense, useState, type ReactNode } from 'react';
import {
    WaRealtimeContext,
    type WaRealtimeContextValue,
} from '@/lib/realtime/whatsapp/context';

const Engine = lazy(() =>
    import('@/lib/realtime/whatsapp/provider').then((module) => ({
        default: module.WhatsAppRealtimeEngine,
    })),
);

export function WhatsAppRealtimeGate({
    admin,
    sockets,
    children,
}: {
    /** Only an active administrator gets a session (and only then is the engine requested). */
    admin: boolean;
    sockets: boolean;
    children: ReactNode;
}) {
    const [session, setSession] = useState<WaRealtimeContextValue | null>(null);

    return (
        <WaRealtimeContext.Provider value={admin ? session : null}>
            {admin && (
                <Suspense fallback={null}>
                    <Engine admin sockets={sockets} publish={setSession} />
                </Suspense>
            )}
            {children}
        </WaRealtimeContext.Provider>
    );
}
