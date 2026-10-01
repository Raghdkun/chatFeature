/**
 * What the visitor's realtime layer needs from a websocket, independent of Echo / Pusher: the panel logic and its tests only know
 * this interface, `echo-socket.ts` is the one place that knows the libraries.
 */
import type { WsConfig } from '@/lib/chat-api/visitor';

/** Transport state as the connection manager sees it. */
export type SocketStatus =
    | 'connecting'
    | 'connected'
    | 'reconnecting'
    | 'disconnected'
    | 'failed';

export interface ConversationSocket {
    /**
     * Subscribes to an event of the conversation channel as Echo takes the name (a leading dot keeps a custom `broadcastAs` name,
     * a whisper is `.client-typing`); the payload is whatever the server sent (validated by the caller). Returns the unbinder.
     */
    listen(event: string, handler: (payload: unknown) => void): () => void;
    /** Sends a client event (`client-typing`) to the other members of the channel. */
    whisper(event: string, payload: Record<string, unknown>): void;
    onStatus(handler: (status: SocketStatus) => void): () => void;
    status(): SocketStatus;
    /** The channel subscription succeeded (on the first connect and again after every reconnect). Returns the unbinder. */
    onSubscribed(handler: () => void): () => void;
    /**
     * The channel subscription failed: the broadcasting auth endpoint answered `status` (`401` / `403` mean the session is gone,
     * `503 realtime_unavailable` or anything else means this socket will not deliver events). Returns the unbinder.
     */
    onSubscriptionError(handler: (status: number) => void): () => void;
    /** Unbinds every listener, leaves the channel and disconnects. */
    close(): void;
}

export type SocketInput = {
    ws: WsConfig;
    /** The visitor token (`vt_...`), sent as the bearer of the broadcasting auth request. */
    token: string;
    conversation: string;
    /** `POST /api/v1/public/broadcasting/auth`. */
    authEndpoint: string;
};

/** Opens the socket for one conversation. Rejects when the libraries or the connection cannot be set up. */
export type SocketFactory = (input: SocketInput) => Promise<ConversationSocket>;
