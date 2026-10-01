import { vi } from 'vitest';
import { install } from '../src/api';
import type { ChatFeatureFn } from '../src/api';

export const APP = 'https://chat.example.com';

/**
 * jsdom never creates a browsing context for an <iframe> inside a shadow root, so `contentWindow` is null there.
 * Real browsers give every frame a stable window: emulate that with one fake window per iframe element whose
 * `postMessage` is a spy.
 */
export interface FakeWindow {
    postMessage: ReturnType<typeof vi.fn>;
}
const frames = new WeakMap<HTMLIFrameElement, FakeWindow>();
Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement): FakeWindow {
        let w = frames.get(this);

        if (w === undefined) {
            w = { postMessage: vi.fn() };
            frames.set(this, w);
        }

        return w;
    },
});
export const KEY = 'wk_TEST1234';

type Dict = Record<string, unknown>;

/** A resolved boot config (docs/contracts/widget-config.md) with optional overrides merged in shallowly per group. */
export function makeBoot(over: Dict = {}): Dict {
    const base: Dict = {
        v: 1,
        key: KEY,
        configVersion: 7,
        generatedAt: '2026-09-30T12:00:00Z',
        api: {
            base: `${APP}/api/v1/public`,
            embed: `${APP}/embed/${KEY}`,
            appOrigin: APP,
        },
        config: {
            v: 1,
            defaultLocale: 'en',
            localeDetect: true,
            theme: { mode: 'light' },
            launcher: { style: 'bubble', icon: 'chat', label: 'Chat with us' },
            texts: {
                en: { title: 'Support', closeChat: 'Close chat' },
                ar: { title: 'الدعم' },
            },
            features: {},
            greetings: {
                enabled: true,
                onPageLoad: true,
                delaySeconds: 3,
                intervalMinutes: 30,
                autoHideSeconds: 20,
                dismissPolicy: 'session',
                showAgent: true,
            },
        },
        greetings: [
            {
                id: 'g1',
                body: 'Hi! Need a hand?',
                agentName: 'Sara',
                agentAvatarUrl: 'https://cdn.example.com/sara.png',
                locale: null,
                weight: 1,
            },
        ],
        categories: [
            { slug: 'billing', label: 'Billing' },
            { slug: 'sales', label: 'Sales' },
            { slug: 'tech', label: 'Technical' },
        ],
        availability: { online: true, openNow: true, nextOpenAt: null },
    };

    const out: Dict = { ...base };

    for (const k of Object.keys(over)) {
        const v = over[k];
        const cur = out[k];
        out[k] =
            v !== null &&
            typeof v === 'object' &&
            !Array.isArray(v) &&
            typeof cur === 'object' &&
            cur !== null &&
            !Array.isArray(cur)
                ? { ...(cur as Dict), ...(v as Dict) }
                : v;
    }

    return out;
}

/** Deep-ish config overrides: `cfg({ greetings: { enabled: false } })`. */
export function makeBootCfg(cfg: Dict, extra: Dict = {}): Dict {
    const b = makeBoot(extra);
    const config = { ...(b.config as Dict) };

    for (const k of Object.keys(cfg)) {
        const v = cfg[k];
        const cur = config[k];
        config[k] =
            typeof v === 'object' &&
            v !== null &&
            !Array.isArray(v) &&
            typeof cur === 'object' &&
            cur !== null
                ? { ...(cur as Dict), ...(v as Dict) }
                : v;
    }

    return { ...b, config };
}

export interface MediaControl {
    reduced: boolean;
    dark: boolean;
    mobile: boolean;
    set(kind: 'reduced' | 'dark' | 'mobile', value: boolean): void;
}

/** jsdom has no matchMedia: a controllable fake covering the three queries the loader uses. */
export function mockMatchMedia(
    initial: Partial<Pick<MediaControl, 'reduced' | 'dark' | 'mobile'>> = {},
): MediaControl {
    const state = { reduced: false, dark: false, mobile: false, ...initial };
    const lists: {
        kind: 'reduced' | 'dark' | 'mobile';
        mql: MediaQueryList;
        fns: Set<() => void>;
    }[] = [];

    const kindOf = (q: string): 'reduced' | 'dark' | 'mobile' | null =>
        q.includes('prefers-reduced-motion')
            ? 'reduced'
            : q.includes('prefers-color-scheme')
              ? 'dark'
              : q.includes('max-width')
                ? 'mobile'
                : null;

    window.matchMedia = ((query: string) => {
        const kind = kindOf(query);
        const fns = new Set<() => void>();
        const mql = {
            media: query,
            get matches() {
                return kind === null ? false : state[kind];
            },
            addEventListener: (_: string, fn: () => void) => fns.add(fn),
            removeEventListener: (_: string, fn: () => void) => fns.delete(fn),
            addListener: (fn: () => void) => fns.add(fn),
            removeListener: (fn: () => void) => fns.delete(fn),
            dispatchEvent: () => true,
            onchange: null,
        } as unknown as MediaQueryList;

        if (kind !== null) {
            lists.push({ kind, mql, fns });
        }

        return mql;
    }) as typeof window.matchMedia;

    return {
        get reduced() {
            return state.reduced;
        },
        get dark() {
            return state.dark;
        },
        get mobile() {
            return state.mobile;
        },
        set(kind, value) {
            state[kind] = value;

            for (const l of lists.filter((x) => x.kind === kind)) {
                for (const fn of Array.from(l.fns)) {
                    fn();
                }
            }
        },
    };
}

export function resetGlobals(): void {
    const g = window as unknown as Dict;
    const cf = g.ChatFeature as ChatFeatureFn | undefined;

    try {
        cf?.('shutdown');
    } catch {
        // ignore
    }

    delete g.ChatFeature;
    delete g.ChatFeatureSettings;
    delete g.__PNE_CHAT_BOOT__;
    document.head.innerHTML = '';
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
    document.documentElement.removeAttribute('style');
    document.title = '';

    try {
        localStorage.clear();
        sessionStorage.clear();
    } catch {
        // ignore
    }

    // @ts-expect-error cleaning up the test double
    delete window.matchMedia;
    Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
    });
}

export function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', {
        value: hidden,
        configurable: true,
    });
    document.dispatchEvent(new Event('visibilitychange'));
}

export function makeScript(
    attrs: Record<string, string> = {},
): HTMLScriptElement {
    const s = document.createElement('script');
    s.src = `${APP}/w/${KEY}.js`;

    for (const k of Object.keys(attrs)) {
        s.setAttribute(k, attrs[k]);
    }

    document.head.append(s);

    return s;
}

export function inlineBoot(boot: Dict = makeBoot()): void {
    const g = window as unknown as Dict;
    const reg = (g.__PNE_CHAT_BOOT__ as Dict | undefined) ?? {};
    reg[String(boot.key)] = boot;
    g.__PNE_CHAT_BOOT__ = reg;
}

/** Let the async boot (microtasks + zero timers) finish under fake timers. */
export async function flush(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

export interface Booted {
    cf: ChatFeatureFn;
    host: HTMLElement;
    shadow: ShadowRoot;
    iframe: () => HTMLIFrameElement | null;
    posts: () => { type: string; payload: Dict; id?: string; origin: string }[];
    fromPanel: (type: string, payload?: unknown, id?: string) => void;
    handshake: () => void;
    q: <T extends Element = HTMLElement>(sel: string) => T;
}

/** Installs the loader against an inline boot config and waits until the launcher is mounted. */
export async function boot(
    opts: {
        boot?: Dict;
        script?: Record<string, string>;
        settings?: Dict;
        before?: () => void;
    } = {},
): Promise<Booted> {
    inlineBoot(opts.boot ?? makeBoot());
    const g = window as unknown as Dict;

    if (opts.settings !== undefined) {
        g.ChatFeatureSettings = opts.settings;
    }

    opts.before?.();
    const script = makeScript(opts.script);
    const cf = install(window, script) as ChatFeatureFn;
    await flush();

    return handles(cf);
}

export function handles(cf: ChatFeatureFn): Booted {
    const host = document.querySelector('pne-chat-widget') as HTMLElement;
    const shadow = host?.shadowRoot as ShadowRoot;
    const iframe = (): HTMLIFrameElement | null =>
        shadow?.querySelector('iframe') ?? null;
    const frameWindow = (): FakeWindow | undefined =>
        (iframe() as HTMLIFrameElement | null)?.contentWindow as unknown as
            | FakeWindow
            | undefined;
    const fromPanel = (
        type: string,
        payload: unknown = {},
        id?: string,
    ): void => {
        const f = iframe();
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    ns: 'chatfeature',
                    v: 1,
                    type,
                    payload,
                    ...(id ? { id } : {}),
                },
                origin: APP,
                source: (f?.contentWindow ??
                    null) as unknown as MessageEventSource | null,
            }),
        );
    };

    return {
        cf,
        host,
        shadow,
        iframe,
        posts: () =>
            (frameWindow()?.postMessage.mock.calls ?? []).map((c) => {
                const m = c[0] as Dict;

                return {
                    type: m.type as string,
                    payload: m.payload as Dict,
                    id: m.id as string | undefined,
                    origin: c[1] as string,
                };
            }),
        fromPanel,
        handshake: () => {
            fromPanel('ready', { protocol: 1 });
            const init = (frameWindow()?.postMessage.mock.calls ?? [])
                .map((c) => c[0] as Dict)
                .find((m) => m.type === 'init');
            fromPanel('init:result', {}, init?.id as string | undefined);
        },
        q: <T extends Element = HTMLElement>(sel: string): T =>
            shadow.querySelector(sel) as T,
    };
}
