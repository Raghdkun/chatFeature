import { Bridge } from './bridge';
import {
    parseBoot,
    resolve,
    safeUrl,
    sanitizeOverrides,
    sanitizeToken,
    sanitizeVisitorFields,
} from './config';
import type { Ctx } from './config';
import type { Emitter } from './emitter';
import { GreetingScheduler } from './greeting';
import { Ui } from './launcher';
import { ping, unlockSound } from './sound';
import { makeStore } from './storage';
import type { Store } from './storage';
import { PANEL_EVENTS } from './types';
import type {
    Boot,
    ChatState,
    Dict,
    Effective,
    EventName,
    Greeting,
    Overrides,
    Status,
} from './types';
import { clamp, clean, deepMerge, isRecord, warn } from './util';
import { Viewport } from './viewport';

export interface WidgetOptions {
    key: string;
    win: Window;
    emitter: Emitter;
    script: HTMLScriptElement | null;
    /** Raw `data-*` overrides (sanitised once the boot config, hence the app origin, is known). */
    data: Dict;
    /** Raw `ChatFeatureSettings` / `init` objects, lowest precedence first. */
    init: unknown[];
}

const STATUSES: readonly string[] = [
    'idle',
    'prechat',
    'queued',
    'active',
    'ended',
    'offline',
    'closed',
];
const SANDBOX =
    'allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-downloads';
const FETCH_TIMEOUT_MS = 10_000;

const int = (v: unknown, max: number): number =>
    typeof v === 'number' && Number.isFinite(v)
        ? Math.round(clamp(v, 0, max))
        : 0;

/**
 * One widget instance: boots the config, owns the launcher UI, the lazy panel iframe + bridge, the greeting
 * scheduler and the mobile/viewport handling, and implements every `ChatFeature` command.
 */
export class Widget {
    readonly key: string;
    private boot: Boot | null = null;
    private eff!: Effective;
    private ui!: Ui;
    private sched!: GreetingScheduler;
    private viewport!: Viewport;
    private iframe: HTMLIFrameElement | null = null;
    private bridge: Bridge | null = null;
    private ov: { data: Overrides; init: Overrides; update: Overrides } = {
        data: {},
        init: {},
        update: {},
    };
    private initRaw: unknown[];
    private pending: (() => void)[] = [];
    private cleanups: (() => void)[] = [];
    private abort = new AbortController();
    private mounted = false;
    private destroyed = false;
    private isOpen = false;
    private hiddenByApi = false;
    private requestedMode: 'panel' | 'fullscreen' = 'panel';
    private unread = 0;
    private state: ChatState = { status: 'idle', open: false, unread: 0 };
    private titleBase: string | null = null;
    private titleApplied: string | null = null;
    private readonly local: Store;
    private readonly session: Store;
    private readonly doc: Document;
    private dark: MediaQueryList | null = null;

    constructor(private readonly o: WidgetOptions) {
        this.key = o.key;
        this.doc = o.win.document;
        this.initRaw = [...o.init];
        this.local = makeStore(o.win, 'local');
        this.session = makeStore(o.win, 'session');
    }

    private get sessionKey(): string {
        return `chatfeature:${this.key}:session`;
    }

    private emit(name: EventName, data: Dict = {}): void {
        this.o.emitter.emit(name, data);
    }

    /* ------------------------------------------------------------- boot */

    async start(): Promise<void> {
        const boot = await this.loadBoot();

        if (this.destroyed) {
            return;
        }

        if (boot === null) {
            this.emit('error', {
                code: 'config_failed',
                message: 'Config load failed',
            });

            return;
        }

        this.boot = boot;
        const c = this.ctx();
        this.ov.data = sanitizeOverrides(this.o.data, c);

        for (const raw of this.initRaw) {
            this.ov.init = deepMerge(this.ov.init, sanitizeOverrides(raw, c));
        }

        this.initRaw = [];

        if (this.doc.body !== null) {
            this.mount();
        } else {
            const on = (): void => this.mount();
            this.doc.addEventListener('DOMContentLoaded', on, { once: true });
            this.cleanups.push(() =>
                this.doc.removeEventListener('DOMContentLoaded', on),
            );
        }
    }

    private ctx(): Ctx {
        return {
            base: this.o.win.location.href,
            appOrigin: this.boot?.api.appOrigin,
        };
    }

    private navLangs(): readonly string[] {
        const n = this.o.win.navigator;

        return n.languages?.length > 0 ? n.languages : [n.language ?? ''];
    }

    private async loadBoot(): Promise<Boot | null> {
        const inline = (this.o.win as unknown as Dict).__PNE_CHAT_BOOT__;
        const raw = isRecord(inline) ? inline[this.key] : undefined;
        const boot = raw === undefined ? null : parseBoot(raw, this.key);

        if (boot !== null) {
            return boot;
        }

        // Generic loader: the API lives on the origin the script was served from.
        let base: string;

        try {
            base = `${new URL(this.o.script?.src ?? '').origin}/api/v1/public`;
        } catch {
            return null;
        }

        const locale =
            sanitizeOverrides(this.o.data, {}).locale ?? this.navLangs()[0];
        const url = `${base}/widgets/${encodeURIComponent(this.key)}/config${locale ? `?locale=${encodeURIComponent(locale)}` : ''}`;

        const timer = setTimeout(() => this.abort.abort(), FETCH_TIMEOUT_MS);

        try {
            const res = await fetch(url, {
                mode: 'cors',
                credentials: 'omit',
                headers: { Accept: 'application/json' },
                signal: this.abort.signal,
            });
            const json: unknown = res.ok ? await res.json() : null;

            return isRecord(json) ? parseBoot(json.data, this.key) : null;
        } catch {
            return null;
        } finally {
            clearTimeout(timer);
        }
    }

    private mq(query: string): MediaQueryList | null {
        return typeof this.o.win.matchMedia === 'function'
            ? this.o.win.matchMedia(query)
            : null;
    }

    private mount(): void {
        if (this.destroyed || this.mounted || this.boot === null) {
            return;
        }

        const reduced = this.mq('(prefers-reduced-motion: reduce)');
        this.dark = this.mq('(prefers-color-scheme: dark)');
        this.eff = this.compute();

        this.ui = new Ui(
            {
                toggle: () => (this.isOpen ? this.close() : this.open(true)),
                greetingClick: () => this.open(true),
                greetingDismiss: () => this.sched.dismiss(),
                escape: () => {
                    if (this.ui.greetingVisible) {
                        this.sched.dismiss();
                    } else if (this.isOpen) {
                        this.close();
                        this.ui.focusLauncher();
                    }
                },
                gesture: () => unlockSound(this.o.win),
            },
            this.o.script?.nonce || undefined,
        );
        this.ui.setMotion(reduced?.matches ?? false);
        this.ui.apply(this.eff, this.isDark());
        this.ui.mount(this.doc.body);

        const onMotion = (): void =>
            this.ui.setMotion(reduced?.matches ?? false);
        const onScheme = (): void => this.ui.setScheme(this.isDark());
        reduced?.addEventListener('change', onMotion);
        this.dark?.addEventListener('change', onScheme);
        this.cleanups.push(() => {
            reduced?.removeEventListener('change', onMotion);
            this.dark?.removeEventListener('change', onScheme);
        });

        this.viewport = new Viewport(
            this.o.win,
            () => this.applyMode(),
            (v) => this.bridge?.send('viewport', { ...v }),
        );

        this.sched = new GreetingScheduler({
            cfg: () => this.eff.greetings,
            pool: () => this.boot?.greetings ?? [],
            locale: () => this.eff.locale,
            canShow: () =>
                !this.isOpen &&
                !this.hiddenByApi &&
                this.state.status !== 'queued' &&
                this.state.status !== 'active',
            present: (g) => this.presentGreeting(g),
            retire: (g, reason) => {
                this.ui.hideGreeting();
                this.emit('greeting-dismissed', { id: g.id, reason });
            },
            local: this.local,
            session: this.session,
            storageKey: `chatfeature:${this.key}`,
        });

        this.mounted = true;

        // A stored session means a chat may be live: boot the panel in the background so replies arrive.
        if (this.readSession() !== null) {
            this.ensurePanel();
        }

        this.sched.start();
        this.emit('ready', {
            widgetKey: this.key,
            configVersion: this.boot.configVersion,
        });

        for (const run of this.pending.splice(0)) {
            this.guard(run);
        }

        if (this.eff.openOnLoad) {
            this.open(false);
        }
    }

    private guard(fn: () => void): void {
        try {
            fn();
        } catch (e) {
            this.emit('error', {
                code: 'internal',
                message: String(e),
            });
        }
    }

    /* ----------------------------------------------------------- config */

    private merged(): Overrides {
        return deepMerge(deepMerge(this.ov.data, this.ov.init), this.ov.update);
    }

    private compute(): Effective {
        return resolve(this.boot as Boot, this.merged(), this.navLangs());
    }

    private isDark(): boolean {
        const mode = this.eff.theme.mode;

        return (
            mode === 'dark' || (mode === 'auto' && this.dark?.matches === true)
        );
    }

    /** Client overrides as forwarded to the panel (visitor/identity travel separately). */
    private overridesPayload(): Dict {
        const { visitor, identityToken, openOnLoad, ...rest } = this.merged();
        void visitor;
        void identityToken;
        void openOnLoad;

        return rest as Dict;
    }

    private reapply(): void {
        const before = JSON.stringify(this.eff.greetings);
        this.eff = this.compute();
        this.ui.apply(this.eff, this.isDark());

        if (this.iframe !== null) {
            this.iframe.title = this.eff.text('title', 'Chat');
        }

        if (JSON.stringify(this.eff.greetings) !== before) {
            if (!this.eff.greetings.enabled) {
                this.sched.hide('suppressed');
            }

            this.sched.start();
        }

        this.updateTitle();
    }

    /** Merges more `ChatFeature('init', {...})` settings (before or after the boot config has arrived). */
    mergeInit(raw: unknown): void {
        if (this.boot === null) {
            this.initRaw.push(raw);

            return;
        }

        this.ov.init = deepMerge(
            this.ov.init,
            sanitizeOverrides(raw, this.ctx()),
        );

        if (this.mounted) {
            this.reapply();
        }
    }

    /* -------------------------------------------------------- greetings */

    private presentGreeting(g: Greeting): void {
        const agent = this.eff.greetings.showAgent;
        const name = agent ? g.agentName : null;

        this.ui.showGreeting(g, {
            avatar: agent
                ? (g.agentAvatarUrl ?? this.eff.launcher.avatarUrl)
                : null,
            name,
            flip: agent,
            dismissLabel: this.eff.text('dismiss', 'Dismiss'),
        });
        this.emit('greeting-shown', { id: g.id, agentName: name });
    }

    /* ------------------------------------------------------------ panel */

    private readSession(): { token: string; expiresAt: string } | null {
        const raw = this.local.get(this.sessionKey);

        if (raw === null) {
            return null;
        }

        try {
            const s: unknown = JSON.parse(raw);

            if (
                isRecord(s) &&
                typeof s.token === 'string' &&
                s.token !== '' &&
                typeof s.expiresAt === 'string' &&
                Date.parse(s.expiresAt) > Date.now()
            ) {
                return { token: s.token, expiresAt: s.expiresAt };
            }
        } catch {
            // corrupt entry
        }

        this.local.remove(this.sessionKey);

        return null;
    }

    private initPayload(): Dict {
        const { visitor, identityToken } = this.merged();
        const session = this.readSession();
        const clip = (s: string, n: number): string => s.slice(0, n);

        return {
            boot: (this.boot as Boot).raw,
            ...(session === null ? {} : { visitorSession: session }),
            ...(identityToken === undefined ? {} : { identityToken }),
            ...(visitor === undefined ? {} : { visitor }),
            page: {
                url: clip(this.o.win.location.href, 2000),
                title: clip(this.doc.title, 300),
                referrer: clip(this.doc.referrer, 2000),
            },
            overrides: this.overridesPayload(),
            embedMode: 'launcher',
            viewport: this.viewport.snapshot(),
        };
    }

    private ensurePanel(): void {
        if (this.iframe !== null || this.boot === null) {
            return;
        }

        const origin = this.boot.api.appOrigin;
        const f = this.doc.createElement('iframe');
        f.title = this.eff.text('title', 'Chat');
        f.setAttribute('allow', 'clipboard-write');
        f.setAttribute('referrerpolicy', 'strict-origin-when-cross-origin');
        f.setAttribute('sandbox', SANDBOX);
        this.iframe = f;

        // The listener must exist before the frame starts loading and may say `ready`.
        this.bridge = new Bridge({
            win: this.o.win,
            iframe: f,
            origin,
            init: () => this.initPayload(),
            onMessage: (type, payload) =>
                this.guard(() => this.onPanelMessage(type, payload)),
            onTimeout: (code) =>
                this.emit('error', {
                    code,
                    message: 'Panel handshake failed',
                }),
        });

        f.src = this.boot.api.embed;
        this.ui.panel.append(f);
    }

    private onPanelMessage(type: string, p: Dict): void {
        switch (type) {
            case 'session':
                this.persistSession(p);
                break;
            case 'state':
                this.onState(p);
                break;
            case 'unread':
                this.applyUnread(int(p.count, 999), p);
                break;
            case 'resize':
                if (p.mode === 'panel' || p.mode === 'fullscreen') {
                    this.requestedMode = p.mode;
                    this.applyMode();
                }

                break;
            case 'close':
                this.close();
                break;
            case 'event':
                if (
                    typeof p.name === 'string' &&
                    PANEL_EVENTS.includes(p.name)
                ) {
                    this.emit(
                        p.name as EventName,
                        isRecord(p.data) ? p.data : {},
                    );
                }

                break;
            case 'error':
                this.emit('error', {
                    code: clean(p.code, 64) ?? 'panel_error',
                    message: clean(p.message, 300) ?? '',
                });
                break;
            default:
                break;
        }
    }

    private persistSession(p: Dict): void {
        if (
            typeof p.token === 'string' &&
            p.token !== '' &&
            p.token.length <= 1024
        ) {
            this.local.set(
                this.sessionKey,
                JSON.stringify({
                    token: p.token,
                    expiresAt:
                        typeof p.expiresAt === 'string' ? p.expiresAt : '',
                }),
            );
        } else {
            this.local.remove(this.sessionKey);
        }
    }

    private onState(p: Dict): void {
        const status = (
            typeof p.status === 'string' && STATUSES.includes(p.status)
                ? p.status
                : 'idle'
        ) as Status;
        const name = isRecord(p.agent) ? clean(p.agent.name, 100) : undefined;
        const avatarUrl = isRecord(p.agent)
            ? safeUrl(p.agent.avatarUrl)
            : undefined;

        this.state = {
            status,
            open: this.isOpen,
            unread: int(p.unread, 999),
            ...(name === undefined
                ? {}
                : {
                      agent: {
                          name,
                          ...(avatarUrl === undefined ? {} : { avatarUrl }),
                      },
                  }),
        };
        this.applyUnread(this.state.unread);

        if (status === 'queued' || status === 'active') {
            this.sched.hide('suppressed');
        }
    }

    private applyUnread(count: number, extra: Dict = {}): void {
        const n = this.isOpen ? 0 : count;
        const prev = this.unread;
        this.unread = n;
        this.ui.setBadge(n);

        if (n > prev) {
            this.ui.alert();

            if (this.eff.features.sounds) {
                ping();
            }
        }

        this.updateTitle();

        if (n !== prev) {
            const preview = clean(extra.preview, 200);
            const agentName = isRecord(extra.agent)
                ? clean(extra.agent.name, 100)
                : undefined;

            this.emit('unread-changed', {
                count: n,
                ...(preview === undefined ? {} : { preview }),
                ...(agentName === undefined
                    ? {}
                    : { agent: { name: agentName } }),
            });
        }
    }

    private updateTitle(): void {
        const doc = this.doc;

        if (this.eff.features.titleBadge && this.unread > 0) {
            if (this.titleApplied === null || doc.title !== this.titleApplied) {
                this.titleBase = doc.title;
            }

            this.titleApplied = `(${this.unread}) ${this.titleBase ?? ''}`;
            doc.title = this.titleApplied;
        } else {
            this.restoreTitle();
        }
    }

    private restoreTitle(): void {
        if (this.titleApplied !== null) {
            if (
                this.doc.title === this.titleApplied &&
                this.titleBase !== null
            ) {
                this.doc.title = this.titleBase;
            }

            this.titleApplied = this.titleBase = null;
        }
    }

    /* ----------------------------------------------------- open / close */

    private fullscreen(): boolean {
        return this.viewport.mobile || this.requestedMode === 'fullscreen';
    }

    private applyMode(): void {
        if (!this.mounted) {
            return;
        }

        const fs = this.fullscreen();
        this.ui.setOpen(this.isOpen, fs);

        if (this.isOpen && fs) {
            this.viewport.lock();
        } else {
            this.viewport.unlock();
        }

        this.bridge?.send('viewport', { ...this.viewport.snapshot() });
    }

    open(focus = true): void {
        if (!this.mounted || this.isOpen) {
            return;
        }

        this.isOpen = true;
        this.sched.hide('opened');
        this.ensurePanel();
        this.applyMode();
        this.bridge?.send('open');
        this.applyUnread(0);
        this.emit('open');

        if (focus) {
            this.iframe?.focus();
        }
    }

    close(): void {
        if (!this.mounted || !this.isOpen) {
            return;
        }

        const hadFocus = this.ui.panelHasFocus();
        this.isOpen = false;
        this.applyMode();
        this.bridge?.send('close');

        if (hadFocus) {
            this.ui.focusLauncher();
        }

        this.emit('close');
    }

    private setHidden(hidden: boolean): void {
        this.hiddenByApi = hidden;
        this.ui.setHidden(hidden);

        if (hidden) {
            this.close();
            this.sched.hide('suppressed');
        }
    }

    /* ------------------------------------------------------ JS commands */

    /** Runs a `ChatFeature` command, queueing it until the widget has mounted. */
    exec(cmd: string, args: unknown[]): void {
        if (this.destroyed) {
            return;
        }

        const run = (): void => this.run(cmd, args);

        if (this.mounted) {
            this.guard(run);
        } else {
            this.pending.push(run);
        }
    }

    private run(cmd: string, args: unknown[]): void {
        const [a] = args;

        switch (cmd) {
            case 'open':
                this.open(true);
                break;
            case 'close':
                this.close();
                break;
            case 'toggle':
                if (this.isOpen) {
                    this.close();
                } else {
                    this.open(true);
                }

                break;
            case 'show':
                this.setHidden(false);
                break;
            case 'hide':
                this.setHidden(true);
                break;
            case 'update':
                this.update(a);
                break;
            case 'identify':
                this.identify(a);
                break;
            case 'setVisitor':
                this.setVisitor(a);
                break;
            case 'setCategory':
                this.setCategory(a);
                break;
            case 'startChat':
                this.startChat(a);
                break;
            default:
                warn(`Unknown command: ${cmd}`);
        }
    }

    private update(raw: unknown): void {
        const s = sanitizeOverrides(raw, this.ctx());
        this.ov.update = deepMerge(this.ov.update, s);
        this.reapply();
        this.bridge?.send('update', { overrides: this.overridesPayload() });

        if (s.visitor !== undefined || s.identityToken !== undefined) {
            this.sendIdentity(s.identityToken);
        }
    }

    private sendIdentity(token: string | undefined): void {
        const visitor = this.merged().visitor;
        this.bridge?.send('identify', {
            ...(token === undefined ? {} : { token }),
            ...(visitor === undefined ? {} : { visitor }),
        });
    }

    private identify(arg: unknown): void {
        const token = sanitizeToken(isRecord(arg) ? arg.token : arg);
        const visitor = isRecord(arg)
            ? sanitizeVisitorFields(arg.visitor)
            : undefined;

        if (token === undefined && visitor === undefined) {
            warn('identify: expected a signed identity token');

            return;
        }

        this.ov.update = deepMerge(this.ov.update, {
            ...(token === undefined ? {} : { identityToken: token }),
            ...(visitor === undefined ? {} : { visitor }),
        });
        this.sendIdentity(token);
    }

    private setVisitor(fields: unknown): void {
        const visitor = sanitizeVisitorFields(fields);

        if (visitor === undefined) {
            warn('setVisitor: nothing valid to set');

            return;
        }

        this.ov.update = deepMerge(this.ov.update, { visitor });
        this.sendIdentity(undefined);
    }

    private category(slug: unknown): string | undefined {
        return typeof slug === 'string' &&
            this.eff.categories.some((c) => c.slug === slug)
            ? slug
            : undefined;
    }

    private setCategory(slug: unknown): void {
        const s = this.category(slug);

        if (s === undefined) {
            warn('setCategory: unknown category');

            return;
        }

        this.ensurePanel();
        this.bridge?.send('setCategory', { slug: s });
    }

    private startChat(opts: unknown): void {
        const o = isRecord(opts) ? opts : {};
        const category = this.category(o.category);
        const message = clean(o.message, 2000);

        this.open(true);
        this.bridge?.send('startChat', {
            ...(category === undefined ? {} : { category }),
            ...(message === undefined ? {} : { message }),
        });
    }

    getState(): Dict {
        return {
            ...this.state,
            open: this.isOpen,
            unread: this.unread,
            ready: this.mounted,
            panelReady: this.bridge?.acked ?? false,
            widgetKey: this.key,
            configVersion: this.boot?.configVersion ?? null,
        };
    }

    /** Tears everything down: timers, listeners, DOM, iframe, stored session. */
    destroy(): void {
        if (this.destroyed) {
            return;
        }

        this.destroyed = true;
        this.abort.abort();
        this.pending = [];

        if (this.mounted) {
            this.sched.stop();
            this.bridge?.send('shutdown');
            this.bridge?.dispose();
            this.viewport.destroy();
            this.restoreTitle();
            this.iframe?.remove();
            this.ui.destroy();
        }

        this.local.remove(this.sessionKey);
        this.mounted = false;

        for (const c of this.cleanups.splice(0)) {
            c();
        }
    }
}
