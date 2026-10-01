import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';

const created: {
    options: Record<string, unknown>;
    channels: string[];
    left: string[];
    disconnected: boolean;
    listeners: Map<string, ((p: unknown) => void)[]>;
    whispers: [string, unknown][];
    errorHandler: ((e: unknown) => void) | null;
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
                statusHandlers: [],
                status: 'connecting',
            };
            created.push(this.record);
            this.connector = {
                onConnectionChange: (cb) => {
                    this.record.statusHandlers.push(cb);

                    return () => undefined;
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
                whisper(event: string, payload: unknown) {
                    record.whispers.push([event, payload]);

                    return channel;
                },
                error(cb: (e: unknown) => void) {
                    record.errorHandler = cb;

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

    it('reports a 401 / 403 subscription error as an auth failure, and ignores others', async () => {
        const socket = await createEchoSocket(INPUT);
        const failures: number[] = [];

        socket.onAuthError((status) => failures.push(status));
        created[0].errorHandler?.({ type: 'AuthError', status: 403 });
        created[0].errorHandler?.({ status: 500 });
        created[0].errorHandler?.('nonsense');
        expect(failures).toEqual([403]);
    });

    it('close leaves the channel and disconnects', async () => {
        const socket = await createEchoSocket(INPUT);

        socket.close();
        expect(created[0].left).toEqual(['conversation.01CONV']);
        expect(created[0].disconnected).toBe(true);
    });
});
