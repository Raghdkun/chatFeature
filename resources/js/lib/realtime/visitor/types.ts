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
    /** Subscribes to an event of the conversation channel; the payload is whatever the server sent (validated by the caller). */
    listen(event: string, handler: (payload: unknown) => void): void;
    /** Sends a client event (`client-typing`) to the other members of the channel. */
    whisper(event: string, payload: Record<string, unknown>): void;
    onStatus(handler: (status: SocketStatus) => void): () => void;
    status(): SocketStatus;
    /** Called once when the broadcasting auth endpoint refuses the visitor (`401` / `403`): the session is gone. */
    onAuthError(handler: (status: number) => void): void;
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
