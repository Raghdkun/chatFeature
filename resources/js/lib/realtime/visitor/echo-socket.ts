/**
 * The Echo + Pusher implementation of `ConversationSocket`: `laravel-echo` against Reverb, authorised through the visitor
 * broadcasting endpoint with `Authorization: Bearer vt_...` (channel `private-conversation.{ulid}` only).
 *
 * Both libraries are imported dynamically, so the idle panel (and a visitor who never starts a chat) does not pay for them; this
 * module is only ever loaded by the connection manager when a chat enters `queued` or is resumed.
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
    let authError: ((status: number) => void) | null = null;

    channel.error((error: unknown) => {
        const status =
            typeof error === 'object' && error !== null && 'status' in error
                ? Number((error as { status: unknown }).status)
                : 0;

        if (status === 401 || status === 403) {
            authError?.(status);
        }
    });

    const socket: ConversationSocket = {
        listen(event: string, handler: Listener): void {
            channel.listen(event, handler);
        },
        whisper(event, payload): void {
            channel.whisper(whisperName(event), payload);
        },
        onStatus(handler) {
            return echo.connector.onConnectionChange((status: string) =>
                handler(STATUS[status] ?? 'connecting'),
            );
        },
        status() {
            return STATUS[echo.connectionStatus()] ?? 'connecting';
        },
        onAuthError(handler) {
            authError = handler;
        },
        close() {
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
