import { createContext, useContext, useSyncExternalStore } from 'react';
import type { StaffController } from '@/lib/realtime/staff/controller';
import type { SoundPlayer } from '@/lib/realtime/staff/sound';
import type {
    InboxState,
    InboxStore,
    Viewer,
} from '@/lib/realtime/staff/store';

export type StaffRealtimeContextValue = {
    store: InboxStore;
    controller: StaffController;
    sound: SoundPlayer;
    viewer: Viewer & { isAgent: boolean };
    /** Whether a websocket is in use at all (false: REST polling only). */
    sockets: boolean;
    /** The conversation the view shows, so unread bumps for it are not announced (`null` when none is open). */
    setViewing: (ulid: string | null) => void;
};

export const StaffRealtimeContext =
    createContext<StaffRealtimeContextValue | null>(null);

/** `null` outside the provider (pages that render for a user without chat access, or in a bare test). */
export function useStaffRealtimeOptional(): StaffRealtimeContextValue | null {
    return useContext(StaffRealtimeContext);
}

export function useStaffRealtimeContext(): StaffRealtimeContextValue {
    const value = useContext(StaffRealtimeContext);

    if (!value) {
        throw new Error(
            'The staff realtime context is missing: wrap the page in <StaffRealtimeProvider>.',
        );
    }

    return value;
}

/**
 * The live staff session (`store`, `controller`, `sound`, `viewer`) of the signed-in agent: the entry point the inbox screens use.
 * (It is the same hook as `useStaffRealtimeContext`; the Echo subscriptions themselves live in `StaffRealtimeBindings`.)
 */
export const useStaffRealtime = useStaffRealtimeContext;

/** Read a slice of the live inbox state; `selector` must return a primitive or a part of the state (stable references). */
export function useInbox<T>(selector: (state: InboxState) => T): T {
    const { store } = useStaffRealtimeContext();

    return useSyncExternalStore(
        store.subscribe,
        () => selector(store.getState()),
        () => selector(store.getState()),
    );
}

/** Like {@link useInbox}, but `null` when there is no provider (the sidebar badge on a page without chat access). */
export function useInboxOptional<T>(
    selector: (state: InboxState) => T,
): T | null {
    const context = useContext(StaffRealtimeContext);

    return useSyncExternalStore(
        context ? context.store.subscribe : noopSubscribe,
        () => (context ? selector(context.store.getState()) : null),
        () => null,
    );
}

function noopSubscribe(): () => void {
    return () => undefined;
}
