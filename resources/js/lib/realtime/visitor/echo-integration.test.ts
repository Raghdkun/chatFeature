/**
 * The visitor's socket against the REAL `laravel-echo` (only the Pusher client underneath is a fake): what `echo-socket.ts` assumes
 * about the library is checked against the library itself, like `tests/echo-integration.test.tsx` does for the staff bindings:
 * custom event names need the leading dot, a whisper leaves as `client-<name>` and arrives under that name, every binding is undone
 * on close, and closing never writes to a socket that is already closing (the browser logs an error for it on the customer's page).
 */
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

type Handler = (data: unknown) => void;

class FakeChannel {
    handlers = new Map<string, Set<Handler>>();
    trigger = vi.fn();

    constructor(public name: string) {}

    bind(event: string, callback: Handler) {
        this.handlers.set(
            event,
            (this.handlers.get(event) ?? new Set()).add(callback),
        );

        return this;
    }

    unbind(event: string, callback?: Handler) {
        if (callback) {
            this.handlers.get(event)?.delete(callback);
        } else {
            this.handlers.delete(event);
        }

        return this;
    }

    bind_global() {
        return this;
    }

    unbind_global() {
        return this;
    }

    /** What the Pusher client does when the server (or a peer's whisper) sends `event` on this channel. */
    receive(event: string, data: unknown) {
        this.handlers.get(event)?.forEach((callback) => callback(data));
    }
}

const pushers: FakePusher[] = [];

class FakePusher {
    channels = { channels: {} as Record<string, FakeChannel> };
    unsubscribed: string[] = [];
    disconnected = false;
    /**
     * The browser WebSocket under the client: `disconnect()` closes it at once (CLOSING; the close handshake ends later) and
     * pusher-js writes every frame one tick later (`Util.defer` in `transport_connection.ts`), so a frame queued before
     * `disconnect()` still lands on the CLOSING socket, where a real browser logs "WebSocket is already in CLOSING or CLOSED state".
     */
    socketState: 'open' | 'closing' = 'open';
    sent: string[] = [];
    sentOnClosingSocket: string[] = [];
    private connectionHandlers = new Map<string, Set<() => void>>();
    connection = {
        state: 'connecting',
        socket_id: '1.1',
        bind: (event: string, callback: () => void) => {
            this.connectionHandlers.set(
                event,
                (this.connectionHandlers.get(event) ?? new Set()).add(callback),
            );
        },
        unbind: (event: string, callback: () => void) => {
            this.connectionHandlers.get(event)?.delete(callback);
        },
    };

    constructor(
        public key: string,
        public options: Record<string, unknown>,
    ) {
        pushers.push(this);
    }

    subscribe(name: string) {
        return (this.channels.channels[name] ??= new FakeChannel(name));
    }

    unsubscribe(name: string) {
        this.unsubscribed.push(name);
        delete this.channels.channels[name];
        this.write(`pusher:unsubscribe ${name}`);
    }

    disconnect() {
        this.disconnected = true;
        this.socketState = 'closing';
    }

    private write(frame: string) {
        setTimeout(
            () =>
                (this.socketState === 'open'
                    ? this.sent
                    : this.sentOnClosingSocket
                ).push(frame),
            0,
        );
    }

    setState(state: string) {
        this.connection.state = state;
        this.connectionHandlers
            .get('state_change')
            ?.forEach((callback) => callback());
    }

    channel(name: string): FakeChannel {
        const channel = this.channels.channels[name];

        if (!channel) {
            throw new Error(
                `Not subscribed to ${name}: ${Object.keys(this.channels.channels).join(', ')}`,
            );
        }

        return channel;
    }
}

vi.mock('pusher-js', () => ({ default: FakePusher }));

const { createEchoSocket } = await import('@/lib/realtime/visitor/echo-socket');
const { openConversationRealtime } =
    await import('@/lib/realtime/visitor/connection');

const INPUT = {
    ws: {
        key: 'reverb-key',
        host: 'ws.chat.test',
        port: 8443,
        scheme: 'https',
    },
    token: 'vt_secret',
    conversation: '01CONV',
    authEndpoint: 'https://chat.test/api/v1/public/broadcasting/auth',
};
const CHANNEL = 'private-conversation.01CONV';

beforeEach(() => {
    pushers.length = 0;
});

describe('the visitor socket on the real Echo', () => {
    it('subscribes to the private conversation channel only, with the visitor bearer as its authorisation', async () => {
        await createEchoSocket(INPUT);

        const pusher = pushers[0];

        expect(Object.keys(pusher.channels.channels)).toEqual([CHANNEL]);
        expect(pusher.key).toBe('reverb-key');
        expect(pusher.options).toMatchObject({
            wsHost: 'ws.chat.test',
            wsPort: 8443,
            wssPort: 8443,
            forceTLS: true,
            authEndpoint: 'https://chat.test/api/v1/public/broadcasting/auth',
            auth: { headers: { Authorization: 'Bearer vt_secret' } },
        });
    });

    it('delivers events under the names the server broadcasts: the leading dot keeps the name as it is, a bare name gets the app namespace', async () => {
        const socket = await createEchoSocket(INPUT);
        const dotted: unknown[] = [];
        const bare: unknown[] = [];

        socket.listen('.message.created', (payload) => dotted.push(payload));
        socket.listen('message.created', (payload) => bare.push(payload));

        const channel = pushers[0].channel(CHANNEL);

        // what Reverb sends for `broadcastAs() === 'message.created'`
        channel.receive('message.created', { v: 1 });

        expect(dotted).toEqual([{ v: 1 }]);
        expect(bare).toEqual([]);
        // a handler registered without the dot hears the namespaced wire name instead (the trap `echoEvent()` avoids)
        channel.receive('App\\Events\\message\\created', { v: 2 });
        expect(bare).toEqual([{ v: 2 }]);
    });

    it('the connection hears the receipts under their broadcastAs() names: message.delivered and message.seen reach their handlers', async () => {
        const delivered: unknown[] = [];
        const seen: unknown[] = [];
        const realtime = await openConversationRealtime({
            factory: createEchoSocket,
            input: INPUT,
            handlers: {
                onMessage: () => undefined,
                onDelivered: (receipt) => delivered.push(receipt),
                onSeen: (receipt) => seen.push(receipt),
                onClaimed: () => undefined,
                onEnded: () => undefined,
                onClosed: () => undefined,
                onMissed: () => undefined,
                onTransferred: () => undefined,
                onTyping: () => undefined,
                onStatus: () => undefined,
                sync: () => undefined,
                onAuthFailure: () => undefined,
            },
            pollMs: 60_000,
            retryMs: 60_000,
        });
        const channel = pushers[0].channel(CHANNEL);
        const at = '2026-11-20T10:00:00.000Z';

        // what Reverb sends: the bare `broadcastAs()` name, not the `App\Events\...` one
        channel.receive('message.delivered', {
            v: 1,
            upToSeq: 2,
            by: 'agent',
            at,
        });
        channel.receive('message.seen', { v: 1, upToSeq: 2, by: 'agent', at });

        expect(delivered).toEqual([{ upToSeq: 2, by: 'agent', at }]);
        expect(seen).toEqual([{ upToSeq: 2, by: 'agent', at }]);

        realtime.close();
    });

    it('whispers out as client-<name> on the channel, and hears the peer whisper under the same wire name', async () => {
        const socket = await createEchoSocket(INPUT);
        const heard: unknown[] = [];

        // the panel registers the whisper with the `client-` name from the contract
        socket.listen('.client-typing', (payload) => heard.push(payload));
        socket.whisper('client-typing', { actor: 'visitor', typing: true });

        const channel = pushers[0].channel(CHANNEL);

        expect(channel.trigger).toHaveBeenCalledTimes(1);
        expect(channel.trigger).toHaveBeenCalledWith('client-typing', {
            actor: 'visitor',
            typing: true,
        });

        channel.receive('client-typing', { actor: 'agent', typing: true });
        expect(heard).toEqual([{ actor: 'agent', typing: true }]);
    });

    it("maps the connection states of the Pusher client to the panel's statuses", async () => {
        const socket = await createEchoSocket(INPUT);
        const seen: string[] = [];

        socket.onStatus((status) => seen.push(status));

        for (const state of [
            'connected',
            'connecting',
            'unavailable',
            'connected',
        ]) {
            pushers[0].setState(state);
        }

        expect(seen.length).toBeGreaterThan(0);
        expect(seen.at(-1)).toBe('connected');
        expect(socket.status()).toBe('connected');
        expect(seen.every((status) => typeof status === 'string')).toBe(true);
    });

    it('close() unbinds every handler it handed out and disconnects, once', async () => {
        const socket = await createEchoSocket(INPUT);
        const seen: string[] = [];

        socket.listen('.message.created', () => seen.push('message'));
        socket.listen('.client-typing', () => seen.push('typing'));
        socket.onStatus(() => seen.push('status'));
        socket.onSubscribed(() => seen.push('subscribed'));
        socket.onSubscriptionError(() => seen.push('error'));

        const pusher = pushers[0];
        const channel = pusher.channel(CHANNEL);

        expect(channel.handlers.get('message.created')?.size).toBe(1);
        expect(channel.handlers.get('client-typing')?.size).toBe(1);

        socket.close();
        socket.close();

        // every app handler is gone; what remains are Echo's own two `pusher:subscription_*` bindings (it can add them, never remove
        // them), which are fanned out to sets that were emptied and die with the Echo instance
        expect(channel.handlers.get('message.created')?.size ?? 0).toBe(0);
        expect(channel.handlers.get('client-typing')?.size ?? 0).toBe(0);
        expect(
            [...channel.handlers]
                .filter(
                    ([name, set]) =>
                        !name.startsWith('pusher:') && set.size > 0,
                )
                .map(([name]) => name),
        ).toEqual([]);
        expect(pusher.disconnected).toBe(true);

        channel.receive('message.created', {});
        channel.receive('client-typing', {});
        pusher.setState('disconnected');
        expect(seen).toEqual([]);
    });

    it('closing writes nothing to the socket it is closing: no pusher:unsubscribe after the disconnect (regression: Chrome logged "WebSocket is already in CLOSING or CLOSED state" on the customer\'s page once per chat)', async () => {
        const socket = await createEchoSocket(INPUT);
        const pusher = pushers[0];

        socket.listen('.message.created', () => undefined);
        socket.close();
        socket.close();

        // pusher-js writes a frame one tick after it was handed over: let every deferred write run
        await new Promise((resolve) => setTimeout(resolve, 5));

        expect(pusher.disconnected).toBe(true);
        expect(pusher.sentOnClosingSocket).toEqual([]);
        expect(pusher.sent).toEqual([]);
    });

    it('an unbinder removes only its own handler', async () => {
        const socket = await createEchoSocket(INPUT);
        const calls: string[] = [];
        const offFirst = socket.listen('.message.created', () =>
            calls.push('first'),
        );

        socket.listen('.message.created', () => calls.push('second'));
        offFirst();
        offFirst();
        pushers[0].channel(CHANNEL).receive('message.created', {});

        expect(calls).toEqual(['second']);
    });
});
