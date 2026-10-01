import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ping, unlockSound } from '../src/sound';
import {
    APP,
    KEY,
    boot,
    makeBoot,
    makeBootCfg,
    mockMatchMedia,
    resetGlobals,
    setHidden,
} from './helpers';
import type { Booted, MediaControl } from './helpers';

vi.mock('../src/sound', () => ({ ping: vi.fn(), unlockSound: vi.fn() }));

type Dict = Record<string, unknown>;
const SESSION_KEY = `chatfeature:${KEY}:session`;
const FUTURE = '2999-01-01T00:00:00.000Z';

const types = (b: Booted): string[] => b.posts().map((p) => p.type);
const last = (b: Booted, type: string) =>
    b
        .posts()
        .filter((p) => p.type === type)
        .at(-1);

describe('Widget (launcher + panel + bridge wired together)', () => {
    let media: MediaControl;

    beforeEach(() => {
        vi.useFakeTimers();
        media = mockMatchMedia();
        vi.mocked(ping).mockClear();
        vi.mocked(unlockSound).mockClear();
    });
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        Reflect.deleteProperty(window, 'visualViewport');
        resetGlobals();
    });

    describe('precedence in a real boot: dashboard < data-* < settings < init < update', () => {
        it('applies every layer in order', async () => {
            const b = await boot({
                boot: makeBootCfg({
                    theme: {
                        primary: '#111111',
                        radius: 1,
                        accent: '#222222',
                        offsetX: 5,
                    },
                }),
                script: {
                    'data-theme-primary': '#aaaaaa',
                    'data-theme-radius': '8',
                    'data-theme-accent': '#bbbbbb',
                    'data-position': 'left',
                },
                settings: { theme: { primary: '#cccccc', radius: 12 } },
            });
            const v = (k: string) => b.q('.root').style.getPropertyValue(k);
            expect(v('--primary')).toBe('#cccccc'); // settings beat data-*
            expect(v('--radius')).toBe('12px');
            expect(v('--accent')).toBe('#bbbbbb'); // data-* beats the dashboard
            expect(v('--ox')).toBe('5px'); // untouched dashboard value
            expect(b.q('.root').dataset.pos).toBe('bottom-left');

            b.cf('init', { theme: { primary: '#dddddd' } });
            expect(v('--primary')).toBe('#dddddd');
            b.cf('update', { theme: { primary: '#eeeeee' } });
            expect(v('--primary')).toBe('#eeeeee'); // runtime update beats everything
            b.cf('init', { theme: { primary: '#123456' } });
            expect(v('--primary')).toBe('#eeeeee'); // ...even a later init
        });

        it('update cannot expand: disabled features, extra categories and policy stay as configured', async () => {
            const b = await boot({
                boot: makeBootCfg({
                    features: { attachments: false, poweredBy: false },
                }),
            });
            b.cf('open');
            b.handshake();
            b.cf('update', {
                features: { attachments: true, poweredBy: true, rating: false },
                categories: ['billing', 'admin'],
                routing: { queueTimeoutSeconds: 1 },
                domains: ['evil.example'],
            });
            const overrides = last(b, 'update')?.payload.overrides as Dict;
            expect(overrides.categories).toEqual(['billing', 'admin']); // forwarded as a *request*; the panel/server re-validate
            expect(overrides).not.toHaveProperty('routing');
            expect(overrides).not.toHaveProperty('domains');
            expect(JSON.stringify(overrides)).not.toContain('evil.example');
        });

        it('a hostile boot config cannot inject markup or styles', async () => {
            const evil = '<img src=x onerror="window.__xss=1">';
            const b = await boot({
                boot: makeBootCfg(
                    {
                        theme: {
                            primary: 'red; background:url(//evil)',
                            fontFamily:
                                'x;}</style><script>window.__xss=2</script>',
                        },
                        launcher: {
                            label: evil,
                            style: 'pill',
                            iconUrl: 'javascript:alert(1)',
                            icon: 'custom',
                        },
                    },
                    {
                        greetings: [
                            {
                                id: 'g',
                                body: evil,
                                agentName: evil,
                                agentAvatarUrl: 'javascript:alert(1)',
                            },
                        ],
                    },
                ),
            });
            expect(b.q('.lbl').textContent).toBe(evil);
            expect(b.shadow.querySelectorAll('img, script')).toHaveLength(0);
            expect(b.q('.root').style.getPropertyValue('--primary')).toBe(
                '#0f766e',
            ); // default, not the injected value
            expect(b.q('.root').style.getPropertyValue('--font')).not.toContain(
                'script',
            );
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body').textContent).toBe(evil);
            expect(b.shadow.querySelectorAll('img, script')).toHaveLength(0);
            expect((window as unknown as Dict).__xss).toBeUndefined();
        });
    });

    describe('panel iframe', () => {
        it('is created lazily on first open, with a locked-down attribute set', async () => {
            const b = await boot();
            expect(b.iframe()).toBeNull();
            b.cf('open');
            const f = b.iframe() as HTMLIFrameElement;
            expect(f.getAttribute('src')).toBe(`${APP}/embed/${KEY}`);
            expect(f.title).toBe('Support');
            expect(f.getAttribute('allow')).toBe('clipboard-write');
            expect(f.getAttribute('referrerpolicy')).toBe(
                'strict-origin-when-cross-origin',
            );
            const sandbox = f.getAttribute('sandbox') ?? '';
            expect(sandbox).toContain('allow-scripts');
            expect(sandbox).toContain('allow-same-origin'); // needed: the panel talks to its own API origin
            expect(sandbox).not.toContain('allow-top-navigation');
            expect(f.parentElement).toBe(b.q('.panel'));
            b.cf('close');
            b.cf('open');
            expect(b.shadow.querySelectorAll('iframe')).toHaveLength(1);
        });

        it('is never created for a hostile embed URL (config rejected, nothing mounted)', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const evil = makeBoot({
                api: { embed: 'https://evil.example/embed', appOrigin: APP },
            });
            inlineBootAndInstall(evil);
            await vi.advanceTimersByTimeAsync(0);
            expect(document.querySelector('pne-chat-widget')).toBeNull();
        });

        it('boots in the background when a stored session exists (so replies can arrive)', async () => {
            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify({ token: 'vt_1', expiresAt: FUTURE }),
            );
            const b = await boot();
            expect(b.iframe()).not.toBeNull();
            expect(b.q('.panel').dataset.open).toBe('false');
            expect(b.q('.panel').hasAttribute('inert')).toBe(true);
        });

        it.each([
            [
                'expired',
                JSON.stringify({
                    token: 'vt_1',
                    expiresAt: '2000-01-01T00:00:00Z',
                }),
            ],
            ['corrupt', '{not json'],
            ['wrong shape', JSON.stringify({ token: 5 })],
            ['no expiry', JSON.stringify({ token: 'vt_1' })],
        ])('ignores and removes a %s stored session', async (_, value) => {
            localStorage.setItem(SESSION_KEY, value);
            const b = await boot();
            expect(b.iframe()).toBeNull();
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        });

        it('open focuses the panel; the launcher can be told not to steal focus on openOnLoad', async () => {
            const b = await boot({ script: { 'data-open-on-load': 'true' } });
            const f = b.iframe() as HTMLIFrameElement;
            expect(b.q('.panel').dataset.open).toBe('true');
            const focus = vi.spyOn(f, 'focus');
            b.cf('close');
            b.cf('open');
            expect(focus).toHaveBeenCalledTimes(1);
        });
    });

    describe('handshake and init payload', () => {
        it('sends init only after the panel says ready, then flushes queued host messages', async () => {
            document.title = 'Pricing';
            Object.defineProperty(document, 'referrer', {
                value: 'https://ref.example/',
                configurable: true,
            });
            const b = await boot({
                settings: {
                    theme: { primary: '#334455' },
                    visitor: { name: 'Ann', meta: { plan: 'pro' } },
                    categories: ['sales'],
                    identityToken: 'aa.bb.cc',
                },
            });
            b.cf('open');
            b.cf('setCategory', 'sales');
            expect(types(b)).toEqual([]); // nothing before the panel is ready

            b.fromPanel('ready', { protocol: 1 });
            const init = last(b, 'init');
            expect(init?.origin).toBe(APP);
            expect(init?.id).toBeTruthy();
            const p = init?.payload as Dict;
            expect(p.embedMode).toBe('launcher');
            expect(p.page).toMatchObject({
                title: 'Pricing',
                referrer: 'https://ref.example/',
            });
            expect((p.page as Dict).url).toBe(window.location.href);
            expect(p.visitor).toEqual({ name: 'Ann', meta: { plan: 'pro' } });
            expect(p.identityToken).toBe('aa.bb.cc');
            expect(p.overrides).toEqual({
                theme: { primary: '#334455' },
                categories: ['sales'],
            });
            expect(p.viewport).toEqual({
                width: window.innerWidth,
                height: window.innerHeight,
                keyboardInset: 0,
            });
            expect((p.boot as Dict).key).toBe(KEY);
            expect((p.boot as Dict).configVersion).toBe(7);
            expect(p).not.toHaveProperty('visitorSession');

            b.fromPanel('init:result', {}, init?.id);
            expect(types(b)).toEqual([
                'init',
                'viewport',
                'open',
                'setCategory',
            ]);
            expect(last(b, 'setCategory')?.payload).toEqual({ slug: 'sales' });
        });

        it('hands the persisted session to the panel on init', async () => {
            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify({ token: 'vt_abc', expiresAt: FUTURE }),
            );
            const b = await boot();
            b.fromPanel('ready', { protocol: 1 });
            expect((last(b, 'init')?.payload ?? {}).visitorSession).toEqual({
                token: 'vt_abc',
                expiresAt: FUTURE,
            });
        });

        it('surfaces handshake failures as error events (not exceptions)', async () => {
            const b = await boot();
            const errors: Dict[] = [];
            b.cf('on', 'error', (e: Dict) => errors.push(e));
            b.cf('open');
            await vi.advanceTimersByTimeAsync(10_000);
            expect(errors.map((e) => e.code)).toEqual(['ready_timeout']);
        });

        it('ignores panel messages from a spoofed origin or window', async () => {
            const b = await boot();
            b.cf('open');
            const opens = vi.fn();
            b.cf('on', 'unread-changed', opens);
            const msg = {
                ns: 'chatfeature',
                v: 1,
                type: 'unread',
                payload: { count: 9 },
            };
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: msg,
                    origin: 'https://evil.example',
                    source: b.iframe()?.contentWindow as never,
                }),
            );
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: msg,
                    origin: APP,
                    source: window,
                }),
            );
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: msg,
                    origin: APP,
                    source: null,
                }),
            );
            expect(opens).not.toHaveBeenCalled();
            expect(b.q('.badge').dataset.show).toBe('false');
        });
    });

    describe('visitor session persistence (host-origin localStorage)', () => {
        it('stores the session message and clears it on null', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.fromPanel('session', { token: 'vt_1', expiresAt: FUTURE });
            expect(
                JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}'),
            ).toEqual({ token: 'vt_1', expiresAt: FUTURE });
            b.fromPanel('session', null);
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        });

        it('survives localStorage being unusable (memory fallback)', async () => {
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });
            vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
                throw new DOMException('denied', 'SecurityError');
            });
            const b = await boot();
            b.cf('open');
            b.handshake();
            expect(() =>
                b.fromPanel('session', { token: 'vt_mem', expiresAt: FUTURE }),
            ).not.toThrow();
            // a later handshake (panel reload) still gets the token back from memory
            b.fromPanel('ready', { protocol: 1 });
            expect((last(b, 'init')?.payload ?? {}).visitorSession).toEqual({
                token: 'vt_mem',
                expiresAt: FUTURE,
            });
            b.fromPanel('session', null);
            b.fromPanel('ready', { protocol: 1 });
            expect(last(b, 'init')?.payload).not.toHaveProperty(
                'visitorSession',
            );
        });

        it('survives the localStorage property itself throwing', async () => {
            const original = Object.getOwnPropertyDescriptor(
                window,
                'localStorage',
            );
            Object.defineProperty(window, 'localStorage', {
                configurable: true,
                get() {
                    throw new DOMException('denied', 'SecurityError');
                },
            });

            try {
                const b = await boot();
                b.cf('open');
                b.handshake();
                expect(() =>
                    b.fromPanel('session', {
                        token: 'vt_mem',
                        expiresAt: FUTURE,
                    }),
                ).not.toThrow();
                expect(b.q('.panel').dataset.open).toBe('true');
            } finally {
                if (original !== undefined) {
                    Object.defineProperty(window, 'localStorage', original);
                }
            }
        });

        it('rejects oversized or non-string tokens', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.fromPanel('session', {
                token: 'x'.repeat(5000),
                expiresAt: FUTURE,
            });
            b.fromPanel('session', {
                token: { evil: true },
                expiresAt: FUTURE,
            });
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        });
    });

    describe('state, unread and the closed-bubble alert', () => {
        let b: Booted;
        beforeEach(async () => {
            b = await boot({ settings: { features: { titleBadge: true } } });
            b.cf('open');
            b.handshake();
            b.cf('close');
        });

        it('shows the badge, plays the alert and the sound hook, and emits unread-changed', () => {
            const changed = vi.fn();
            b.cf('on', 'unread-changed', changed);
            b.fromPanel('unread', {
                count: 2,
                preview: 'Hello!',
                agent: { name: 'Sara' },
            });
            expect(b.q('.badge').textContent).toBe('2');
            expect(b.q('.badge').dataset.show).toBe('true');
            expect(b.q('button.launcher').dataset.alert).toBe('true');
            expect(ping).toHaveBeenCalledTimes(1);
            expect(changed).toHaveBeenCalledWith({
                count: 2,
                preview: 'Hello!',
                agent: { name: 'Sara' },
            });
            b.fromPanel('unread', { count: 2 });
            expect(changed).toHaveBeenCalledTimes(1); // unchanged count: no event, no extra ping
            expect(ping).toHaveBeenCalledTimes(1);
            b.fromPanel('unread', { count: 3 });
            expect(ping).toHaveBeenCalledTimes(2);
        });

        it('does not ping when the sounds feature is off', async () => {
            b.cf('update', { features: { sounds: false } });
            b.fromPanel('unread', { count: 1 });
            expect(ping).not.toHaveBeenCalled();
        });

        it('prefixes the tab title while unread and restores it afterwards', () => {
            document.title = 'My shop';
            b.fromPanel('unread', { count: 3 });
            expect(document.title).toBe('(3) My shop');
            b.fromPanel('unread', { count: 5 });
            expect(document.title).toBe('(5) My shop');
            b.cf('open');
            expect(document.title).toBe('My shop');
        });

        it('does not clobber a title the host page changed in the meantime', () => {
            document.title = 'Page A';
            b.fromPanel('unread', { count: 1 });
            document.title = 'Page B';
            b.fromPanel('unread', { count: 0 });
            expect(document.title).toBe('Page B');
        });

        it('leaves the title alone unless titleBadge is enabled', async () => {
            b.cf('update', { features: { titleBadge: false } });
            document.title = 'Plain';
            b.fromPanel('unread', { count: 4 });
            expect(document.title).toBe('Plain');
        });

        it('opening the panel clears the badge; unread while open is not shown', () => {
            b.fromPanel('unread', { count: 4 });
            b.cf('open');
            expect(b.q('.badge').dataset.show).toBe('false');
            b.fromPanel('unread', { count: 7 });
            expect(b.q('.badge').dataset.show).toBe('false');
            expect(ping).toHaveBeenCalledTimes(1);
        });

        it('clamps absurd or invalid counts', () => {
            b.fromPanel('unread', { count: 1e12 });
            expect(b.q('.badge').textContent).toBe('99+');
            b.fromPanel('unread', { count: -4 });
            expect(b.q('.badge').dataset.show).toBe('false');
            b.fromPanel('unread', { count: 'many' });
            expect(b.q('.badge').dataset.show).toBe('false');
        });

        it('the first gesture on the launcher unlocks audio', () => {
            b.q('button.launcher').dispatchEvent(new Event('pointerdown'));
            expect(unlockSound).toHaveBeenCalledTimes(1);
        });

        it('state messages update getState and sanitise their fields', () => {
            b.fromPanel('state', {
                status: 'queued',
                open: true,
                unread: 2,
                agent: { name: '<b>Sara</b>' },
            });
            expect(b.cf('getState')).toMatchObject({
                status: 'queued',
                unread: 2,
                open: false,
                agent: { name: '<b>Sara</b>' },
            });
            b.fromPanel('state', { status: 'hacked', unread: 0 });
            expect(b.cf('getState')).toMatchObject({ status: 'idle' });
        });
    });

    describe('panel -> host messages', () => {
        let b: Booted;
        beforeEach(async () => {
            b = await boot();
            b.cf('open');
            b.handshake();
        });

        it('close from the panel closes it and emits close', () => {
            const close = vi.fn();
            b.cf('on', 'close', close);
            b.fromPanel('close');
            expect(b.q('.panel').dataset.open).toBe('false');
            expect(close).toHaveBeenCalledTimes(1);
            expect(last(b, 'close')).toBeDefined();
        });

        it('re-dispatches panel events as chatfeature:<name> and to on() handlers', () => {
            const started = vi.fn();
            const dom = vi.fn();
            b.cf('on', 'chat-started', started);
            window.addEventListener('chatfeature:agent-joined', dom);
            b.fromPanel('event', {
                name: 'chat-started',
                data: { category: 'billing' },
            });
            b.fromPanel('event', {
                name: 'agent-joined',
                data: { name: 'Sara' },
            });
            b.fromPanel('event', { name: 'message-sent' });
            expect(started).toHaveBeenCalledWith({ category: 'billing' });
            expect((dom.mock.calls[0][0] as CustomEvent).detail).toEqual({
                name: 'Sara',
            });
            window.removeEventListener('chatfeature:agent-joined', dom);
        });

        it.each([
            'greeting-shown',
            'greeting-dismissed',
            'open',
            'close',
            'ready',
            'error',
            'unread-changed',
            'nonsense',
            5,
        ])('does not let the panel forge the loader-owned event %j', (name) => {
            const spy = vi.fn();
            for (const n of [
                'greeting-shown',
                'greeting-dismissed',
                'open',
                'close',
                'ready',
                'error',
                'unread-changed',
            ]) {
                b.cf('on', n, spy);
            }
            b.fromPanel('event', { name, data: { forged: true } });
            expect(spy).not.toHaveBeenCalled();
        });

        it('forwards panel errors as sanitised error events', () => {
            const err = vi.fn();
            b.cf('on', 'error', err);
            b.fromPanel('error', {
                code: 'send_failed',
                message: 'Could not send',
            });
            b.fromPanel('error', {});
            expect(err).toHaveBeenNthCalledWith(1, {
                code: 'send_failed',
                message: 'Could not send',
            });
            expect(err).toHaveBeenNthCalledWith(2, {
                code: 'panel_error',
                message: '',
            });
        });

        it('ignores unknown message types', () => {
            expect(() => b.fromPanel('totally-new', { x: 1 })).not.toThrow();
        });
    });

    describe('JS API -> panel messages', () => {
        let b: Booted;
        beforeEach(async () => {
            b = await boot({ boot: makeBootCfg({}) });
            b.cf('open');
            b.handshake();
        });

        it('open and close are mirrored to the panel', () => {
            b.cf('close');
            b.cf('open');
            expect(
                types(b).filter((t) => t === 'open' || t === 'close'),
            ).toEqual(['open', 'close', 'open']);
        });

        it("setCategory only accepts the widget's enabled categories", () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            b.cf('setCategory', 'billing');
            b.cf('setCategory', 'admin');
            b.cf('setCategory', { slug: 'sales' });
            expect(
                b
                    .posts()
                    .filter((p) => p.type === 'setCategory')
                    .map((p) => p.payload),
            ).toEqual([{ slug: 'billing' }]);
        });

        it('setCategory respects a categories override that narrowed the set', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            b.cf('update', { categories: ['sales'] });
            b.cf('setCategory', 'billing');
            b.cf('setCategory', 'sales');
            expect(
                b
                    .posts()
                    .filter((p) => p.type === 'setCategory')
                    .map((p) => p.payload),
            ).toEqual([{ slug: 'sales' }]);
        });

        it('startChat opens the panel and forwards a sanitised request', () => {
            b.cf('close');
            b.cf('startChat', {
                category: 'billing',
                message: '  Where is my invoice? \u0000 ',
            });
            expect(b.q('.panel').dataset.open).toBe('true');
            expect(last(b, 'startChat')?.payload).toEqual({
                category: 'billing',
                message: 'Where is my invoice?',
            });
            b.cf('startChat', { category: 'nope', message: 5 });
            expect(last(b, 'startChat')?.payload).toEqual({});
            b.cf('startChat');
            expect(last(b, 'startChat')?.payload).toEqual({});
        });

        it('identify forwards a well-formed signed token and rejects anything else', () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            b.cf(
                'identify',
                'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1',
            );
            expect(last(b, 'identify')?.payload).toEqual({
                token: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig_nature-1',
            });
            const n = types(b).filter((t) => t === 'identify').length;
            b.cf('identify', 'not-a-jwt');
            b.cf('identify', '<script>');
            b.cf('identify', 42);
            b.cf('identify');
            expect(types(b).filter((t) => t === 'identify')).toHaveLength(n);
        });

        it('setVisitor merges fields and forwards the sanitised visitor', () => {
            b.cf('setVisitor', {
                name: 'Ann',
                email: 'ann@example.com',
                extra: 'dropped',
            });
            expect(last(b, 'identify')?.payload).toEqual({
                visitor: { name: 'Ann', email: 'ann@example.com' },
            });
            b.cf('setVisitor', { phone: '+100', meta: { plan: 'pro' } });
            expect(last(b, 'identify')?.payload).toEqual({
                visitor: {
                    name: 'Ann',
                    email: 'ann@example.com',
                    phone: '+100',
                    meta: { plan: 'pro' },
                },
            });
        });

        it('update forwards the merged sanitised overrides without visitor/identity fields', () => {
            b.cf('update', {
                theme: { primary: '#abcdef', radius: 999 },
                launcher: { label: 'Hi' },
                visitor: { name: 'Ann' },
            });
            const u = last(b, 'update')?.payload.overrides as Dict;
            expect(u).toEqual({
                theme: { primary: '#abcdef', radius: 28 },
                launcher: { label: 'Hi' },
            });
            expect(last(b, 'identify')?.payload).toEqual({
                visitor: { name: 'Ann' },
            });
        });

        it('update re-applies the launcher live (label, texts, position)', () => {
            b.cf('close');
            b.cf('update', {
                launcher: { label: 'Talk to us' },
                theme: { position: 'left' },
                texts: { en: { title: 'Help desk' } },
            });
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'Talk to us',
            );
            expect(b.q('.root').dataset.pos).toBe('bottom-left');
            expect(b.iframe()?.title).toBe('Help desk');
            expect(b.q('.panel').getAttribute('aria-label')).toBe('Help desk');
        });

        it('shutdown tells the panel', () => {
            b.cf('shutdown');
            expect(document.querySelector('pne-chat-widget')).toBeNull();
        });
    });

    describe('keyboard and focus', () => {
        it('Escape closes the open panel and returns focus to the launcher', async () => {
            const b = await boot();
            b.cf('open');
            const launcher = b.q<HTMLButtonElement>('button.launcher');
            launcher.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    composed: true,
                }),
            );
            expect(b.q('.panel').dataset.open).toBe('false');
        });

        it('Escape dismisses a visible greeting before anything else', async () => {
            const b = await boot();
            vi.advanceTimersByTime(3000);
            expect(b.shadow.querySelector('.greet')).not.toBeNull();
            const dismissed = vi.fn();
            b.cf('on', 'greeting-dismissed', dismissed);
            b.q('button.launcher').dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    composed: true,
                }),
            );
            expect(dismissed).toHaveBeenCalledWith({
                id: 'g1',
                reason: 'dismissed',
            });
            expect(b.q('.panel').dataset.open).toBe('false');
        });
    });

    describe('greetings', () => {
        it('flips to the agent after delaySeconds, shows the popup and emits greeting-shown', async () => {
            const b = await boot();
            const shown = vi.fn();
            b.cf('on', 'greeting-shown', shown);
            vi.advanceTimersByTime(2999);
            expect(b.shadow.querySelector('.greet')).toBeNull();
            vi.advanceTimersByTime(1);
            expect(b.q('.greet .g-body').textContent).toBe('Hi! Need a hand?');
            expect(b.q('.greet .g-name').textContent).toBe('Sara');
            expect(b.q('.card').dataset.face).toBe('agent');
            expect(shown).toHaveBeenCalledWith({ id: 'g1', agentName: 'Sara' });
        });

        it('uses the launcher avatar when the greeting has no agent, and no flip without any face', async () => {
            const withLauncherAvatar = await boot({
                boot: makeBootCfg(
                    {
                        launcher: {
                            avatarUrl: 'https://cdn.example.com/default.png',
                        },
                    },
                    {
                        greetings: [
                            {
                                id: 'g',
                                body: 'Hello',
                                agentName: null,
                                agentAvatarUrl: null,
                                locale: null,
                                weight: 1,
                            },
                        ],
                    },
                ),
            });
            vi.advanceTimersByTime(3000);
            expect(
                withLauncherAvatar.q<HTMLImageElement>('.back img.av').src,
            ).toBe('https://cdn.example.com/default.png');
            resetGlobals();

            media = mockMatchMedia();
            const bare = await boot({
                boot: makeBootCfg(
                    {},
                    {
                        greetings: [
                            {
                                id: 'g',
                                body: 'Hello',
                                agentName: null,
                                agentAvatarUrl: null,
                                locale: null,
                                weight: 1,
                            },
                        ],
                    },
                ),
            });
            vi.advanceTimersByTime(3000);
            expect(bare.q('.g-body').textContent).toBe('Hello');
            expect(bare.q('.card').dataset.face).toBe('front');
        });

        it('showAgent=false keeps the popup text-only and skips the flip', async () => {
            const b = await boot({
                boot: makeBootCfg({ greetings: { showAgent: false } }),
            });
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body')).not.toBeNull();
            expect(b.q('.g-name')).toBeNull();
            expect(b.q('.card').dataset.face).toBe('front');
        });

        it('clicking the popup opens the chat and counts as "opened", not dismissed', async () => {
            const b = await boot();
            const gone = vi.fn();
            b.cf('on', 'greeting-dismissed', gone);
            vi.advanceTimersByTime(3000);
            b.q('.g-main').click();
            expect(b.q('.panel').dataset.open).toBe('true');
            expect(gone).toHaveBeenCalledWith({ id: 'g1', reason: 'opened' });
            expect(b.q('.card').dataset.face).toBe('front');
        });

        it('auto-hides after autoHideSeconds and flips back', async () => {
            const b = await boot();
            const gone = vi.fn();
            b.cf('on', 'greeting-dismissed', gone);
            vi.advanceTimersByTime(3000 + 20_000);
            expect(gone).toHaveBeenCalledWith({ id: 'g1', reason: 'timeout' });
            expect(b.q('.card').dataset.face).toBe('front');
            vi.advanceTimersByTime(500);
            expect(b.shadow.querySelector('.greet')).toBeNull();
        });

        it('the x dismisses and, with dismissPolicy session, silences later greetings', async () => {
            const b = await boot({
                boot: makeBootCfg({ greetings: { intervalMinutes: 1 } }),
            });
            vi.advanceTimersByTime(3000);
            b.q('.g-x').click();
            vi.advanceTimersByTime(10 * 60_000);
            expect(b.shadow.querySelector('.greet')).toBeNull();
            expect(
                sessionStorage.getItem(`chatfeature:${KEY}:greeting:dismissed`),
            ).not.toBeNull();
        });

        it('is never shown while the panel is open', async () => {
            const b = await boot();
            b.cf('open');
            vi.advanceTimersByTime(3000);
            expect(b.shadow.querySelector('.greet')).toBeNull();
            b.cf('close');
            vi.advanceTimersByTime(30 * 60_000);
            expect(b.shadow.querySelector('.greet')).not.toBeNull();
        });

        it('is never shown while a chat is queued or active, and disappears when one starts', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.cf('close');
            b.fromPanel('state', { status: 'active', unread: 0 });
            vi.advanceTimersByTime(3000);
            expect(b.shadow.querySelector('.greet')).toBeNull();

            b.fromPanel('state', { status: 'ended', unread: 0 });
            vi.advanceTimersByTime(30 * 60_000);
            expect(b.shadow.querySelector('.greet')).not.toBeNull();
            b.fromPanel('state', { status: 'queued', unread: 0 });
            expect(b.q('.greet').dataset.state).toBe('exit');
        });

        it('pauses while the tab is hidden and shows when it becomes visible', async () => {
            setHidden(true);
            const b = await boot();
            vi.advanceTimersByTime(60_000);
            expect(b.shadow.querySelector('.greet')).toBeNull();
            setHidden(false);
            vi.advanceTimersByTime(3000);
            expect(b.shadow.querySelector('.greet')).not.toBeNull();
        });

        it('is not shown while the widget is hidden through the API', async () => {
            const b = await boot();
            b.cf('hide');
            vi.advanceTimersByTime(3000);
            expect(b.shadow.querySelector('.greet')).toBeNull();
        });

        it('can be disabled by the client but never enabled over the dashboard setting', async () => {
            const off = await boot({ script: { 'data-greetings': 'off' } });
            vi.advanceTimersByTime(60_000);
            expect(off.shadow.querySelector('.greet')).toBeNull();
            resetGlobals();

            media = mockMatchMedia();
            const dashboardOff = await boot({
                boot: makeBootCfg({ greetings: { enabled: false } }),
                script: { 'data-greetings': 'on' },
                settings: { greetings: { enabled: true } },
            });
            vi.advanceTimersByTime(60_000);
            expect(dashboardOff.shadow.querySelector('.greet')).toBeNull();
        });

        it('update() restarts the timeline when greeting settings change and hides a visible one when disabled', async () => {
            const b = await boot();
            b.cf('update', { greetings: { delaySeconds: 600 } });
            vi.advanceTimersByTime(599_999);
            expect(b.shadow.querySelector('.greet')).toBeNull();
            vi.advanceTimersByTime(1);
            expect(b.shadow.querySelector('.greet')).not.toBeNull();
            b.cf('update', { greetings: { enabled: false } });
            expect(b.q('.greet').dataset.state).toBe('exit');
        });

        it('honours prefers-reduced-motion live', async () => {
            const b = await boot();
            vi.advanceTimersByTime(3000);
            expect(b.q('.root').dataset.motion).toBe('full');
            media.set('reduced', true);
            expect(b.q('.root').dataset.motion).toBe('reduced');
            media.set('reduced', false);
            expect(b.q('.root').dataset.motion).toBe('full');
        });

        it('starts in reduced-motion mode when the preference is already set', async () => {
            resetGlobals();
            media = mockMatchMedia({ reduced: true });
            const b = await boot();
            expect(b.q('.root').dataset.motion).toBe('reduced');
        });
    });

    describe('theme mode', () => {
        it('auto follows prefers-color-scheme live; light and dark are fixed', async () => {
            resetGlobals();
            media = mockMatchMedia({ dark: false });
            const b = await boot({
                boot: makeBootCfg({ theme: { mode: 'auto' } }),
            });
            expect(b.q('.root').dataset.scheme).toBe('light');
            media.set('dark', true);
            expect(b.q('.root').dataset.scheme).toBe('dark');
            b.cf('update', { theme: { mode: 'light' } });
            expect(b.q('.root').dataset.scheme).toBe('light');
            b.cf('update', { theme: { mode: 'dark' } });
            media.set('dark', false);
            expect(b.q('.root').dataset.scheme).toBe('dark');
        });
    });

    describe('mobile: full screen, scroll lock and viewport messages', () => {
        const fakeVisualViewport = (init: {
            width: number;
            height: number;
            offsetTop?: number;
        }) => {
            const target = new EventTarget() as EventTarget & Dict;
            Object.assign(target, {
                width: init.width,
                height: init.height,
                offsetTop: init.offsetTop ?? 0,
            });
            Object.defineProperty(window, 'visualViewport', {
                value: target,
                configurable: true,
            });

            return target;
        };

        it('goes full screen below 480px, locks host scrolling, and restores everything on close', async () => {
            resetGlobals();
            media = mockMatchMedia({ mobile: true });
            document.documentElement.style.overflow = 'auto';
            const b = await boot();
            b.cf('open');
            expect(b.q('.panel').dataset.mode).toBe('fullscreen');
            expect(b.q('.root').dataset.fullscreen).toBe('true');
            expect(document.documentElement.style.overflow).toBe('hidden');
            expect(document.body.style.overflow).toBe('hidden');
            b.cf('close');
            expect(document.documentElement.style.overflow).toBe('auto');
            expect(document.body.style.overflow).toBe('');
            expect(b.q('.root').dataset.fullscreen).toBe('false');
        });

        it('stays a floating panel on desktop and never locks scrolling', async () => {
            const b = await boot();
            b.cf('open');
            expect(b.q('.panel').dataset.mode).toBe('panel');
            expect(document.documentElement.style.overflow).toBe('');
        });

        it('switches mode live when the viewport crosses the breakpoint while open', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            media.set('mobile', true);
            expect(b.q('.panel').dataset.mode).toBe('fullscreen');
            expect(document.documentElement.style.overflow).toBe('hidden');
            expect(last(b, 'viewport')).toBeDefined();
            media.set('mobile', false);
            expect(b.q('.panel').dataset.mode).toBe('panel');
            expect(document.documentElement.style.overflow).toBe('');
        });

        it('the panel can request fullscreen on desktop with resize, and go back', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.fromPanel('resize', { mode: 'fullscreen' });
            expect(b.q('.panel').dataset.mode).toBe('fullscreen');
            expect(document.documentElement.style.overflow).toBe('hidden');
            b.fromPanel('resize', { mode: 'panel' });
            expect(b.q('.panel').dataset.mode).toBe('panel');
            b.fromPanel('resize', { mode: 'huge' });
            expect(b.q('.panel').dataset.mode).toBe('panel');
        });

        it('forwards visualViewport changes (iOS keyboard) as viewport messages, coalesced and de-duplicated', async () => {
            resetGlobals();
            media = mockMatchMedia({ mobile: true });
            Object.defineProperty(window, 'innerHeight', {
                value: 800,
                configurable: true,
            });
            const vv = fakeVisualViewport({ width: 390, height: 800 });
            const b = await boot();
            b.cf('open');
            b.handshake();
            const count = () =>
                b.posts().filter((p) => p.type === 'viewport').length;
            const before = count();

            vv.height = 500; // keyboard opened
            vv.dispatchEvent(new Event('resize'));
            vv.dispatchEvent(new Event('scroll'));
            vv.dispatchEvent(new Event('resize'));
            vi.advanceTimersByTime(16);
            expect(count()).toBe(before + 1);
            expect(last(b, 'viewport')?.payload).toEqual({
                width: 390,
                height: 500,
                keyboardInset: 300,
            });

            vv.dispatchEvent(new Event('resize')); // nothing changed
            vi.advanceTimersByTime(16);
            expect(count()).toBe(before + 1);

            vv.height = 800;
            vv.dispatchEvent(new Event('resize'));
            vi.advanceTimersByTime(16);
            expect(last(b, 'viewport')?.payload).toEqual({
                width: 390,
                height: 800,
                keyboardInset: 0,
            });
        });

        it('stops listening to the viewport after shutdown', async () => {
            const vv = fakeVisualViewport({ width: 390, height: 800 });
            const remove = vi.spyOn(vv, 'removeEventListener');
            const b = await boot();
            b.cf('shutdown');
            expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
            expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
        });
    });

    describe('RTL and locale', () => {
        it('uses the locale override for direction, texts and the greeting pool', async () => {
            const b = await boot({
                boot: makeBootCfg(
                    {},
                    {
                        greetings: [
                            {
                                id: 'en',
                                body: 'Hello',
                                agentName: null,
                                agentAvatarUrl: null,
                                locale: 'en',
                                weight: 1,
                            },
                            {
                                id: 'ar',
                                body: 'مرحبا',
                                agentName: null,
                                agentAvatarUrl: null,
                                locale: 'ar',
                                weight: 1,
                            },
                        ],
                    },
                ),
                script: { 'data-locale': 'ar' },
            });
            expect(b.q('.root').getAttribute('dir')).toBe('rtl');
            expect(b.q('.panel').getAttribute('aria-label')).toBe('الدعم');
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body').textContent).toBe('مرحبا');
        });
    });
});

function inlineBootAndInstall(boot: Dict): void {
    const g = window as unknown as Dict;
    g.__PNE_CHAT_BOOT__ = { [KEY]: boot };
    const s = document.createElement('script');
    s.src = `${APP}/w/${KEY}.js`;
    document.head.append(s);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    void import('../src/api').then(({ install }) => install(window, s));
}
