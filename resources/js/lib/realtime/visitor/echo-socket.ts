/**
 * The Echo + Pusher implementation of `ConversationSocket`: `laravel-echo` against Reverb, authorised through the visitor
 * broadcasting endpoint with `Authorization: Bearer vt_...` (channel `private-conversation.{ulid}` only).
 *
 * Both libraries are imported dynamically, so the idle panel (and a visitor who never starts a chat) does not pay for them; this
 * module is only ever loaded by the connection manager when a chat enters `queued` or is resumed.
 *
 * Every binding made through this socket can be undone: `listen` and the subscription callbacks hand back an unbinder, and `close()`
 * removes whatever is left before it leaves the channel and disconnects, so a socket that is replaced (a resumed chat, a new chat)
 * never leaves a handler behind.
 */
import { channels } from '@/lib/chat/events';
import type {
    ConversationSocket,
    SocketFactory,
    SocketStatus,
} from '@/lib/realtime/visitor/types';

const STATUS: Record<string, SocketStatus> = {
    connected: 'connected',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    disconnected: 'disconnected',
    failed: 'failed',
};

type Listener = (payload: unknown) => void;

/** Echo's `whisper('typing')` sends `client-typing`: the contract names carry the prefix, Echo wants it gone. */
const whisperName = (event: string): string => event.replace(/^client-/, '');

export const createEchoSocket: SocketFactory = async (input) => {
    const [{ default: Echo }, { default: Pusher }] = await Promise.all([
        import('laravel-echo'),
        import('pusher-js'),
    ]);
    const { ws } = input;
    const tls = ws.scheme === 'https';

    const echo = new Echo({
        broadcaster: 'reverb',
        Pusher,
        key: ws.key,
        wsHost: ws.host,
        wsPort: ws.port,
        wssPort: ws.port,
        forceTLS: tls,
        enabledTransports: ['ws', 'wss'],
        disableStats: true,
        authEndpoint: input.authEndpoint,
        auth: {
            headers: {
                Authorization: `Bearer ${input.token}`,
                Accept: 'application/json',
            },
        },
        // Nothing here talks to an axios / jQuery / Turbo that needs an `X-Socket-Id` header.
        withoutInterceptors: true,
    });
    const name = channels.conversation(input.conversation);
    const channel = echo.private(name);
    const bound = new Set<() => void>();
    const subscribed = new Set<() => void>();
    const failed = new Set<(status: number) => void>();
    let closed = false;

    // Echo can only add handlers for these two, never remove them: one binding each, fanned out to the sets above.
    channel.subscribed(() => {
        for (const handler of subscribed) {
            handler();
        }
    });
    channel.error((error: unknown) => {
        const status =
            typeof error === 'object' && error !== null && 'status' in error
                ? Number((error as { status: unknown }).status)
                : 0;

        for (const handler of failed) {
            handler(status);
        }
    });

    /** Registers `undo` so `close()` can run it, and returns a once-only version for the caller. */
    const track = (undo: () => void): (() => void) => {
        const once = (): void => {
            if (bound.delete(once)) {
                undo();
            }
        };

        bound.add(once);

        return once;
    };

    const socket: ConversationSocket = {
        listen(event: string, handler: Listener): () => void {
            channel.listen(event, handler);

            return track(() => {
                try {
                    channel.stopListening(event, handler);
                } catch {
                    // the channel is already gone
                }
            });
        },
        whisper(event, payload): void {
            channel.whisper(whisperName(event), payload);
        },
        onStatus(handler) {
            const off = echo.connector.onConnectionChange((status: string) =>
                handler(STATUS[status] ?? 'connecting'),
            );

            return track(off);
        },
        status() {
            return STATUS[echo.connectionStatus()] ?? 'connecting';
        },
        onSubscribed(handler) {
            subscribed.add(handler);

            return track(() => void subscribed.delete(handler));
        },
        onSubscriptionError(handler) {
            failed.add(handler);

            return track(() => void failed.delete(handler));
        },
        close() {
            if (closed) {
                return;
            }

            closed = true;

            for (const undo of bound) {
                undo();
            }

            subscribed.clear();
            failed.clear();

            try {
                echo.leave(name);
                echo.disconnect();
            } catch {
                // already closed
            }
        },
    };

    return socket;
};
