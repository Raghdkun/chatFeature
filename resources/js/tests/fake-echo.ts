/**
 * An in-memory stand-in for `@laravel/echo-react`, so hooks and pages are tested against the real wiring (channel names, the leading
 * dot of custom event names, whispers, presence callbacks, connection status) without a websocket:
 *
 *   vi.mock('@laravel/echo-react', async () => (await import('@/tests/fake-echo')).fakeEchoModule());
 *   fakeEcho.emitServer('staff.7', 'chat.offered', offer);   // what Reverb would push
 *
 * Like Echo, it delivers a custom event name ONLY to listeners that subscribed with the leading dot (`echoEvent()`): code that forgets
 * the dot hears nothing and the test fails.
 */
import { useEffect, useRef, useSyncExternalStore } from 'react';
import type { PresenceMemberData } from '@/lib/chat/types';

type Listener = (payload: unknown) => void;
type Visibility = 'private' | 'presence' | 'public';
export type FakeConnection =
    | 'connected'
    | 'connecting'
    | 'reconnecting'
    | 'disconnected'
    | 'failed';

const listeners = new Map<string, Set<Listener>>();
const connectionListeners = new Set<() => void>();
const presenceCallbacks = {
    here: [] as ((members: PresenceMemberData[]) => void)[],
    joining: [] as ((member: PresenceMemberData) => void)[],
    leaving: [] as ((member: PresenceMemberData) => void)[],
};
let connection: FakeConnection = 'connected';
let connectionFailure: Error | null = null;
const subscribed = new Map<string, number>();

export const whispers: { channel: string; event: string; payload: unknown }[] =
    [];

const key = (visibility: Visibility, channel: string, event: string) =>
    `${visibility}|${channel}|${event}`;

export const fakeEcho = {
    /** Deliver a raw event name exactly as Echo's `listen()` would match it. */
    emit(
        channel: string,
        event: string,
        payload: unknown,
        visibility: Visibility = 'private',
    ) {
        listeners
            .get(key(visibility, channel, event))
            ?.forEach((listener) => listener(payload));
    },
    /** Deliver a server event (`broadcastAs()` name, which Echo matches with a leading dot). */
    emitServer(
        channel: string,
        name: string,
        payload: unknown,
        visibility: Visibility = 'private',
    ) {
        this.emit(channel, `.${name}`, payload, visibility);
    },
    setConnection(status: FakeConnection) {
        connection = status;
        connectionListeners.forEach((listener) => listener());
    },
    /** Make `useConnectionStatus()` throw, like Echo does when Pusher cannot be constructed (missing key, bad host). */
    failConnection(error: Error | null) {
        connectionFailure = error;
    },
    presence: {
        here: (members: PresenceMemberData[]) =>
            presenceCallbacks.here.forEach((cb) => cb(members)),
        join: (member: PresenceMemberData) =>
            presenceCallbacks.joining.forEach((cb) => cb(member)),
        leave: (member: PresenceMemberData) =>
            presenceCallbacks.leaving.forEach((cb) => cb(member)),
    },
    /** Channels with at least one live subscription (`private:staff.7`). */
    channels: () =>
        [...subscribed.entries()]
            .filter(([, count]) => count > 0)
            .map(([name]) => name),
    reset() {
        listeners.clear();
        subscribed.clear();
        whispers.length = 0;
        presenceCallbacks.here.length = 0;
        presenceCallbacks.joining.length = 0;
        presenceCallbacks.leaving.length = 0;
        connection = 'connected';
        connectionFailure = null;
    },
};

function handle(visibility: Visibility, channel: string) {
    const self = {
        whisper(event: string, payload: unknown) {
            whispers.push({ channel, event: `client-${event}`, payload });

            return self;
        },
        here(cb: (members: PresenceMemberData[]) => void) {
            presenceCallbacks.here.push(cb);

            return self;
        },
        joining(cb: (member: PresenceMemberData) => void) {
            presenceCallbacks.joining.push(cb);

            return self;
        },
        leaving(cb: (member: PresenceMemberData) => void) {
            presenceCallbacks.leaving.push(cb);

            return self;
        },
    };

    return self;
}

function useFakeEcho(
    visibility: Visibility,
    channel: string,
    event: string | string[],
    callback: Listener,
) {
    const latest = useRef(callback);

    useEffect(() => {
        latest.current = callback;
    });

    const events = Array.isArray(event) ? event : [event];
    const eventKey = events.join('|');

    useEffect(() => {
        const bound = events.map((name) => {
            const listener: Listener = (payload) => latest.current(payload);
            const k = key(visibility, channel, name);

            listeners.set(k, (listeners.get(k) ?? new Set()).add(listener));

            return [k, listener] as const;
        });
        const channelKey = `${visibility}:${channel}`;

        subscribed.set(channelKey, (subscribed.get(channelKey) ?? 0) + 1);

        return () => {
            bound.forEach(([k, listener]) =>
                listeners.get(k)?.delete(listener),
            );
            subscribed.set(channelKey, (subscribed.get(channelKey) ?? 1) - 1);
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [visibility, channel, eventKey]);

    return {
        channel: () => handle(visibility, channel),
        leave: () => undefined,
        leaveChannel: () => undefined,
        listen: () => undefined,
        stopListening: () => undefined,
    };
}

export function fakeEchoModule() {
    return {
        useEcho: (
            channel: string,
            event: string | string[] = [],
            callback: Listener = () => undefined,
            _deps?: unknown[],
            visibility: Visibility = 'private',
        ) => useFakeEcho(visibility, channel, event, callback),
        useEchoPresence: (
            channel: string,
            event: string | string[] = [],
            callback: Listener = () => undefined,
        ) => useFakeEcho('presence', channel, event, callback),
        useConnectionStatus: (): FakeConnection => {
            if (connectionFailure) {
                throw connectionFailure;
            }

            // eslint-disable-next-line react-hooks/rules-of-hooks -- the throw above is the only early exit and it aborts the render
            return useSyncExternalStore(
                (notify) => {
                    connectionListeners.add(notify);

                    return () => connectionListeners.delete(notify);
                },
                () => connection,
                () => connection,
            );
        },
        echoIsConfigured: () => true,
        configureEcho: () => undefined,
        echo: () => ({}),
    };
}
