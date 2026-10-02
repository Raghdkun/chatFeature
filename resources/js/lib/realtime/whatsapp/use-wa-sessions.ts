/**
 * The session list of Settings > WhatsApp: seeded from the page props, kept live by `wa.session.status` (the live store holds the single
 * copy of every session) and read again every 15 s while the websocket is down. The actions (add, start, stop, refresh, delete) call the
 * API and put the answer straight into the store, so the screen does not wait for the event that follows.
 */
import { useCallback, useEffect, useLayoutEffect, useMemo } from 'react';
import {
    useWaRealtime,
    useWaRetain,
    useWaState,
    useWaWatch,
} from '@/lib/realtime/whatsapp/context';
import { POLL_INTERVAL_MS } from '@/lib/realtime/whatsapp/controller';
import type { WaApi } from '@/lib/whatsapp-api/client';
import type { SessionPacingInput } from '@/lib/whatsapp-api/types';
import type { WhatsAppSession } from '@/lib/whatsapp/types';

export function useWaSessions(initial: WhatsAppSession[], injectedApi?: WaApi) {
    const { store, api: contextApi } = useWaRealtime();
    const api = injectedApi ?? contextApi;
    const known = useWaState((state) => state.sessions);
    const connection = useWaState((state) => state.connection);

    useWaRetain();
    useWaWatch();

    // The page props are the first picture of the list (and a later Inertia reload is a newer one).
    useLayoutEffect(() => {
        store.dispatch({
            type: 'sessionsLoaded',
            sessions: initial,
            since: store.getState().clock,
        });
    }, [store, initial]);

    const reload = useCallback(async (): Promise<void> => {
        const since = store.getState().clock;

        try {
            store.dispatch({
                type: 'sessionsLoaded',
                sessions: await api.sessions(),
                since,
            });
        } catch {
            // The next trigger (poll tick, reconnect) retries.
        }
    }, [api, store]);

    // No websocket (or it dropped): read the list again every 15 s.
    useEffect(() => {
        if (connection === 'connected') {
            return;
        }

        const timer = setInterval(() => void reload(), POLL_INTERVAL_MS);

        return () => clearInterval(timer);
    }, [connection, reload]);

    // The websocket (re)connected: whatever changed while it was down is a REST call away.
    useEffect(() => {
        if (connection === 'connected') {
            void reload();
        }
    }, [connection, reload]);

    const sessions = useMemo(
        () =>
            Object.values(known).sort(
                (a, b) =>
                    a.createdAt.localeCompare(b.createdAt) ||
                    a.name.localeCompare(b.name),
            ),
        [known],
    );

    const accept = useCallback(
        (session: WhatsAppSession): WhatsAppSession => {
            store.dispatch({ type: 'sessionChanged', session });

            return session;
        },
        [store],
    );

    return {
        sessions,
        connection,
        reload,
        create: async (name: string) => accept(await api.createSession(name)),
        start: async (ulid: string) => accept(await api.startSession(ulid)),
        stop: async (ulid: string) => accept(await api.stopSession(ulid)),
        sync: async (ulid: string) => accept(await api.syncSession(ulid)),
        updatePacing: async (ulid: string, input: SessionPacingInput) =>
            accept(await api.updateSessionPacing(ulid, input)),
        reregisterWebhook: async (ulid: string) =>
            accept(await api.reregisterWebhook(ulid)),
        remove: async (ulid: string, force = false) => {
            await api.deleteSession(ulid, force);
            store.dispatch({ type: 'sessionRemoved', ulid });
        },
    };
}

export type WaSessionsController = ReturnType<typeof useWaSessions>;
