import {
    createContext,
    useContext,
    useEffect,
    useSyncExternalStore,
} from 'react';
import type { WaController } from '@/lib/realtime/whatsapp/controller';
import type { WaLiveState, WaLiveStore } from '@/lib/realtime/whatsapp/store';
import type { WaApi } from '@/lib/whatsapp-api/client';

export type WaRealtimeContextValue = {
    store: WaLiveStore;
    controller: WaController;
    api: WaApi;
    /** Whether a websocket is in use at all (false: REST polling only). */
    sockets: boolean;
    /** A consumer (the sidebar badge, a WhatsApp page) needs the live data: the first one starts it, the last one stops it. */
    retain: () => () => void;
};

export const WaRealtimeContext = createContext<WaRealtimeContextValue | null>(
    null,
);

/** `null` outside the provider: for everybody who is not an administrator, and in a bare test. */
export function useWaRealtimeOptional(): WaRealtimeContextValue | null {
    return useContext(WaRealtimeContext);
}

export function useWaRealtime(): WaRealtimeContextValue {
    const value = useContext(WaRealtimeContext);

    if (!value) {
        throw new Error(
            'The WhatsApp realtime context is missing: it exists for administrators only (<WhatsAppRealtimeProvider>).',
        );
    }

    return value;
}

/** Read a slice of the live WhatsApp state; `selector` must return a primitive or a part of the state (stable references). */
export function useWaState<T>(selector: (state: WaLiveState) => T): T {
    const { store } = useWaRealtime();

    return useSyncExternalStore(
        store.subscribe,
        () => selector(store.getState()),
        () => selector(store.getState()),
    );
}

function noopSubscribe(): () => void {
    return () => undefined;
}

/** Like {@link useWaState}, but `null` when there is no provider (the sidebar of somebody who is not an administrator). */
export function useWaStateOptional<T>(
    selector: (state: WaLiveState) => T,
): T | null {
    const context = useContext(WaRealtimeContext);

    return useSyncExternalStore(
        context ? context.store.subscribe : noopSubscribe,
        () => (context ? selector(context.store.getState()) : null),
        () => null,
    );
}

/** Say that this component needs the live data for as long as it is mounted (starts the controller, binds the websocket). */
export function useWaRetain(): void {
    const context = useContext(WaRealtimeContext);

    useEffect(() => context?.retain(), [context]);
}

/** A WhatsApp page is open: the poll fallback runs at the page's pace (15 s) instead of the background pace. */
export function useWaWatch(): void {
    const context = useContext(WaRealtimeContext);

    useEffect(() => context?.controller.watch(), [context]);
}
