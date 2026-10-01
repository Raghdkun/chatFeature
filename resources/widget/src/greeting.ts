import type { Store } from './storage';
import type { Greeting, GreetingsConfig } from './types';

const lang = (l: string): string => l.split('-')[0].toLowerCase();

/**
 * Weighted random pick among the active greetings that match the visitor locale, else the locale-less ones,
 * else those of the widget's default locale (a visitor must not get no greeting just because the pool is
 * tagged for another language). `lastId` is excluded whenever there is any alternative, so the same message
 * is never shown twice in a row.
 */
export function pickGreeting(
    pool: readonly Greeting[],
    locale: string,
    lastId: string | null,
    rng: () => number,
    fallbackLocale = '',
): Greeting | null {
    const tagged = (l: string): Greeting[] =>
        pool.filter((g) => g.locale !== null && lang(g.locale) === lang(l));
    let candidates =
        [
            tagged(locale),
            pool.filter((g) => g.locale === null),
            tagged(fallbackLocale),
        ].find((c) => c.length > 0) ?? [];

    if (candidates.length > 1) {
        candidates = candidates.filter((g) => g.id !== lastId);
    }

    const total = candidates.reduce((sum, g) => sum + Math.max(1, g.weight), 0);

    if (candidates.length === 0 || total <= 0) {
        return null;
    }

    let roll = rng() * total;

    for (const g of candidates) {
        roll -= Math.max(1, g.weight);

        if (roll < 0) {
            return g;
        }
    }

    return candidates[candidates.length - 1];
}

/** setTimeout that can be paused and resumed (time left is kept), used for everything that must not run in a hidden tab. */
export class PausableTimer {
    private id: ReturnType<typeof setTimeout> | null = null;
    private left: number;
    private startedAt = 0;
    done = false;

    constructor(
        private readonly cb: () => void,
        ms: number,
        paused: boolean,
    ) {
        this.left = ms;

        if (!paused) {
            this.resume();
        }
    }

    pause(): void {
        if (this.id !== null) {
            clearTimeout(this.id);
            this.id = null;
            this.left = Math.max(0, this.left - (Date.now() - this.startedAt));
        }
    }

    resume(): void {
        if (this.id === null && !this.done) {
            this.startedAt = Date.now();
            this.id = setTimeout(() => {
                this.id = null;
                this.done = true;
                this.cb();
            }, this.left);
        }
    }

    clear(): void {
        this.pause();
        this.done = true;
    }
}

export type RetireReason = 'timeout' | 'dismissed' | 'opened' | 'suppressed';

export interface SchedulerDeps {
    cfg: () => GreetingsConfig;
    pool: () => readonly Greeting[];
    locale: () => string;
    /** Widget default locale: greetings tagged with it are the last fallback. */
    fallback?: () => string;
    /** False while the panel is open, a chat is queued/active, or the widget is hidden. */
    canShow: () => boolean;
    present: (g: Greeting) => void;
    retire: (g: Greeting, reason: RetireReason) => void;
    local: Store;
    session: Store;
    storageKey: string;
}

/**
 * Greeting timeline: first tick `delaySeconds` after load (when `onPageLoad`), then every `intervalMinutes`.
 * Each tick picks a greeting, hands it to the UI, and starts the auto-hide timer. All timers pause while
 * the tab is hidden. The scheduler never touches the DOM.
 */
export class GreetingScheduler {
    active: Greeting | null = null;
    private next: PausableTimer | null = null;
    private hideTimer: PausableTimer | null = null;
    private readonly onVisibility = (): void => {
        const hidden = this.hidden();

        for (const t of [this.next, this.hideTimer]) {
            if (hidden) {
                t?.pause();
            } else {
                t?.resume();
            }
        }
    };

    constructor(private readonly d: SchedulerDeps) {
        document.addEventListener('visibilitychange', this.onVisibility);
    }

    private hidden(): boolean {
        return document.hidden;
    }

    private get dismissedKey(): string {
        return `${this.d.storageKey}:greeting:dismissed`;
    }

    private get lastKey(): string {
        return `${this.d.storageKey}:greeting:last`;
    }

    start(): void {
        this.stopTimers();
        const c = this.d.cfg();

        if (!c.enabled) {
            return;
        }

        if (c.onPageLoad) {
            this.schedule(c.delaySeconds * 1000);
        } else if (c.intervalMinutes > 0) {
            this.schedule(c.intervalMinutes * 60_000);
        }
    }

    private schedule(ms: number, skipBlock = false): void {
        this.next = new PausableTimer(
            () => this.tick(skipBlock),
            ms,
            this.hidden(),
        );
    }

    private tick(skipBlock = false): void {
        const c = this.d.cfg();

        this.show(skipBlock);

        if (c.enabled && c.intervalMinutes > 0) {
            this.schedule(c.intervalMinutes * 60_000);
        }
    }

    /** Dismissed by the visitor within the policy window? */
    private blocked(c: GreetingsConfig): boolean {
        if (c.dismissPolicy === 'never') {
            return false;
        }

        const at = Number(this.d.session.get(this.dismissedKey));

        if (!Number.isFinite(at) || at <= 0) {
            return false;
        }

        return c.dismissPolicy === 'session' || c.intervalMinutes === 0
            ? true
            : Date.now() - at < c.intervalMinutes * 60_000;
    }

    private show(skipBlock = false): void {
        const c = this.d.cfg();

        if (
            !c.enabled ||
            this.active !== null ||
            !this.d.canShow() ||
            (!skipBlock && this.blocked(c))
        ) {
            return;
        }

        const g = pickGreeting(
            this.d.pool(),
            this.d.locale(),
            this.d.local.get(this.lastKey),
            Math.random,
            this.d.fallback?.(),
        );

        if (g === null) {
            return;
        }

        this.d.local.set(this.lastKey, g.id);
        this.active = g;
        this.d.present(g);

        if (c.autoHideSeconds > 0) {
            this.hideTimer = new PausableTimer(
                () => this.hide('timeout'),
                c.autoHideSeconds * 1000,
                this.hidden(),
            );
        }
    }

    /** Hides the active greeting. Only a visitor `dismissed` counts against the dismiss policy. */
    hide(reason: RetireReason): void {
        const g = this.active;

        this.hideTimer?.clear();
        this.hideTimer = null;

        if (g === null) {
            return;
        }

        this.active = null;

        if (reason === 'dismissed') {
            const c = this.d.cfg();

            this.d.session.set(this.dismissedKey, String(Date.now()));

            // `interval`: the next greeting is due one full interval after the dismissal (not at the next
            // tick of the old timeline, which would fall inside the window and be skipped for a whole cycle).
            if (
                c.enabled &&
                c.dismissPolicy === 'interval' &&
                c.intervalMinutes > 0
            ) {
                this.next?.clear();
                this.schedule(c.intervalMinutes * 60_000, true);
            }
        }

        this.d.retire(g, reason);
    }

    dismiss(): void {
        this.hide('dismissed');
    }

    private stopTimers(): void {
        this.next?.clear();
        this.next = null;
    }

    stop(): void {
        this.stopTimers();
        this.hide('suppressed');
        document.removeEventListener('visibilitychange', this.onVisibility);
    }
}
