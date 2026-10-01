/**
 * Realtime tools for the specs that are about the socket itself, not about what the UI shows:
 *
 *  - `SocketProbe`: a real `pusher-js` client in the Node side of the test, connected to the instance's real Reverb with an arbitrary
 *    channel authoriser (a staff session, a visitor bearer token, nothing). It answers "may THIS caller subscribe to THAT channel?"
 *    the way a browser would find out: the subscription succeeds or the authoriser's refusal comes back as `subscription_error`.
 *  - `SocketGate`: sits in front of a staff browser's websocket (`BrowserContext.routeWebSocket`), so a spec can cut the sockets of
 *    one person mid-session (and let them back) without touching the server or anybody else.
 *
 * Both talk to Reverb exactly as production clients do (Pusher protocol); nothing here reaches into the application.
 */
import Pusher from 'pusher-js';
import type { BrowserContext, WebSocketRoute } from '@playwright/test';
import type { ApiResult } from './api';
import { E2E_REVERB_KEY, type Instance } from './scenarios';

/** What an authoriser answers for `POST .../broadcasting/auth`: the status and the Pusher JSON (`{auth, channel_data?}`). */
export type Authoriser = (
    socketId: string,
    channel: string,
) => Promise<Pick<ApiResult, 'status' | 'body'>>;

export type Subscription = {
    channel: string;
    /** The socket accepted the subscription. */
    subscribed: boolean;
    /** The authoriser's HTTP status (`null` when it was never asked). */
    authStatus: number | null;
};

type PusherRuntime = {
    Runtime: {
        getWebSocketAPI(): new (
            url: string,
            protocols: string[],
            options: { headers: Record<string, string> },
        ) => unknown;
        createWebSocket?: (url: string) => unknown;
    };
};

let origin = '';

/**
 * pusher-js in Node opens its websocket without an `Origin` header, which Reverb refuses (a browser always sends one): every
 * connection of this process presents the origin of the instance under test.
 */
function installOrigin(): void {
    const runtime = (Pusher as unknown as PusherRuntime).Runtime;
    const Client = runtime.getWebSocketAPI();

    runtime.createWebSocket = (url: string) =>
        new Client(url, [], { headers: { Origin: origin } });
}

export class SocketProbe {
    private readonly received = new Map<
        string,
        { event: string; data: unknown }[]
    >();

    private constructor(
        private readonly pusher: Pusher,
        /** channel -> the authoriser's HTTP status, filled while the socket asks. */
        private readonly asked: Map<string, number>,
    ) {}

    /** Connects to the instance's Reverb; `authorise` is called for every private / presence channel. Rejects when it cannot connect. */
    static async connect(
        instance: Instance,
        authorise: Authoriser,
    ): Promise<SocketProbe> {
        if (instance.reverb === null) {
            throw new Error(`Scenario ${instance.key} has no Reverb server.`);
        }

        origin = instance.url;
        installOrigin();

        const asked = new Map<string, number>();
        const pusher = new Pusher(E2E_REVERB_KEY, {
            cluster: 'mt1',
            wsHost: '127.0.0.1',
            wsPort: instance.reverb.port,
            forceTLS: false,
            enabledTransports: ['ws'],
            disableStats: true,
            channelAuthorization: {
                transport: 'ajax',
                endpoint: `${instance.url}/broadcasting/auth`,
                customHandler: ({ socketId, channelName }, callback) => {
                    authorise(socketId, channelName).then(
                        (answer) => {
                            asked.set(channelName, answer.status);

                            if (answer.status !== 200) {
                                callback(
                                    new Error(`auth ${answer.status}`),
                                    null,
                                );

                                return;
                            }

                            callback(null, answer.body);
                        },
                        (error: unknown) =>
                            callback(
                                error instanceof Error
                                    ? error
                                    : new Error(String(error)),
                                null,
                            ),
                    );
                },
            },
        });
        const probe = new SocketProbe(pusher, asked);

        await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(
                () =>
                    reject(new Error('The probe could not connect to Reverb.')),
                10_000,
            );

            pusher.connection.bind('connected', () => {
                clearTimeout(timer);
                resolve();
            });
            pusher.connection.bind('error', (error: unknown) => {
                clearTimeout(timer);
                reject(
                    new Error(
                        `Reverb connection error ${JSON.stringify(error)}`,
                    ),
                );
            });
        });

        return probe;
    }

    /** Subscribes and says how it went (accepted, or refused by the authoriser / by Reverb). */
    async subscribe(channel: string): Promise<Subscription> {
        const subscribed = await new Promise<boolean>((resolve) => {
            const handle = this.pusher.subscribe(channel);
            const timer = setTimeout(() => resolve(false), 8_000);

            handle.bind_global((event: string, data: unknown) => {
                if (!event.startsWith('pusher')) {
                    const list = this.received.get(channel) ?? [];

                    list.push({ event, data });
                    this.received.set(channel, list);
                }
            });
            handle.bind('pusher:subscription_succeeded', () => {
                clearTimeout(timer);
                resolve(true);
            });
            handle.bind('pusher:subscription_error', () => {
                clearTimeout(timer);
                resolve(false);
            });
        });

        return {
            channel,
            subscribed,
            authStatus: this.asked.get(channel) ?? null,
        };
    }

    /** The application events (not `pusher:*`) this probe received on a channel so far. */
    events(channel: string): { event: string; data: unknown }[] {
        return this.received.get(channel) ?? [];
    }

    close(): void {
        this.pusher.disconnect();
    }
}

/**
 * A pass-through in front of the browser's Reverb websocket that can be switched off: while `blocked` every socket the page opens
 * is closed at once (the server never sees it), and `drop()` cuts the ones that are already open. Install it BEFORE the page loads
 * (Playwright only routes sockets created after `routeWebSocket`).
 */
export class SocketGate {
    private blockedNow = false;
    private readonly open = new Set<{
        page: WebSocketRoute;
        server: WebSocketRoute;
    }>();
    /** How many sockets the page has tried to open since the gate was installed. */
    attempts = 0;

    private constructor() {}

    static async install(
        context: BrowserContext,
        instance: Instance,
    ): Promise<SocketGate> {
        if (instance.reverb === null) {
            throw new Error(`Scenario ${instance.key} has no Reverb server.`);
        }

        const gate = new SocketGate();
        // The staff dashboard connects to `ws://127.0.0.1:<reverb port>/app/<key>`.
        const pattern = new RegExp(`:${instance.reverb.port}/app/`);

        await context.routeWebSocket(pattern, (route) => {
            gate.attempts += 1;

            if (gate.blockedNow) {
                void route.close({ code: 1006, reason: 'blocked by the test' });

                return;
            }

            const server = route.connectToServer();
            const pair = { page: route, server };

            gate.open.add(pair);
            route.onClose(() => gate.open.delete(pair));
            server.onClose(() => gate.open.delete(pair));
        });

        return gate;
    }

    get blocked(): boolean {
        return this.blockedNow;
    }

    /** Cuts every open socket and refuses the next ones: the page is offline as far as Reverb is concerned. */
    async block(): Promise<void> {
        this.blockedNow = true;

        for (const pair of this.open) {
            this.open.delete(pair);
            await pair.server.close({ code: 1006 }).catch(() => undefined);
            await pair.page
                .close({ code: 1006, reason: 'cut by the test' })
                .catch(() => undefined);
        }
    }

    /** Lets the page's next (re)connection through. */
    allow(): void {
        this.blockedNow = false;
    }
}
