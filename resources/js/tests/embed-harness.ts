/**
 * Test harness for the embed panel: a controller wired to a recording host, a scriptable fake socket and the MSW-backed fake API.
 *
 *   const h = createHarness({ backend });
 *   await h.init();            // the loader's `init` (boot config rebuilt the way the loader does it)
 *   h.open();                  // host `open`
 *   ...
 *   h.socket()?.emit('message.created', {...})
 */
import { afterEach } from 'vite-plus/test';
import {
    ChatController,
    type ControllerDeps,
    type StoredSession,
} from '@/embed/session/controller';
import type {
    InitPayload,
    PanelMessage,
    StatePayload,
} from '@/embed/protocol/messages';
import type { Messages } from '@/embed/i18n';
import {
    API,
    bootConfig,
    createVisitorBackend,
    type VisitorBackend,
} from '@/tests/msw/chat-visitor';
import type {
    ConversationSocket,
    SocketFactory,
    SocketInput,
    SocketStatus,
} from '@/lib/realtime/visitor/types';

type Handler = (payload: unknown) => void;

/**
 * Echo's `EventFormatter`: a leading dot keeps the name as it is on the wire, anything else gets the `App\Events\` namespace.
 * The fake applies it too, so a listener registered without the dot (the whisper `client-typing`) never hears the wire name.
 */
export function echoWireName(event: string): string {
    return /^[.\\]/.test(event)
        ? event.slice(1)
        : `App\\Events\\${event.replace(/\./g, '\\')}`;
}

export class FakeSocket implements ConversationSocket {
    /** Listeners by wire name. */
    handlers = new Map<string, Handler[]>();
    statusHandlers: ((status: SocketStatus) => void)[] = [];
    subscribedHandlers: (() => void)[] = [];
    /** The channel subscription failed with this HTTP status (401 / 403: session gone; 503: Reverb not configured). */
    errorHandlers: ((status: number) => void)[] = [];
    /** Do not confirm the channel subscription after `connected` (tests of a refused subscription). */
    holdSubscription = false;
    whispers: { event: string; payload: Record<string, unknown> }[] = [];
    current: SocketStatus = 'connecting';
    closed = false;

    constructor(readonly input: SocketInput) {}

    /** What is still bound: listeners, status, subscription and error callbacks (zero once the socket is closed properly). */
    get bindings(): number {
        let listeners = 0;

        for (const list of this.handlers.values()) {
            listeners += list.length;
        }

        return (
            listeners +
            this.statusHandlers.length +
            this.subscribedHandlers.length +
            this.errorHandlers.length
        );
    }

    /** Number of listeners on a wire name (`message.created`, `client-typing`, `typing`...). */
    listenersOn(wire: string): number {
        return this.handlers.get(wire)?.length ?? 0;
    }

    listen(event: string, handler: Handler): () => void {
        const wire = echoWireName(event);

        this.handlers.set(wire, [...(this.handlers.get(wire) ?? []), handler]);

        return () => {
            this.handlers.set(
                wire,
                (this.handlers.get(wire) ?? []).filter((h) => h !== handler),
            );
        };
    }

    whisper(event: string, payload: Record<string, unknown>): void {
        this.whispers.push({ event, payload });
    }

    onStatus(handler: (status: SocketStatus) => void): () => void {
        this.statusHandlers.push(handler);

        return () => {
            this.statusHandlers = this.statusHandlers.filter(
                (h) => h !== handler,
            );
        };
    }

    status(): SocketStatus {
        return this.current;
    }

    onSubscribed(handler: () => void): () => void {
        this.subscribedHandlers.push(handler);

        // The fake connects before the manager has bound its handlers: confirm what it missed.
        if (this.current === 'connected' && !this.holdSubscription) {
            queueMicrotask(() => {
                if (this.subscribedHandlers.includes(handler)) {
                    handler();
                }
            });
        }

        return () => {
            this.subscribedHandlers = this.subscribedHandlers.filter(
                (h) => h !== handler,
            );
        };
    }

    onSubscriptionError(handler: (status: number) => void): () => void {
        this.errorHandlers.push(handler);

        return () => {
            this.errorHandlers = this.errorHandlers.filter(
                (h) => h !== handler,
            );
        };
    }

    /** Close like the real socket: unbind everything, leave the channel, disconnect. */
    close(): void {
        this.closed = true;
        this.handlers.clear();
        this.statusHandlers = [];
        this.subscribedHandlers = [];
        this.errorHandlers = [];
    }

    /** Deliver a server event, named as on the wire (`message.created`, `chat.claimed`, `client-typing`, `typing`...). */
    emit(event: string, payload: unknown): void {
        for (const handler of this.handlers.get(event) ?? []) {
            handler(payload);
        }
    }

    /** The channel auth endpoint refused (or failed) the subscription. */
    failSubscription(status: number): void {
        for (const handler of this.errorHandlers) {
            handler(status);
        }
    }

    setStatus(status: SocketStatus): void {
        this.current = status;

        for (const handler of this.statusHandlers) {
            handler(status);
        }

        // A real connection subscribes to the channel right after it is up (and again after every reconnect).
        if (status === 'connected' && !this.holdSubscription) {
            this.confirmSubscription();
        }
    }

    /** The channel subscription succeeded (after `holdSubscription`). */
    confirmSubscription(): void {
        for (const handler of this.subscribedHandlers) {
            handler();
        }
    }
}

/** The boot config as the loader hands it to the panel: categories reduced to `{slug, label}`. */
export function loaderBoot(
    overrides: Record<string, unknown> = {},
): Record<string, unknown> {
    const full = bootConfig(overrides);

    return {
        ...full,
        categories: (full.categories as { slug: string; label: string }[]).map(
            (c) => ({
                slug: c.slug,
                label: c.label,
            }),
        ),
    };
}

export function makeInit(
    options: Partial<InitPayload> & { boot?: Record<string, unknown> } = {},
): InitPayload {
    return {
        boot: options.boot ?? loaderBoot(),
        ...(options.visitorSession === undefined
            ? {}
            : { visitorSession: options.visitorSession }),
        ...(options.identityToken === undefined
            ? {}
            : { identityToken: options.identityToken }),
        ...(options.visitor === undefined ? {} : { visitor: options.visitor }),
        page: options.page ?? {
            url: 'https://shop.example/pricing',
            title: 'Pricing',
            referrer: '',
        },
        overrides: options.overrides ?? {},
        embedMode: 'launcher',
        viewport: options.viewport ?? {
            width: 1280,
            height: 800,
            keyboardInset: 0,
        },
    };
}

export type HarnessOptions = {
    backend?: VisitorBackend;
    deps?: Partial<ControllerDeps>;
    /** Built-in messages for non-English locales (default: none). */
    builtin?: (locale: string) => Promise<Messages>;
    pollMs?: number;
};

const created: ChatController[] = [];

// A controller from an earlier test would keep polling (and answering receipts) against the next test's fake backend.
afterEach(() => {
    for (const controller of created.splice(0)) {
        controller.dispose();
    }
});

export function createHarness(options: HarnessOptions = {}) {
    const backend = options.backend ?? createVisitorBackend();
    const sent: PanelMessage[] = [];
    const sessions: (StoredSession | null)[] = [];
    const sockets: FakeSocket[] = [];
    const pings: number[] = [];
    const factory: SocketFactory = async (input) => {
        const socket = new FakeSocket(input);

        sockets.push(socket);
        queueMicrotask(() => socket.setStatus('connected'));

        return socket;
    };
    const controller = new ChatController({
        host: { send: (message) => void sent.push(message) },
        persistSession: (session) => void sessions.push(session),
        socketFactory: factory,
        sound: { ping: () => void pings.push(Date.now()) },
        navigatorLanguages: ['en-US'],
        loadBuiltin: options.builtin ?? (async () => ({})),
        pollMs: options.pollMs ?? 20,
        configTimeoutMs: 500,
        ...options.deps,
    });

    created.push(controller);

    return {
        controller,
        backend,
        sent,
        sessions,
        sockets,
        pings,
        api: API,
        socket: (): FakeSocket | null => sockets.at(-1) ?? null,
        state: () => controller.getState(),
        snapshot: () => controller.getSnapshot(),
        init: (init: InitPayload = makeInit()) => controller.handleInit(init),
        open: () => controller.handleHostMessage({ type: 'open' }),
        close: () => controller.handleHostMessage({ type: 'close' }),
        hostStates: (): StatePayload[] =>
            sent.flatMap((m) => (m.type === 'state' ? [m.payload] : [])),
        events: (): string[] =>
            sent.flatMap((m) => (m.type === 'event' ? [m.payload.name] : [])),
    };
}

export type Harness = ReturnType<typeof createHarness>;

/** Let microtasks, resolved fetches and a few timer ticks settle. */
export async function settle(ms = 30): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Waits (polling) until `predicate` is true or fails after `timeout` ms. */
export async function until(
    predicate: () => boolean,
    timeout = 2000,
): Promise<void> {
    const start = Date.now();

    while (!predicate()) {
        if (Date.now() - start > timeout) {
            throw new Error('Timed out waiting for the condition.');
        }

        await new Promise((resolve) => setTimeout(resolve, 5));
    }
}
