/**
 * The panel's non-React brain. It owns the reducer state (`state/machine.ts`), the visitor session, the API client and the realtime
 * connection, performs every side effect, and feeds the outcomes back to the reducer as actions. React only reads
 * `getSnapshot()` (via `useSyncExternalStore`) and calls the public methods.
 *
 * Responsibilities, in the order a visit goes:
 *  1. boot: `init` from the host (or a self-booted equivalent) -> panel config, fresh categories/availability, resume of a stored
 *     session (`GET /public/conversation` + messages), first screen;
 *  2. start: pre-chat -> category -> `POST /public/conversations` (a session is created lazily, right before the first write);
 *  3. queued: realtime opens NOW (never earlier), a watchdog polls the conversation so a missed queue is noticed;
 *  4. active: optimistic sends in order, receipts, typing, attachments, gap sync, REST polling while the socket is down;
 *  5. end: rating / thank-you / "start a new chat" (clears the session: a new chat is a new ticket).
 *
 * Every transition is mirrored to the host as a `state` message; message and lifecycle events go out as `event` messages.
 */
import {
    buildPanelConfig,
    type PanelConfig,
} from '@/embed/config/panel-config';
import {
    createTranslate,
    loadBuiltin as loadBuiltinMessages,
    type Messages,
    type Translate,
} from '@/embed/i18n';
import { newUlid } from '@/embed/lib/ulid';
import { previewAvailability } from '@/embed/preview/availability';
import type {
    Dict,
    HostMessage,
    InitPayload,
    PanelEventName,
    PanelMessage,
    ViewportPayload,
} from '@/embed/protocol/messages';
import { toCreateFailure, toNotice } from '@/embed/session/errors';
import { deriveFlow } from '@/embed/session/flow';
import {
    createInitialState,
    isLiveChat,
    reduce,
    selectUnreadPreview,
    toHostState,
    type Action,
    type FormValues,
    type MachineState,
} from '@/embed/state/machine';
import {
    createVisitorApi,
    isVisitorApiError,
    type CreateConversationRequest,
    type CreateSessionRequest,
    type SessionResponse,
    type VisitorApi,
    type VisitorFields,
    type WsConfig,
} from '@/lib/chat-api/visitor';
import {
    createPendingMessage,
    findGap,
    highestSeq,
    highestSeqFrom,
} from '@/lib/chat/messages';
import type {
    AttachmentData,
    ConversationPublic,
    LocalMessage,
    MessageData,
} from '@/lib/chat/types';
import { createTypingTracker } from '@/lib/chat/typing';
import {
    openConversationRealtime,
    type ConversationRealtime,
    type RealtimeHandlers,
} from '@/lib/realtime/visitor/connection';
import type { SocketFactory } from '@/lib/realtime/visitor/types';

export type HostPort = { send(message: PanelMessage): void };

export type StoredSession = { token: string; expiresAt: string };

export type ControllerDeps = {
    host: HostPort;
    /** Called when the visitor session changes: the launcher mode forwards it to the host, standalone pages store it. */
    persistSession: (session: StoredSession | null) => void;
    socketFactory: SocketFactory;
    createApi?: (options: {
        base: string;
        widgetKey: string;
        token: () => string | null;
    }) => VisitorApi;
    openRealtime?: typeof openConversationRealtime;
    now?: () => number;
    newId?: () => string;
    sound?: { ping(): void };
    navigatorLanguages?: readonly string[];
    document?: Document;
    /** The builder preview: no visitor API calls, ever (the injected demo API answers instead). */
    preview?: boolean;
    loadBuiltin?: (locale: string) => Promise<Messages>;
    /** The boot object handed to `handleInit` is itself the fresh public config (a standalone page just fetched it). */
    bootIsFresh?: boolean;
    /** How long boot waits for the fresh public config before rendering from the host's copy (ms, default 2500). */
    configTimeoutMs?: number;
    /** Watchdog / polling interval in milliseconds (default 10 000). */
    pollMs?: number;
};

export type Snapshot = {
    state: MachineState;
    config: PanelConfig | null;
    t: Translate;
    viewport: ViewportPayload | null;
    /** The config could not be loaded at all (standalone page, widget gone). */
    unavailable: boolean;
};

const WATCHDOG_MS = 10_000;
const ATTACHMENT_LIMIT = 4;

export const MAX_ATTACHMENTS = ATTACHMENT_LIMIT;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), ms);

        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(null);
            },
        );
    });
}

const isRecord = (value: unknown): value is Dict =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

/** `name`, `email`, `phone` claims of an identity JWT, read WITHOUT verifying (prefill only; the server verifies). */
export function claimsOf(token: string | undefined): VisitorFields {
    if (token === undefined) {
        return {};
    }

    try {
        const payload = token.split('.')[1] ?? '';
        const json = JSON.parse(
            atob(payload.replace(/-/g, '+').replace(/_/g, '/')),
        ) as unknown;

        if (!isRecord(json)) {
            return {};
        }

        const out: VisitorFields = {};

        for (const key of ['name', 'email', 'phone'] as const) {
            if (typeof json[key] === 'string') {
                out[key] = json[key];
            }
        }

        return out;
    } catch {
        return {};
    }
}

export class ChatController {
    private state: MachineState;
    private snapshot: Snapshot;
    private readonly listeners = new Set<() => void>();

    private boot: Dict | null = null;
    private overrides: Dict = {};
    private fresh: Dict | null = null;
    private draft: Dict | null = null;
    private config: PanelConfig | null = null;
    private builtin: Messages = {};
    private builtinLocale: string | null = null;
    private t: Translate = createTranslate({
        texts: {},
        textLocale: 'en',
        defaultLocale: 'en',
    });
    private viewport: ViewportPayload | null = null;
    private unavailable = false;
    private booted = false;
    private disposed = false;

    private identityToken: string | undefined;
    private hostVisitor: VisitorFields = {};
    private page = { url: '', title: '', referrer: '' };

    private api: VisitorApi | null = null;
    private token: string | null = null;
    private ws: WsConfig | null = null;
    /** The server answered the question "where is Reverb?" (a `ws` block or an explicit `null`); a failed answer is retried. */
    private wsKnown = false;
    private sessionPromise: Promise<void> | null = null;
    private rotation: Promise<void> | null = null;
    private rotatedAt = 0;

    private realtime: ConversationRealtime | null = null;
    private realtimeFor: string | null = null;
    /** Bumped whenever the connection is closed or replaced, so an open that finishes late knows it is stale. */
    private realtimeGeneration = 0;
    private realtimeRetries = 0;
    private realtimeRetryTimer: ReturnType<typeof setTimeout> | undefined;
    private watchdog: ReturnType<typeof setInterval> | undefined;
    private syncing: Promise<void> | null = null;
    private syncAgain = false;
    private sendChain: Promise<void> = Promise.resolve();
    private readonly typing = createTypingTracker(() => this.now());
    private typingTimer: ReturnType<typeof setTimeout> | undefined;
    private viewing = false;
    private receipts = {
        delivered: 0,
        seen: 0,
        sentDelivered: 0,
        sentSeen: 0,
        timer: undefined as ReturnType<typeof setTimeout> | undefined,
    };
    private lastHostState = '';
    private lastUnread = 0;
    private lastAvailabilityAt = 0;

    constructor(private readonly deps: ControllerDeps) {
        this.state = createInitialState(false);
        this.snapshot = this.makeSnapshot();
    }

    /* ------------------------------------------------------------ store */

    subscribe = (listener: () => void): (() => void) => {
        this.listeners.add(listener);

        return () => {
            this.listeners.delete(listener);
        };
    };

    getSnapshot = (): Snapshot => this.snapshot;

    getState(): MachineState {
        return this.state;
    }

    private now(): number {
        return this.deps.now?.() ?? Date.now();
    }

    private makeSnapshot(): Snapshot {
        return {
            state: this.state,
            config: this.config,
            t: this.t,
            viewport: this.viewport,
            unavailable: this.unavailable,
        };
    }

    private publish(): void {
        this.snapshot = this.makeSnapshot();

        for (const listener of this.listeners) {
            listener();
        }
    }

    private dispatch(action: Action): void {
        const previous = this.state;
        const next = reduce(previous, action);

        if (next === previous) {
            return;
        }

        this.state = next;
        this.afterChange(previous, next, action);
        this.publish();
    }

    /* ----------------------------------------------------- host output */

    private emit(name: PanelEventName, data: Dict = {}): void {
        this.deps.host.send({ type: 'event', payload: { name, data } });
    }

    private mirrorToHost(next: MachineState): void {
        const host = toHostState(next);

        if (host === null) {
            return;
        }

        if (host.unread > this.lastUnread) {
            const preview = selectUnreadPreview(next);
            const agent = [...next.messages]
                .reverse()
                .find((m) => m.sender.type === 'agent')?.sender.name;

            this.deps.host.send({
                type: 'unread',
                payload: {
                    count: host.unread,
                    ...(preview === null
                        ? {}
                        : { preview: preview.slice(0, 120) }),
                    ...(agent ? { agent: { name: agent } } : {}),
                },
            });
        }

        this.lastUnread = host.unread;

        const key = JSON.stringify(host);

        if (key !== this.lastHostState) {
            this.lastHostState = key;
            this.deps.host.send({ type: 'state', payload: host });
        }
    }

    /** Side effects that follow a state change: host mirroring, realtime lifecycle, lifecycle events. */
    private afterChange(
        previous: MachineState,
        next: MachineState,
        action: Action,
    ): void {
        this.mirrorToHost(next);

        const wasLive = isLiveChat(previous);
        const isLive = isLiveChat(next);

        if (isLive && next.conversation !== null) {
            if (this.realtimeFor !== next.conversation.ulid) {
                void this.connectRealtime(next.conversation);
            }
        } else if (wasLive && !isLive) {
            this.closeRealtime();
        }

        if (next.phase === 'queued' && this.watchdog === undefined) {
            this.watchdog = setInterval(
                () => void this.syncConversation(),
                this.deps.pollMs ?? WATCHDOG_MS,
            );
        } else if (next.phase !== 'queued' && this.watchdog !== undefined) {
            clearInterval(this.watchdog);
            this.watchdog = undefined;
        }

        if (previous.phase !== next.phase) {
            if (!isLive) {
                this.typing.reset();
            }

            if (next.phase === 'closed' || next.phase === 'ended') {
                const conversation = previous.conversation;

                if (conversation !== null && wasLive) {
                    this.emit('chat-ended', {
                        conversationId: conversation.ulid,
                        reason:
                            next.phase === 'ended'
                                ? 'ended'
                                : (next.closedReason ?? 'closed'),
                    });
                }
            }
        }

        if (action.type === 'CREATE_OK') {
            this.emit('chat-started', {
                conversationId: action.conversation.ulid,
                category: action.conversation.category?.slug,
            });
        }

        if (action.type === 'CLAIMED') {
            this.emit('agent-joined', { agentName: action.agent.name });
        }
    }

    /* ------------------------------------------------------------- boot */

    /** Handles every host message (the channel has already checked source, origin and shape). */
    handleHostMessage(message: HostMessage): void {
        switch (message.type) {
            case 'init':
                void this.handleInit(message.payload);
                break;
            case 'open':
                this.setOpen(true);
                break;
            case 'close':
                this.setOpen(false);
                break;
            case 'shutdown':
                this.shutdown();
                break;
            case 'update':
                this.overrides = message.payload.overrides;
                this.reconfigure();
                break;
            case 'identify':
                this.identify(message.payload.token, message.payload.visitor);
                break;
            case 'setCategory':
                this.presetCategory(message.payload.slug);
                break;
            case 'startChat':
                this.startFromHost(message.payload);
                break;
            case 'viewport':
                this.setViewport(message.payload);
                break;
            case 'draft':
                this.draft = message.payload.config;
                this.reconfigure();
                break;
        }
    }

    async handleInit(init: InitPayload): Promise<void> {
        this.setViewport(init.viewport);

        if (this.booted) {
            return;
        }

        this.booted = true;
        this.boot = init.boot;
        this.overrides = init.overrides;
        this.identityToken = init.identityToken;
        this.hostVisitor = init.visitor ?? {};
        this.page = init.page;
        this.rebuildConfig();

        const config = this.config;

        if (config === null || config.key === '' || config.apiBase === '') {
            this.unavailable = true;
            this.publish();

            return;
        }

        this.api = (this.deps.createApi ?? createVisitorApi)({
            base: config.apiBase,
            widgetKey: config.key,
            token: () => this.token,
        });

        const preview = this.deps.preview === true;

        await Promise.all([
            this.ensureBuiltin(),
            preview || this.deps.bootIsFresh === true
                ? Promise.resolve()
                : this.loadFresh(),
        ]);

        if (this.disposed) {
            return;
        }

        this.rebuildConfig();
        this.prefill();
        this.recomputeFlow();

        let conversation: ConversationPublic | null = null;
        let messages: MessageData[] = [];

        if (!preview && init.visitorSession !== undefined) {
            this.token = init.visitorSession.token;

            try {
                conversation = await this.api.getConversation();

                if (
                    conversation !== null &&
                    (conversation.status === 'queued' ||
                        conversation.status === 'active')
                ) {
                    // A chat that is still live needs the websocket, and the server hands that out only with a (rotated) session:
                    // do it now, before anything else is fetched, so no request is in flight with the token that is about to die.
                    await this.rotateSession();

                    if (this.token === null) {
                        conversation = null;
                    }
                }

                if (
                    conversation !== null &&
                    (conversation.status === 'queued' ||
                        conversation.status === 'active' ||
                        conversation.status === 'ended')
                ) {
                    messages = await this.fetchMessagesAfter(
                        conversation.ulid,
                        0,
                    );
                }
            } catch (error) {
                conversation = null;

                if (isVisitorApiError(error) && error.isSessionGone) {
                    this.clearSession();
                }
            }
        }

        if (this.disposed) {
            return;
        }

        this.dispatch({
            type: 'BOOTED',
            conversation,
            messages,
            now: this.resumedQueueStart(conversation),
        });
        this.afterResume();
    }

    /** Queue time of a resumed chat: when the server created it, never in the future (clock skew). */
    private resumedQueueStart(conversation: ConversationPublic | null): number {
        const now = this.now();
        const created =
            conversation === null ? NaN : Date.parse(conversation.createdAt);

        return Number.isNaN(created) ? now : Math.min(now, created);
    }

    private afterResume(): void {
        // Resumed `active` chat with messages the visitor has not seen: delivered at least.
        this.markDelivered();
    }

    private async loadFresh(): Promise<void> {
        const config = this.config;

        if (config === null || this.api === null) {
            return;
        }

        const fresh = await withTimeout(
            this.api.getConfig(config.locale),
            this.deps.configTimeoutMs ?? 2500,
        );

        if (fresh !== null) {
            this.fresh = fresh;
            this.lastAvailabilityAt = this.now();
        }
    }

    private async ensureBuiltin(): Promise<void> {
        const locale = this.config?.textLocale ?? 'en';

        if (locale === this.builtinLocale) {
            return;
        }

        const builtin = await (this.deps.loadBuiltin ?? loadBuiltinMessages)(
            locale,
        );

        this.builtin = builtin;
        this.builtinLocale = locale;
    }

    private rebuildConfig(): void {
        if (this.boot === null) {
            return;
        }

        this.config = buildPanelConfig({
            boot: this.boot,
            overrides: this.overrides,
            fresh:
                this.deps.preview === true
                    ? {
                          availability: previewAvailability(
                              isRecord(this.boot.config)
                                  ? this.boot.config
                                  : null,
                              this.draft,
                          ),
                      }
                    : this.fresh,
            draft: this.draft,
            navigatorLanguages:
                this.deps.navigatorLanguages ??
                (typeof navigator === 'undefined'
                    ? []
                    : navigator.languages?.length > 0
                      ? navigator.languages
                      : [navigator.language]),
        });
        this.t = createTranslate({
            texts: this.config.texts,
            textLocale: this.config.textLocale,
            defaultLocale: this.config.defaultLocale,
            builtin:
                this.builtinLocale === this.config.textLocale
                    ? this.builtin
                    : {},
        });
        this.publish();
    }

    /** Overrides, a builder draft or fresh availability changed: rebuild everything derived from the config. */
    private reconfigure(): void {
        if (this.boot === null) {
            return;
        }

        this.rebuildConfig();
        this.recomputeFlow();
        void this.ensureBuiltin().then(() => {
            if (!this.disposed) {
                this.rebuildConfig();
            }
        });
    }

    private recomputeFlow(): void {
        if (this.config === null) {
            return;
        }

        this.dispatch({
            type: 'CONFIGURED',
            flow: deriveFlow(this.config, {
                identified: this.identityToken !== undefined,
                form: this.state.form,
            }),
        });
    }

    private prefill(): void {
        const claims = claimsOf(this.identityToken);

        this.dispatch({
            type: 'PREFILL',
            values: {
                name: this.hostVisitor.name ?? claims.name,
                email: this.hostVisitor.email ?? claims.email,
                phone: this.hostVisitor.phone ?? claims.phone,
            },
        });
    }

    private identify(
        token: string | undefined,
        visitor: VisitorFields | undefined,
    ): void {
        if (token !== undefined) {
            this.identityToken = token;
        }

        if (visitor !== undefined) {
            this.hostVisitor = { ...this.hostVisitor, ...visitor };
        }

        this.prefill();
        this.recomputeFlow();
    }

    private setViewport(viewport: ViewportPayload): void {
        const current = this.viewport;

        if (
            current !== null &&
            current.width === viewport.width &&
            current.height === viewport.height &&
            current.keyboardInset === viewport.keyboardInset
        ) {
            return;
        }

        this.viewport = viewport;
        this.publish();
    }

    private setOpen(open: boolean): void {
        this.dispatch({ type: open ? 'HOST_OPEN' : 'HOST_CLOSE' });

        if (open) {
            void this.refreshAvailability();
        } else {
            this.viewing = false;
        }
    }

    /** Re-reads availability when the panel opens (the boot copy can be a minute old), at most every 15 s. */
    private async refreshAvailability(): Promise<void> {
        const phase = this.state.phase;

        if (
            this.deps.preview === true ||
            this.api === null ||
            this.now() - this.lastAvailabilityAt < 15_000 ||
            !['idle', 'prechat', 'category', 'offline', 'closed'].includes(
                phase,
            )
        ) {
            return;
        }

        this.lastAvailabilityAt = this.now();

        try {
            const availability = await this.api.getAvailability();

            this.fresh = { ...this.fresh, availability };
            this.rebuildConfig();
            this.recomputeFlow();
        } catch {
            // keep what we have: the server decides when the chat is started
        }
    }

    private shutdown(): void {
        this.closeRealtime();
        this.clearSession(false);
        this.dispatch({ type: 'RESET' });
    }

    dispose(): void {
        this.disposed = true;
        this.closeRealtime();
        clearInterval(this.watchdog);
        clearTimeout(this.typingTimer);
        clearTimeout(this.receipts.timer);
        this.listeners.clear();
    }

    /* ---------------------------------------------------------- session */

    private sessionBody(): CreateSessionRequest {
        return {
            ...(this.identityToken === undefined
                ? {}
                : { identity_token: this.identityToken }),
            ...(Object.keys(this.hostVisitor).length === 0
                ? {}
                : { visitor: this.hostVisitor }),
            page: this.page,
            locale: this.config?.locale ?? 'en',
        };
    }

    /** Creates a visitor session when there is none. Single-flight. */
    private ensureSession(): Promise<void> {
        if (this.token !== null) {
            return Promise.resolve();
        }

        this.sessionPromise ??= (async () => {
            try {
                const api = this.requireApi();

                this.adopt(await api.createSession(this.sessionBody()));
            } finally {
                this.sessionPromise = null;
            }
        })();

        return this.sessionPromise;
    }

    /** Takes over a session the server just issued: the token (persisted for the next page), where Reverb lives. */
    private adopt(session: SessionResponse): void {
        this.token = session.visitorToken;
        this.ws = session.ws;
        this.wsKnown = true;
        this.persist({
            token: session.visitorToken,
            expiresAt: session.expiresAt,
        });
    }

    /**
     * A returning token sent to `POST .../sessions` is ROTATED by the server: the response carries a new token, the old one is
     * revoked and a still-open chat moves over to the new session. So the new token is adopted (and persisted for the next
     * page) and nothing else may use the old one afterwards. A failure that is not "the session is gone" (identity refused,
     * rate limit, network) keeps the token we hold: the chat carries on over REST and the websocket is tried again later.
     */
    private rotateSession(): Promise<void> {
        this.rotation ??= (async () => {
            try {
                const held = this.token;

                if (held === null) {
                    return;
                }

                const session = await this.requireApi().createSession(
                    this.sessionBody(),
                    held,
                );

                this.adopt(session);
                this.rotatedAt = this.now();

                const current = this.state.conversation;

                if (
                    current !== null &&
                    session.conversation?.ulid !== current.ulid
                ) {
                    void this.syncConversation();
                }
            } catch (error) {
                if (isVisitorApiError(error)) {
                    if (error.isSessionGone) {
                        this.handleSessionGone(false);
                    } else if (
                        error.status >= 400 &&
                        error.status < 500 &&
                        error.status !== 408 &&
                        error.status !== 429
                    ) {
                        // A refusal (a signed identity that does not verify, a widget that is gone) will be the same next time:
                        // no websocket, no retries, the chat runs on REST.
                        this.ws = null;
                        this.wsKnown = true;
                    }
                }
            } finally {
                this.rotation = null;
            }
        })();

        return this.rotation;
    }

    /**
     * Where Reverb lives for visitors (`null`: not configured, REST polling only). A restored token never saw a session response,
     * so the answer comes from rotating it; `wsKnown` stays false while that failed for a reason worth retrying.
     */
    private async ensureWs(): Promise<WsConfig | null> {
        if (!this.wsKnown) {
            if (this.token === null) {
                await this.ensureSession().catch(() => undefined);
            } else {
                await this.rotateSession();
            }
        }

        return this.ws;
    }

    private requireApi(): VisitorApi {
        if (this.api === null) {
            throw new Error('The panel has not been initialised.');
        }

        return this.api;
    }

    /** The loader (or the page's own storage) keeps the token; never in the preview, where the session is a demo. */
    private persist(session: StoredSession | null): void {
        if (this.deps.preview !== true) {
            this.deps.persistSession(session);
        }
    }

    /** Forgets the token, the socket config and (optionally) tells the host to forget its stored copy. */
    private clearSession(tellHost = true): void {
        this.closeRealtime();
        this.token = null;
        this.ws = null;
        this.wsKnown = false;
        this.sessionPromise = null;
        this.rotation = null;

        if (tellHost) {
            this.persist(null);
        }
    }

    /**
     * The server refused the token. `staleRequest`: a REST call that may have left with the token a rotation has just replaced is
     * refused as revoked, which is not the end of the session (the socket's own refusal always is).
     */
    private handleSessionGone(staleRequest = true): void {
        if (
            staleRequest &&
            this.token !== null &&
            this.now() - this.rotatedAt < 5_000
        ) {
            this.rotatedAt = 0;
            void this.syncConversation();

            return;
        }

        this.clearSession();
        this.dispatch({ type: 'SESSION_LOST' });
    }

    /* ----------------------------------------------------------- start */

    private startFromHost(options: {
        category?: string;
        message?: string;
    }): void {
        const config = this.config;

        if (
            config === null ||
            this.state.phase === 'booting' ||
            isLiveChat(this.state) ||
            this.state.phase === 'ended'
        ) {
            return;
        }

        if (this.state.phase === 'closed') {
            this.dispatch({ type: 'NEW_CHAT' });
        }

        const category =
            options.category !== undefined &&
            config.categories.some((c) => c.slug === options.category)
                ? options.category
                : undefined;

        this.dispatch({
            type: 'PRESET',
            category,
            message: options.message,
        });

        if (this.state.phase === 'idle') {
            this.dispatch({ type: 'START' });
            void this.runStart();
        } else if (
            this.state.phase === 'category' &&
            category !== undefined &&
            this.state.busy === null
        ) {
            // `startChat({category})` names the topic: there is nothing left to pick.
            this.chooseCategory(category);
        }
    }

    private presetCategory(slug: string): void {
        if (this.config?.categories.some((c) => c.slug === slug) === true) {
            this.dispatch({ type: 'PRESET', category: slug });
        }
    }

    /** The welcome screen's "Start chat". */
    start(): void {
        this.dispatch({ type: 'START' });
        void this.runStart();
    }

    submitPrechat(values: FormValues): void {
        this.dispatch({ type: 'PRECHAT_SUBMIT', values });
        void this.runStart();
    }

    chooseCategory(slug: string): void {
        if (this.config === null) {
            return;
        }

        const online = this.config.availability?.categories.find(
            (c) => c.slug === slug,
        )?.online;

        if (online === false && this.config.features.offlineForm) {
            this.dispatch({ type: 'CATEGORY_OFFLINE', slug });

            return;
        }

        this.dispatch({ type: 'CATEGORY_PICK', slug });
        void this.runStart();
    }

    back(): void {
        this.dispatch({ type: 'BACK' });
    }

    /** Creates the conversation when the reducer says a start is in flight (`busy: 'starting'`). */
    private async runStart(): Promise<void> {
        if (this.state.busy !== 'starting') {
            return;
        }

        const config = this.config;
        const category =
            this.state.category ??
            (config?.categories.length === 1
                ? config.categories[0].slug
                : null);

        if (category === null) {
            // A widget without any topic cannot route a chat.
            this.dispatch({
                type: 'CREATE_FAIL',
                failure: { kind: 'notice', notice: { code: 'unavailable' } },
            });

            return;
        }

        const { form, initialMessage } = this.state;
        const request: CreateConversationRequest = {
            category,
            ...(form.name.trim() === '' ? {} : { name: form.name.trim() }),
            ...(form.email.trim() === '' ? {} : { email: form.email.trim() }),
            ...(form.phone.trim() === '' ? {} : { phone: form.phone.trim() }),
            ...(initialMessage === null ? {} : { message: initialMessage }),
            ...(config?.preChat.consentText == null
                ? {}
                : { consent: form.consent }),
        };

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.ensureSession();

                const conversation =
                    await this.requireApi().createConversation(request);

                this.dispatch({
                    type: 'CREATE_OK',
                    conversation,
                    now: this.now(),
                });

                return;
            } catch (error) {
                if (isVisitorApiError(error)) {
                    if (error.isSessionGone && attempt === 0) {
                        this.clearSession();

                        continue;
                    }

                    if (error.code === 'conversation_exists') {
                        await this.resumeExisting();

                        return;
                    }
                }

                this.dispatch({
                    type: 'CREATE_FAIL',
                    failure: toCreateFailure(error),
                });

                return;
            }
        }
    }

    /** `409 conversation_exists`: carry on with the chat the session already has. */
    private async resumeExisting(): Promise<void> {
        try {
            const conversation = await this.requireApi().getConversation();

            if (conversation !== null) {
                const messages = await this.fetchMessagesAfter(
                    conversation.ulid,
                    0,
                );

                this.dispatch({
                    type: 'RESUMED',
                    conversation,
                    now: this.resumedQueueStart(conversation),
                });
                this.dispatch({ type: 'MESSAGES', messages });

                return;
            }
        } catch {
            // fall through to the generic failure below
        }

        this.dispatch({
            type: 'CREATE_FAIL',
            failure: { kind: 'notice', notice: { code: 'generic' } },
        });
    }

    /* -------------------------------------------------------- realtime */

    private async connectRealtime(
        conversation: ConversationPublic,
    ): Promise<void> {
        if (this.realtimeFor === conversation.ulid) {
            return;
        }

        // Another conversation's connection (a new chat started while the old one was still opening) is replaced, never kept.
        this.realtime?.close();
        this.realtime = null;
        this.realtimeFor = conversation.ulid;

        const generation = ++this.realtimeGeneration;
        const ws = await this.ensureWs();

        if (this.realtimeGeneration !== generation) {
            return;
        }

        const token = this.token;
        const input =
            ws !== null && token !== null
                ? {
                      ws,
                      token,
                      conversation: conversation.ulid,
                      authEndpoint: `${this.config?.apiBase ?? ''}/broadcasting/auth`,
                  }
                : null;
        const realtime = await (
            this.deps.openRealtime ?? openConversationRealtime
        )({
            factory: this.deps.socketFactory,
            input,
            handlers: this.realtimeHandlers(),
            pollMs: this.deps.pollMs,
            document: this.deps.document,
        });

        if (
            this.disposed ||
            this.realtimeGeneration !== generation ||
            !isLiveChat(this.state)
        ) {
            realtime.close();

            return;
        }

        this.realtime = realtime;

        if (!this.wsKnown) {
            this.retryRealtimeLater(conversation);
        }
    }

    /** Where Reverb lives could not be learnt (network, rate limit): REST polling covers the gap, the socket is tried again. */
    private retryRealtimeLater(conversation: ConversationPublic): void {
        if (this.realtimeRetries >= 3) {
            return;
        }

        const generation = this.realtimeGeneration;

        clearTimeout(this.realtimeRetryTimer);
        this.realtimeRetryTimer = setTimeout(
            () => {
                if (
                    this.disposed ||
                    this.realtimeGeneration !== generation ||
                    !isLiveChat(this.state)
                ) {
                    return;
                }

                this.realtimeRetries += 1;
                this.closeRealtime();
                void this.connectRealtime(conversation);
            },
            (this.deps.pollMs ?? WATCHDOG_MS) * 2 ** this.realtimeRetries,
        );
    }

    private closeRealtime(): void {
        this.realtimeGeneration += 1;
        clearTimeout(this.realtimeRetryTimer);
        this.realtime?.close();
        this.realtime = null;
        this.realtimeFor = null;
        this.dispatchConnection('idle');
    }

    private dispatchConnection(status: MachineState['connection']): void {
        this.dispatch({ type: 'CONNECTION', status });
    }

    private realtimeHandlers(): RealtimeHandlers {
        return {
            onMessage: (message) => this.receive(message),
            onSeen: (receipt) =>
                this.dispatch({
                    type: 'SEEN',
                    upToSeq: receipt.upToSeq,
                    by: receipt.by,
                    at: receipt.at,
                }),
            onClaimed: ({ agent }) => {
                this.dispatch({ type: 'CLAIMED', agent });
                void this.catchUpMessages();
            },
            onEnded: ({ ratingRequested }) =>
                this.dispatch({ type: 'ENDED', ratingRequested }),
            onClosed: ({ reason }) => this.dispatch({ type: 'CLOSED', reason }),
            onMissed: () => this.dispatch({ type: 'MISSED' }),
            onTransferred: () =>
                this.dispatch({ type: 'TRANSFERRED', now: this.now() }),
            onTyping: (whisper) => this.onRemoteTyping(whisper),
            // `polling` is not a fault (no Reverb, or the channel auth said 503): nothing to tell the visitor.
            onStatus: (status) =>
                this.dispatchConnection(status === 'polling' ? 'idle' : status),
            sync: () => void this.syncConversation(),
            onAuthFailure: () => this.handleSessionGone(false),
        };
    }

    /** A message from the socket (or a catch-up fetch): merge, receipts, sound, gap check. */
    private receive(message: MessageData): void {
        const known = this.state.messages.some((m) => m.ulid === message.ulid);

        this.dispatch({ type: 'MESSAGES', messages: [message] });

        if (known) {
            return;
        }

        if (message.sender.type === 'agent') {
            this.markDelivered();

            if (this.viewing) {
                this.markSeen();
            }

            if (
                this.state.open &&
                this.config?.features.sounds === true &&
                this.deps.sound !== undefined
            ) {
                this.deps.sound.ping();
            }

            this.emit('message-received', {
                conversationId: message.conversation,
                messageId: message.ulid,
                agentName: message.sender.name ?? undefined,
                body: message.body ?? undefined,
            });
        }

        this.checkGap();
    }

    private checkGap(): void {
        const conversation = this.state.conversation;

        if (conversation === null) {
            return;
        }

        const lastSeq = Math.max(
            conversation.lastSeq,
            highestSeq(this.state.messages),
        );

        if (findGap(this.state.messages, lastSeq) !== null) {
            void this.syncConversation();
        }
    }

    private onRemoteTyping(whisper: {
        actor: 'agent' | 'visitor';
        typing: boolean;
    }): void {
        if (whisper.actor !== 'agent') {
            return;
        }

        this.typing.receive(whisper);
        this.dispatch({
            type: 'TYPING',
            typing: this.typing.isTyping('agent'),
        });
        clearTimeout(this.typingTimer);

        const wait = this.typing.msUntilExpiry();

        if (wait !== null) {
            this.typingTimer = setTimeout(() => {
                this.dispatch({
                    type: 'TYPING',
                    typing: this.typing.isTyping('agent'),
                });
            }, wait + 20);
        }
    }

    /* ------------------------------------------------------------ sync */

    private async fetchMessagesAfter(
        conversation: string,
        afterSeq: number,
    ): Promise<MessageData[]> {
        const api = this.requireApi();
        const all: MessageData[] = [];
        let cursor = afterSeq;

        for (let page = 0; page < 20; page++) {
            if (this.disposed) {
                break;
            }

            const result = await api.listMessages(conversation, {
                afterSeq: cursor,
                limit: 100,
            });

            all.push(...result.messages);

            if (result.messages.length === 0 || result.nextCursor === null) {
                break;
            }

            cursor = Math.max(cursor, highestSeq(result.messages));
        }

        return all;
    }

    /** Where a catch-up fetch starts: the first hole in what we have, else the end of it. */
    private catchUpFrom(): number {
        const { conversation, messages } = this.state;
        const known = Math.max(
            conversation?.lastSeq ?? 0,
            highestSeq(messages),
        );

        return findGap(messages, known)?.afterSeq ?? highestSeq(messages);
    }

    private async catchUpMessages(): Promise<void> {
        const conversation = this.state.conversation;

        if (conversation === null || this.api === null) {
            return;
        }

        try {
            const messages = await this.fetchMessagesAfter(
                conversation.ulid,
                this.catchUpFrom(),
            );

            this.dispatch({ type: 'MESSAGES', messages });
            this.afterCatchUp(messages);
        } catch (error) {
            this.onBackgroundError(error);
        }
    }

    private afterCatchUp(messages: readonly MessageData[]): void {
        if (messages.some((m) => m.sender.type === 'agent')) {
            this.markDelivered();

            if (this.viewing) {
                this.markSeen();
            }
        }
    }

    private onBackgroundError(error: unknown): void {
        if (isVisitorApiError(error) && error.isSessionGone) {
            this.handleSessionGone();
        }
    }

    /**
     * Brings local state level with the server: the conversation's status first (a missed queue, a claim, an end can all be
     * missed while the socket was away), then every message after what we have. Single-flight; a request that arrives while one
     * runs causes exactly one more pass.
     */
    syncConversation(): Promise<void> {
        if (this.syncing !== null) {
            this.syncAgain = true;

            return this.syncing;
        }

        this.syncing = (async () => {
            do {
                this.syncAgain = false;
                await this.syncOnce();
            } while (this.syncAgain && !this.disposed);
        })().finally(() => {
            this.syncing = null;
        });

        return this.syncing;
    }

    private async syncOnce(): Promise<void> {
        if (this.disposed) {
            return;
        }

        const phase = this.state.phase;
        const conversation = this.state.conversation;

        if (
            this.api === null ||
            conversation === null ||
            !(phase === 'queued' || phase === 'active' || phase === 'ended')
        ) {
            return;
        }

        try {
            const latest = await this.api.getConversation();

            if (this.disposed) {
                return;
            }

            this.applyServerConversation(latest);

            if (isLiveChat(this.state) || this.state.phase === 'ended') {
                const messages = await this.fetchMessagesAfter(
                    conversation.ulid,
                    this.catchUpFrom(),
                );

                this.dispatch({ type: 'MESSAGES', messages });
                this.afterCatchUp(messages);
            }
        } catch (error) {
            this.onBackgroundError(error);
        }
    }

    private applyServerConversation(latest: ConversationPublic | null): void {
        const { phase, conversation } = this.state;

        if (conversation === null) {
            return;
        }

        if (latest === null || latest.ulid !== conversation.ulid) {
            if (phase === 'queued') {
                this.dispatch({ type: 'MISSED' });
            } else if (phase === 'active') {
                this.dispatch({ type: 'CLOSED', reason: 'system' });
            } else if (phase === 'ended') {
                this.dispatch({ type: 'CLOSED', reason: 'timeout' });
            }

            return;
        }

        switch (latest.status) {
            case 'missed':
                if (phase === 'queued') {
                    this.dispatch({ type: 'MISSED' });
                }

                break;
            case 'closed':
                if (phase === 'queued') {
                    this.dispatch({ type: 'MISSED' });
                } else {
                    this.dispatch({ type: 'CLOSED', reason: 'system' });
                }

                break;
            case 'ended':
                if (phase === 'queued' || phase === 'active') {
                    this.dispatch({
                        type: 'ENDED',
                        ratingRequested: latest.ratingRequested,
                    });
                }

                break;
            case 'active':
                if (phase === 'queued' && latest.agent !== null) {
                    this.dispatch({ type: 'CLAIMED', agent: latest.agent });
                }

                break;
            case 'queued':
                if (phase === 'active') {
                    this.dispatch({ type: 'TRANSFERRED', now: this.now() });
                }

                break;
        }
    }

    /* --------------------------------------------------------- sending */

    send(input: { body: string; attachments?: AttachmentData[] }): void {
        const conversation = this.state.conversation;
        const body = input.body.trim();
        const attachments = input.attachments ?? [];

        if (
            this.state.phase !== 'active' ||
            conversation === null ||
            (body === '' && attachments.length === 0)
        ) {
            return;
        }

        const pending = createPendingMessage({
            clientMsgId: this.deps.newId?.() ?? newUlid(this.now()),
            conversation: conversation.ulid,
            sender: {
                type: 'visitor',
                name: this.state.form.name.trim() || null,
                avatarUrl: null,
            },
            body: body === '' ? null : body,
            createdAt: new Date(this.now()).toISOString(),
            attachments,
        });

        this.dispatch({ type: 'MESSAGE_PENDING', message: pending });
        this.stopTyping();
        this.enqueue(pending);
    }

    retry(clientMsgId: string): void {
        const message = this.state.messages.find(
            (m) =>
                m.clientMsgId === clientMsgId &&
                m.seq === null &&
                m.status === 'failed',
        );

        if (message === undefined) {
            return;
        }

        this.dispatch({ type: 'MESSAGE_RETRY', clientMsgId });
        this.enqueue({ ...message, status: 'sending' });
    }

    discard(clientMsgId: string): void {
        this.dispatch({ type: 'MESSAGE_REMOVED', clientMsgId });
    }

    /** Messages are delivered one after the other so the server numbers them in the order they were typed. */
    private enqueue(message: LocalMessage): void {
        this.sendChain = this.sendChain.then(() => this.deliver(message));
    }

    private async deliver(message: LocalMessage): Promise<void> {
        const conversation = this.state.conversation;

        if (
            conversation === null ||
            message.clientMsgId === null ||
            this.api === null ||
            this.disposed
        ) {
            return;
        }

        try {
            const { message: sent } = await this.api.sendMessage(
                conversation.ulid,
                {
                    client_msg_id: message.clientMsgId,
                    ...(message.body === null ? {} : { body: message.body }),
                    ...(message.attachments.length === 0
                        ? {}
                        : {
                              attachments: message.attachments.map(
                                  (a) => a.ulid,
                              ),
                          }),
                },
            );

            this.dispatch({ type: 'MESSAGES', messages: [sent] });
            this.emit('message-sent', {
                conversationId: sent.conversation,
                messageId: sent.ulid,
                body: sent.body ?? undefined,
            });
            this.checkGap();
        } catch (error) {
            this.dispatch({
                type: 'MESSAGE_FAILED',
                clientMsgId: message.clientMsgId,
            });

            if (isVisitorApiError(error)) {
                if (error.isSessionGone) {
                    this.handleSessionGone();
                } else if (error.code === 'conversation_not_active') {
                    // The chat ended or was closed while the visitor was typing: find out which.
                    void this.syncConversation();
                }
            }
        }
    }

    /** The visitor typed (`true`) or emptied / sent / left the draft (`false`). */
    typingChanged(active: boolean): void {
        const conversation = this.state.conversation;

        if (this.state.phase !== 'active' || conversation === null) {
            return;
        }

        const send = this.typing.local(active);

        if (send === null) {
            return;
        }

        if (this.realtime?.whisperTyping(send) !== true && this.api !== null) {
            void this.api.sendTyping(conversation.ulid, send).catch(() => {
                // typing is a nicety
            });
        }
    }

    private stopTyping(): void {
        this.typingChanged(false);
    }

    /** Uploads one image for the next message; progress is reported as 0..1. */
    uploadAttachment(
        file: File,
        options: {
            onProgress?: (fraction: number) => void;
            signal?: AbortSignal;
        } = {},
    ): Promise<AttachmentData> {
        const conversation = this.state.conversation;

        if (conversation === null || this.api === null) {
            return Promise.reject(new Error('No active conversation.'));
        }

        return this.api.uploadAttachment(conversation.ulid, file, options);
    }

    /* ------------------------------------------------------- receipts */

    /** The visitor can see the newest messages (panel open, tab visible, list scrolled to the end). */
    setViewing(viewing: boolean): void {
        this.viewing = viewing;

        if (viewing) {
            this.markSeen();
        }
    }

    private markDelivered(): void {
        const upto = highestSeqFrom(this.state.messages, 'agent');

        if (upto > this.receipts.delivered) {
            this.receipts.delivered = upto;
            this.scheduleReceipts();
        }
    }

    private markSeen(): void {
        const upto = highestSeqFrom(this.state.messages, 'agent');

        if (upto === 0 || upto <= this.receipts.seen) {
            return;
        }

        this.receipts.seen = upto;
        this.receipts.delivered = Math.max(this.receipts.delivered, upto);
        this.dispatch({
            type: 'SEEN',
            upToSeq: upto,
            by: 'visitor',
            at: new Date(this.now()).toISOString(),
        });
        this.scheduleReceipts();
    }

    private scheduleReceipts(): void {
        clearTimeout(this.receipts.timer);
        this.receipts.timer = setTimeout(() => void this.flushReceipts(), 300);
    }

    private async flushReceipts(): Promise<void> {
        const conversation = this.state.conversation;
        const { delivered, seen, sentDelivered, sentSeen } = this.receipts;

        if (conversation === null || this.api === null) {
            return;
        }

        const body = {
            ...(delivered > sentDelivered ? { delivered_upto: delivered } : {}),
            ...(seen > sentSeen ? { seen_upto: seen } : {}),
        };

        if (Object.keys(body).length === 0) {
            return;
        }

        this.receipts.sentDelivered = Math.max(sentDelivered, delivered);
        this.receipts.sentSeen = Math.max(sentSeen, seen);

        try {
            await this.api.sendReceipts(conversation.ulid, body);
        } catch (error) {
            // Retry on the next change rather than hammering.
            this.receipts.sentDelivered = sentDelivered;
            this.receipts.sentSeen = sentSeen;
            this.onBackgroundError(error);
        }
    }

    /* ---------------------------------------------------- end / rating */

    async cancelQueued(): Promise<void> {
        const conversation = this.state.conversation;

        if (
            this.state.phase !== 'queued' ||
            conversation === null ||
            this.api === null
        ) {
            return;
        }

        try {
            await this.api.cancelConversation(conversation.ulid);
            this.dispatch({ type: 'CANCEL_OK' });
        } catch (error) {
            if (isVisitorApiError(error) && error.isSessionGone) {
                this.handleSessionGone();

                return;
            }

            // `409 conversation_not_queued`: an agent was first (or the queue was missed): the server's answer decides.
            await this.syncConversation();

            if (this.state.phase === 'queued') {
                this.dispatch({ type: 'NOTICE', notice: toNotice(error) });
            }
        }
    }

    async endChat(): Promise<void> {
        const conversation = this.state.conversation;

        if (
            this.state.phase !== 'active' ||
            conversation === null ||
            this.api === null
        ) {
            return;
        }

        this.dispatch({ type: 'END_REQUESTED' });

        try {
            const result = await this.api.endConversation(conversation.ulid);

            this.dispatch({
                type: 'ENDED',
                ratingRequested: result.ratingRequested,
            });
        } catch (error) {
            if (isVisitorApiError(error) && error.isSessionGone) {
                this.handleSessionGone();

                return;
            }

            this.dispatch({ type: 'END_FAILED', notice: toNotice(error) });
            void this.syncConversation();
        }
    }

    async rate(score: number, comment: string): Promise<void> {
        const conversation = this.state.conversation;

        if (
            this.state.phase !== 'ended' ||
            conversation === null ||
            this.api === null
        ) {
            return;
        }

        this.dispatch({ type: 'RATING_REQUESTED' });

        try {
            await this.api.rateConversation(conversation.ulid, {
                score,
                ...(comment.trim() === ''
                    ? {}
                    : { comment: comment.trim().slice(0, 2000) }),
            });
            this.emit('rating-submitted', {
                conversationId: conversation.ulid,
                rating: score,
                comment: comment.trim() === '' ? undefined : comment.trim(),
            });
            this.dispatch({ type: 'RATED' });
        } catch (error) {
            if (isVisitorApiError(error)) {
                if (error.isSessionGone) {
                    this.handleSessionGone();

                    return;
                }

                // Already rated, or the rating window ended: nothing left to ask.
                if (error.status === 404 || error.status === 409) {
                    this.dispatch({ type: 'RATING_SKIPPED' });

                    return;
                }
            }

            this.dispatch({ type: 'RATING_FAILED', notice: toNotice(error) });
        }
    }

    /** Declines the rating: the panel moves on at once, the server is told best effort (it closes the chat after the window anyway). */
    skipRating(): void {
        const conversation = this.state.conversation;

        if (
            this.state.phase !== 'ended' ||
            conversation === null ||
            this.api === null
        ) {
            return;
        }

        this.dispatch({ type: 'RATING_SKIPPED' });
        void this.api.skipRating(conversation.ulid).catch((error: unknown) => {
            // `409 conversation_not_ended` (already closed) and everything else leave nothing to fix; a revoked session is cleaned up.
            this.onBackgroundError(error);
        });
    }

    /* ----------------------------------------------------------- offline */

    async submitOffline(values: {
        name: string;
        email: string;
        message: string;
        category: string;
    }): Promise<void> {
        if (this.state.phase !== 'offline' || this.state.busy === 'offline') {
            return;
        }

        this.dispatch({ type: 'OFFLINE_SUBMITTING' });

        const missed = this.state.offline.missed;

        for (let attempt = 0; attempt < 2; attempt++) {
            try {
                await this.ensureSession();

                const ticket = await this.requireApi().createOfflineTicket({
                    name: values.name.trim(),
                    email: values.email.trim(),
                    message: values.message.trim(),
                    ...(values.category === ''
                        ? {}
                        : { category: values.category }),
                    ...(missed === null ? {} : { missed_conversation: missed }),
                });

                this.dispatch({ type: 'OFFLINE_SENT', ticket });
                this.dispatch({
                    type: 'PREFILL',
                    values: { name: values.name, email: values.email },
                });

                return;
            } catch (error) {
                if (
                    isVisitorApiError(error) &&
                    error.isSessionGone &&
                    attempt === 0
                ) {
                    this.clearSession();

                    continue;
                }

                this.dispatch({
                    type: 'OFFLINE_FAILED',
                    failure: toCreateFailure(error),
                });

                return;
            }
        }
    }

    /* ---------------------------------------------------------- new chat */

    /** "Start a new chat": the old ticket and session are left behind. */
    newChat(): void {
        if (this.state.phase !== 'closed') {
            return;
        }

        const hadSession = this.token !== null;

        if (hadSession && this.api !== null && this.deps.preview !== true) {
            void this.api.revokeSession().catch(() => {
                // best effort: the token expires anyway
            });
        }

        this.clearSession();
        this.typing.reset();
        this.receipts.delivered = 0;
        this.receipts.seen = 0;
        this.receipts.sentDelivered = 0;
        this.receipts.sentSeen = 0;
        this.dispatch({ type: 'NEW_CHAT' });

        // Nothing to ask: the visitor asked for a chat, so start it.
        const after: MachineState = this.state;

        if (after.phase === 'idle') {
            this.start();
        }
    }

    /* ------------------------------------------------------------- misc */

    /** The config could not be loaded (a standalone page for a widget that is gone): show the unavailable screen. */
    fail(): void {
        this.unavailable = true;
        this.publish();
    }

    /** Esc, or the panel's close button. */
    requestClose(): void {
        this.deps.host.send({ type: 'close', payload: {} });
    }

    /** The panel is rendered inside a builder preview or another place where the visitor API must stay untouched. */
    get isPreview(): boolean {
        return this.deps.preview === true;
    }

    dismissNotice(): void {
        this.dispatch({ type: 'NOTICE', notice: null });
    }
}
