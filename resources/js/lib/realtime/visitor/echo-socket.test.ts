import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const created: {
    options: Record<string, unknown>;
    channels: string[];
    left: string[];
    disconnected: boolean;
    listeners: Map<string, ((p: unknown) => void)[]>;
    whispers: [string, unknown][];
    errorHandler: ((e: unknown) => void) | null;
    subscribedHandler: (() => void) | null;
    /** `subscribed()` / `error()` bindings made on the channel: Echo can add them, never remove them. */
    channelBindings: number;
    statusHandlers: ((s: string) => void)[];
    status: string;
}[] = [];

vi.mock('pusher-js', () => ({ default: class FakePusher {} }));
vi.mock('laravel-echo', () => ({
    default: class FakeEcho {
        record: (typeof created)[number];
        connector: {
            onConnectionChange: (cb: (s: string) => void) => () => void;
        };

        constructor(options: Record<string, unknown>) {
            this.record = {
                options,
                channels: [],
                left: [],
                disconnected: false,
                listeners: new Map(),
                whispers: [],
                errorHandler: null,
                subscribedHandler: null,
                channelBindings: 0,
                statusHandlers: [],
                status: 'connecting',
            };
            created.push(this.record);
            this.connector = {
                onConnectionChange: (cb) => {
                    this.record.statusHandlers.push(cb);

                    return () => {
                        this.record.statusHandlers =
                            this.record.statusHandlers.filter((h) => h !== cb);
                    };
                },
            };
        }

        private(name: string) {
            this.record.channels.push(name);
            const record = this.record;
            const channel = {
                listen(event: string, cb: (p: unknown) => void) {
                    record.listeners.set(event, [
                        ...(record.listeners.get(event) ?? []),
                        cb,
                    ]);

                    return channel;
                },
                stopListening(event: string, cb: (p: unknown) => void) {
                    record.listeners.set(
                        event,
                        (record.listeners.get(event) ?? []).filter(
                            (known) => known !== cb,
                        ),
                    );

                    return channel;
                },
                whisper(event: string, payload: unknown) {
                    record.whispers.push([event, payload]);

                    return channel;
                },
                error(cb: (e: unknown) => void) {
                    record.errorHandler = cb;
                    record.channelBindings += 1;

                    return channel;
                },
                subscribed(cb: () => void) {
                    record.subscribedHandler = cb;
                    record.channelBindings += 1;

                    return channel;
                },
            };

            return channel;
        }

        connectionStatus() {
            return this.record.status;
        }

        leave(name: string) {
            this.record.left.push(name);
        }

        disconnect() {
            this.record.disconnected = true;
        }
    },
}));

const { createEchoSocket } = await import('@/lib/realtime/visitor/echo-socket');

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

beforeEach(() => {
    created.length = 0;
});

describe('echo socket', () => {
    it('connects to Reverb with the visitor bearer on the broadcasting auth endpoint', async () => {
        await createEchoSocket(INPUT);

        const { options, channels } = created[0];

        expect(options).toMatchObject({
            broadcaster: 'reverb',
            key: 'reverb-key',
            wsHost: 'ws.chat.test',
            wsPort: 8443,
            wssPort: 8443,
            forceTLS: true,
            authEndpoint: 'https://chat.test/api/v1/public/broadcasting/auth',
            auth: { headers: { Authorization: 'Bearer vt_secret' } },
            enabledTransports: ['ws', 'wss'],
        });
        expect(channels).toEqual(['conversation.01CONV']);
    });

    it('uses plain ws for an http scheme', async () => {
        await createEchoSocket({
            ...INPUT,
            ws: { ...INPUT.ws, scheme: 'http' },
        });

        expect(created[0].options.forceTLS).toBe(false);
    });

    it('passes events through, maps whisper names, and reports status changes', async () => {
        const socket = await createEchoSocket(INPUT);
        const received: unknown[] = [];
        const statuses: string[] = [];

        socket.listen('.message.created', (payload) => received.push(payload));
        created[0].listeners.get('.message.created')?.[0]({ v: 1 });
        expect(received).toEqual([{ v: 1 }]);

        socket.whisper('client-typing', { actor: 'visitor', typing: true });
        expect(created[0].whispers).toEqual([
            ['typing', { actor: 'visitor', typing: true }],
        ]);

        socket.onStatus((s) => statuses.push(s));
        created[0].statusHandlers[0]('connected');
        created[0].statusHandlers[0]('bogus');
        expect(statuses).toEqual(['connected', 'connecting']);
        expect(socket.status()).toBe('connecting');
    });

    it('reports the subscription outcome: success, and the status of a refused subscription', async () => {
        const socket = await createEchoSocket(INPUT);
        const failures: number[] = [];
        let subscribed = 0;

        socket.onSubscribed(() => void subscribed++);
        socket.onSubscriptionError((status) => failures.push(status));

        created[0].subscribedHandler?.();
        created[0].errorHandler?.({ type: 'AuthError', status: 403 });
        created[0].errorHandler?.({ status: 503 });
        created[0].errorHandler?.('nonsense');

        expect(subscribed).toBe(1);
        expect(failures).toEqual([403, 503, 0]);
    });

    it('fans one channel binding out to every subscription callback and lets each one go', async () => {
        const socket = await createEchoSocket(INPUT);
        const first: string[] = [];
        const second: string[] = [];
        const offFirst = socket.onSubscribed(() => first.push('ok'));

        socket.onSubscribed(() => second.push('ok'));
        socket.onSubscriptionError((status) => second.push(String(status)));
        created[0].subscribedHandler?.();
        offFirst();
        created[0].subscribedHandler?.();
        created[0].errorHandler?.({ status: 503 });

        expect(first).toEqual(['ok']);
        expect(second).toEqual(['ok', 'ok', '503']);
        // Echo got exactly one subscribed() and one error() binding however many callbacks came and went
        expect(created[0].channelBindings).toBe(2);
    });

    it('listen and onStatus hand back unbinders that really unbind', async () => {
        const socket = await createEchoSocket(INPUT);
        const seen: unknown[] = [];
        const statuses: string[] = [];
        const offEvent = socket.listen('.message.created', (p) => seen.push(p));
        const offStatus = socket.onStatus((s) => statuses.push(s));

        created[0].listeners.get('.message.created')?.forEach((cb) => cb(1));
        created[0].statusHandlers.forEach((cb) => cb('connected'));
        offEvent();
        offStatus();
        offEvent();
        created[0].listeners.get('.message.created')?.forEach((cb) => cb(2));
        created[0].statusHandlers.forEach((cb) => cb('disconnected'));

        expect(seen).toEqual([1]);
        expect(statuses).toEqual(['connected']);
        expect(created[0].statusHandlers).toEqual([]);
    });

    it('close unbinds everything that is left and disconnects (once), without leaving the channel first (that frame is sent on the closing socket)', async () => {
        const socket = await createEchoSocket(INPUT);
        const calls: string[] = [];

        socket.listen('.message.created', () => calls.push('event'));
        socket.listen('.client-typing', () => calls.push('typing'));
        socket.onStatus(() => calls.push('status'));
        socket.onSubscribed(() => calls.push('subscribed'));
        socket.onSubscriptionError(() => calls.push('error'));

        socket.close();
        socket.close();

        expect(created[0].left).toEqual([]);
        expect(created[0].disconnected).toBe(true);
        expect([...created[0].listeners.values()].flat()).toEqual([]);
        expect(created[0].statusHandlers).toEqual([]);

        created[0].subscribedHandler?.();
        created[0].errorHandler?.({ status: 500 });
        expect(calls).toEqual([]);
    });
});
