import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { install } from '../src/api';
import { ping, unlockSound } from '../src/sound';
import {
    APP,
    KEY,
    boot,
    handles,
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
const PAST = '2000-01-01T00:00:00.000Z';

type Posted = ReturnType<Booted['posts']>[number];

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
            expect(overrides.categories).toEqual(['billing']); // intersected with the boot's, never extended
            expect(overrides.features).toEqual({ rating: false }); // restrict-only: only `false` goes through
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
        it("caps page.title at the server's 255 characters", async () => {
            document.title = 'T'.repeat(400);

            const b = await boot();
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });

            const init = last(b, 'init')?.payload as Dict;

            expect((init.page as Dict).title).toBe('T'.repeat(255));
        });

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
            ).toEqual({ token: 'vt_1', expiresAt: FUTURE, id: 'anonymous' });
            b.fromPanel('session', null);
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        });

        it('compare-and-clear: a drop removes the stored session only while it still holds that token, else answers with the stored one', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.fromPanel('session', { token: 'vt_1', expiresAt: FUTURE });

            // another tab of the page rotated the session in the meantime
            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify({
                    token: 'vt_2',
                    expiresAt: FUTURE,
                    id: 'anonymous',
                }),
            );
            b.fromPanel('session', { drop: 'vt_1' });
            expect(
                JSON.parse(localStorage.getItem(SESSION_KEY) ?? '{}').token,
            ).toBe('vt_2');
            expect(b.posts().filter((m) => m.type === 'session')).toEqual([
                {
                    type: 'session',
                    payload: { token: 'vt_2', expiresAt: FUTURE },
                    id: undefined,
                    origin: APP,
                },
            ]);

            // the stored session IS the refused one: gone for good, and the panel is told so
            b.fromPanel('session', { drop: 'vt_2' });
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
            expect(
                b
                    .posts()
                    .filter((m) => m.type === 'session')
                    .at(-1),
            ).toMatchObject({
                payload: {},
            });

            // nothing stored at all: also cleared, also answered
            b.fromPanel('session', { drop: 'vt_3' });
            expect(b.posts().filter((m) => m.type === 'session')).toHaveLength(
                3,
            );
        });

        it('a drop with an expired entry stored just removes it and answers cleared', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify({
                    token: 'vt_x',
                    expiresAt: PAST,
                    id: 'anonymous',
                }),
            );
            b.fromPanel('session', { drop: 'vt_1' });
            // an expired entry is no session: it is removed and the panel hears "cleared"
            expect(localStorage.getItem(SESSION_KEY)).toBeNull();
            expect(
                b
                    .posts()
                    .filter((m) => m.type === 'session')
                    .at(-1),
            ).toMatchObject({
                payload: {},
            });
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

        it('rejects oversized tokens, non-string tokens and sessions without a valid expiry', async () => {
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
            // the message preview stays inside the loader unless the host opted in (see 'host-visible data')
            expect(changed).toHaveBeenCalledWith({
                count: 2,
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
            vi.mocked(unlockSound).mockClear();
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
            b.handshake();
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

        it('measures the keyboard in layout pixels: pinch-zoom alone is not a keyboard', async () => {
            resetGlobals();
            media = mockMatchMedia({ mobile: true });
            Object.defineProperty(window, 'innerHeight', {
                value: 800,
                configurable: true,
            });
            const vv = fakeVisualViewport({ width: 195, height: 400 });
            Object.assign(vv, { scale: 2 }); // zoomed in 2x: half the layout viewport is visible
            const b = await boot();
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });
            const init = last(b, 'init');
            expect(
                ((init as Posted).payload.viewport as Dict).keyboardInset,
            ).toBe(0);
            b.fromPanel('init:result', {}, init?.id);

            Object.assign(vv, { scale: 1 }); // same numbers without zoom really are a 400 px keyboard
            vv.dispatchEvent(new Event('resize'));
            vi.advanceTimersByTime(16);
            expect(last(b, 'viewport')?.payload).toMatchObject({
                keyboardInset: 400,
            });

            Object.assign(vv, { scale: 2, height: 300 }); // zoomed *and* a keyboard: 800 - 300 * 2
            vv.dispatchEvent(new Event('resize'));
            vi.advanceTimersByTime(16);
            expect(last(b, 'viewport')?.payload).toMatchObject({
                keyboardInset: 200,
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

    describe('a panel that does not answer cannot trap the visitor (mobile full screen included)', () => {
        const mobile = async () => {
            resetGlobals();
            media = mockMatchMedia({ mobile: true });
            document.documentElement.style.overflow = 'auto';

            return boot();
        };

        it('keeps the launcher on top as the close button until the panel has answered, then hands over', async () => {
            const b = await mobile();
            b.cf('open');
            expect(b.q('.panel').dataset.mode).toBe('fullscreen');
            expect(b.q('.root').dataset.fullscreen).toBe('false'); // launcher still visible
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'Close chat',
            );
            b.q('button.launcher').click(); // the loader-owned way out
            expect(b.q('.panel').dataset.open).toBe('false');
            expect(document.documentElement.style.overflow).toBe('auto');

            b.cf('open');
            b.handshake();
            expect(b.q('.root').dataset.fullscreen).toBe('true'); // the panel has its own close button now
        });

        it('keeps the launcher above the panel in the stylesheet', () => {
            const css = readFileSync(
                resolvePath(__dirname, '../src/styles.css'),
                'utf8',
            );
            expect(/\.dock\s*{[^}]*z-index:\s*1/.test(css)).toBe(true);
            expect(/\.panel\s*{[^}]*z-index/.test(css)).toBe(false);
        });

        it.each([
            ['ready_timeout', false],
            ['init_timeout', true],
        ])(
            'closes a full-screen panel whose handshake fails (%s) after 10 s and unlocks scrolling',
            async (code, ready) => {
                const b = await mobile();
                const errors: Dict[] = [];
                const closed = vi.fn();
                b.cf('on', 'error', (e: Dict) => errors.push(e));
                b.cf('on', 'close', closed);
                b.cf('open');

                if (ready) {
                    b.fromPanel('ready', { protocol: 1 }); // alive but never acknowledges init
                }

                expect(document.documentElement.style.overflow).toBe('hidden');
                await vi.advanceTimersByTimeAsync(10_000);

                expect(errors.map((e) => e.code)).toEqual([code]);
                expect(closed).toHaveBeenCalledTimes(1);
                expect(b.q('.panel').dataset.open).toBe('false');
                expect(document.documentElement.style.overflow).toBe('auto');
                expect(document.body.style.overflow).toBe('');
                expect(b.iframe()).toBeNull(); // thrown away: the next open starts from scratch
                expect(b.cf('getState')).toMatchObject({
                    open: false,
                    status: 'idle',
                });
            },
        );

        it('retries from scratch on the next open', async () => {
            const b = await mobile();
            b.cf('open');
            await vi.advanceTimersByTimeAsync(10_000);
            expect(b.iframe()).toBeNull();

            b.cf('open');
            const frame = b.iframe();
            expect(frame).not.toBeNull();
            b.handshake();
            expect(b.cf('getState')).toMatchObject({
                open: true,
                panelReady: true,
            });
            await vi.advanceTimersByTimeAsync(30_000);
            expect(b.q('.panel').dataset.open).toBe('true'); // answered: no timeout
            expect(b.iframe()).toBe(frame);
        });

        it('a closed panel that boots in the background and fails is just dropped', async () => {
            localStorage.setItem(
                SESSION_KEY,
                JSON.stringify({ token: 'vt_1', expiresAt: FUTURE }),
            );
            const b = await boot();
            expect(b.iframe()).not.toBeNull();
            await vi.advanceTimersByTimeAsync(10_000);
            expect(b.iframe()).toBeNull();
            expect(() => b.cf('open')).not.toThrow();
            expect(b.iframe()).not.toBeNull();
        });

        const esc = (
            target: EventTarget = document,
            init: KeyboardEventInit = {},
        ) =>
            target.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Escape',
                    bubbles: true,
                    cancelable: true,
                    ...init,
                }),
            );

        it('Escape on the host document closes an open panel, wherever focus is', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            esc(document.body);
            expect(b.q('.panel').dataset.open).toBe('false');
            expect(b.cf('getState')).toMatchObject({ open: false });

            b.cf('open');
            esc(document);
            expect(b.q('.panel').dataset.open).toBe('false');
        });

        it('Escape closes a full-screen panel and unlocks scrolling', async () => {
            const b = await mobile();
            b.cf('open');
            b.handshake();
            esc(document.body);
            expect(b.q('.panel').dataset.open).toBe('false');
            expect(document.documentElement.style.overflow).toBe('auto');
        });

        it('ignores other keys, and an Escape the host page already handled', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            esc(document.body, { key: 'Enter' });
            expect(b.q('.panel').dataset.open).toBe('true');
            document.body.addEventListener(
                'keydown',
                (e) => e.preventDefault(),
                { once: true },
            );
            esc(document.body);
            expect(b.q('.panel').dataset.open).toBe('true');
            esc(document.body);
            expect(b.q('.panel').dataset.open).toBe('false');
        });

        it('does nothing while the panel is closed and stops listening after shutdown', async () => {
            const close = vi.fn();
            const b = await boot();
            b.cf('on', 'close', close);
            esc(document.body);
            expect(close).not.toHaveBeenCalled();
            b.cf('open');
            b.cf('shutdown');
            esc(document.body);
            expect(close).not.toHaveBeenCalled();
        });
    });

    describe('host-visible data: events and DOM events carry metadata only', () => {
        const message = {
            conversationId: 'c_01',
            messageId: 'm_01',
            body: 'Your OTP is 481516',
            text: 'also secret',
            message: 'x',
            preview: 'Your OTP is 481516',
            comment: 'great service, call me on 555-0100',
            password: 'hunter2',
            email: 'visitor@example.com',
            nested: { a: 1 },
            list: [1],
            at: 1_700_000_000,
            count: 3,
            rating: 5,
            name: 'Sara',
            agent: {
                name: 'Sara',
                email: 'sara@example.com',
                avatarUrl: 'https://x.example/a.png',
            },
        };
        const safe = {
            conversationId: 'c_01',
            messageId: 'm_01',
            at: 1_700_000_000,
            count: 3,
            rating: 5,
            name: 'Sara',
            agent: { name: 'Sara' },
        };
        const open = async (settings?: Dict) => {
            const b = await boot(settings === undefined ? {} : { settings });
            b.cf('open');
            b.handshake();

            return b;
        };

        it('drops message bodies, previews and every unknown field by default', async () => {
            const b = await open();
            const got = vi.fn();
            b.cf('on', 'message-received', got);
            b.fromPanel('event', { name: 'message-received', data: message });
            expect(got).toHaveBeenCalledTimes(1);
            expect(got.mock.calls[0][0]).toEqual(safe);
            expect(JSON.stringify(got.mock.calls[0][0])).not.toMatch(
                /481516|hunter2|visitor@|555-0100/,
            );
        });

        it('applies to every forwarded event name', async () => {
            const b = await open();
            const seen: Dict[] = [];

            for (const name of [
                'chat-started',
                'chat-ended',
                'agent-joined',
                'message-sent',
                'message-received',
                'rating-submitted',
            ]) {
                b.cf('on', name, (d: Dict) => seen.push(d));
                b.fromPanel('event', { name, data: message });
            }

            expect(seen).toHaveLength(6);
            for (const d of seen) {
                expect(d).toEqual(safe);
            }
        });

        it('types and caps what it keeps', async () => {
            const b = await open();
            const got = vi.fn();
            b.cf('on', 'chat-started', got);
            b.fromPanel('event', {
                name: 'chat-started',
                data: {
                    conversationId: 'c'.repeat(500),
                    messageId: { evil: true },
                    count: Number.NaN,
                    rating: Infinity,
                    at: '2026-10-01T00:00:00Z‮',
                    reason: ['x'],
                    agent: { name: 5 },
                },
            });
            expect(got.mock.calls[0][0]).toEqual({
                conversationId: 'c'.repeat(100),
                at: '2026-10-01T00:00:00Z',
            });
            b.fromPanel('event', {
                name: 'chat-started',
                data: 'not an object',
            });
            b.fromPanel('event', { name: 'chat-started' });
            expect(got.mock.calls[1][0]).toEqual({});
            expect(got.mock.calls[2][0]).toEqual({});
        });

        it('unread-changed never carries the preview, only count and the agent name', async () => {
            const b = await open();
            b.cf('close');
            const changed = vi.fn();
            const dom = vi.fn();
            b.cf('on', 'unread-changed', changed);
            document.addEventListener('chatfeature:unread-changed', dom);
            b.fromPanel('unread', {
                count: 1,
                preview: 'Your OTP is 481516',
                agent: { name: 'Sara', email: 's@x' },
            });
            expect(changed).toHaveBeenCalledWith({
                count: 1,
                agent: { name: 'Sara' },
            });
            expect((dom.mock.calls[0][0] as CustomEvent).detail).toEqual({
                count: 1,
                agent: { name: 'Sara' },
            });
            document.removeEventListener('chatfeature:unread-changed', dom);
        });

        it('lets the host opt in to message text with exposeMessageContent (bounded, still typed)', async () => {
            const b = await open({ exposeMessageContent: true });
            b.cf('close');
            const got = vi.fn();
            const changed = vi.fn();
            b.cf('on', 'message-received', got);
            b.cf('on', 'unread-changed', changed);
            b.fromPanel('event', {
                name: 'message-received',
                data: { ...message, body: `line 1\nline 2${'x'.repeat(5000)}` },
            });
            const d = got.mock.calls[0][0] as Dict;
            expect(d).toMatchObject({
                ...safe,
                text: 'also secret',
                message: 'x',
                preview: 'Your OTP is 481516',
            });
            expect((d.body as string).startsWith('line 1\nline 2')).toBe(true);
            expect(d.body as string).toHaveLength(2000);
            expect(d).not.toHaveProperty('password');
            expect(d).not.toHaveProperty('email');
            expect(d).not.toHaveProperty('nested');
            b.fromPanel('unread', { count: 1, preview: 'Your OTP is 481516' });
            expect(changed).toHaveBeenCalledWith({
                count: 1,
                preview: 'Your OTP is 481516',
            });
        });

        it('cannot be switched on after boot by update() or a later init() (e.g. from a third-party tag)', async () => {
            const b = await open();
            b.cf('close');
            b.cf('update', { exposeMessageContent: true });
            b.cf('init', { exposeMessageContent: true });
            const changed = vi.fn();
            const got = vi.fn();
            b.cf('on', 'unread-changed', changed);
            b.cf('on', 'message-received', got);
            b.fromPanel('unread', { count: 1, preview: 'secret' });
            b.fromPanel('event', {
                name: 'message-received',
                data: { body: 'secret' },
            });
            expect(changed).toHaveBeenCalledWith({ count: 1 });
            expect(got).toHaveBeenCalledWith({});
            expect(JSON.stringify(last(b, 'update') ?? {})).not.toContain(
                'exposeMessageContent',
            );
            b.fromPanel('ready', { protocol: 1 });
            expect(
                JSON.stringify(last(b, 'init')?.payload ?? {}),
            ).not.toContain('exposeMessageContent');
        });

        it('honours exposeMessageContent from the boot-time settings, a pre-boot init or the stub queue', async () => {
            const check = (b: Booted) => {
                b.cf('open');
                b.handshake();
                b.cf('close');
                const changed = vi.fn();
                b.cf('on', 'unread-changed', changed);
                b.fromPanel('unread', { count: 2, preview: 'hello' });
                expect(changed).toHaveBeenCalledWith({
                    count: 2,
                    preview: 'hello',
                });
            };

            check(await open({ exposeMessageContent: true }));
            resetGlobals();
            media = mockMatchMedia();

            inlineBootEarly();
            const cf = install(window, makeScriptEl()) as ChatFeatureLike;
            cf('init', { exposeMessageContent: true }); // before the async boot finished
            await vi.advanceTimersByTimeAsync(0);
            check(handles(cf as never));
            resetGlobals();
            media = mockMatchMedia();

            inlineBootEarly();
            (window as unknown as Dict).ChatFeature = {
                q: [['init', { exposeMessageContent: true }]],
            };
            const queued = install(window, makeScriptEl()) as ChatFeatureLike;
            await vi.advanceTimersByTimeAsync(0);
            check(handles(queued as never));
        });

        it('dispatches DOM CustomEvents that do not bubble and are not composed', async () => {
            const b = await open();
            const onDocument = vi.fn();
            const onWindow = vi.fn();
            const onRoot = vi.fn();
            const onBody = vi.fn();
            document.addEventListener('chatfeature:chat-started', onDocument);
            window.addEventListener('chatfeature:chat-started', onWindow);
            document.documentElement.addEventListener(
                'chatfeature:chat-started',
                onRoot,
            );
            document.body.addEventListener('chatfeature:chat-started', onBody);
            b.fromPanel('event', {
                name: 'chat-started',
                data: { conversationId: 'c_1', body: 'secret' },
            });

            expect(onDocument).toHaveBeenCalledTimes(1);
            expect(onWindow).toHaveBeenCalledTimes(1);
            expect(onRoot).not.toHaveBeenCalled();
            expect(onBody).not.toHaveBeenCalled();
            const e = onDocument.mock.calls[0][0] as CustomEvent;
            expect(e.bubbles).toBe(false);
            expect(e.composed).toBe(false);
            expect(e.cancelable).toBe(false);
            expect(e.detail).toEqual({ conversationId: 'c_1' });
            document.removeEventListener(
                'chatfeature:chat-started',
                onDocument,
            );
            window.removeEventListener('chatfeature:chat-started', onWindow);
            document.documentElement.removeEventListener(
                'chatfeature:chat-started',
                onRoot,
            );
            document.body.removeEventListener(
                'chatfeature:chat-started',
                onBody,
            );
        });

        it("keeps forwarding sanitised panel errors (code and message are the panel's own diagnostics)", async () => {
            const b = await open();
            const err = vi.fn();
            b.cf('on', 'error', err);
            b.fromPanel('error', {
                code: 'send_failed',
                message: 'Could not send',
                body: 'secret',
            });
            expect(err).toHaveBeenCalledWith({
                code: 'send_failed',
                message: 'Could not send',
            });
        });
    });

    describe('the visitor session belongs to one identity', () => {
        const b64 = (o: unknown) =>
            btoa(JSON.stringify(o))
                .replace(/\+/g, '-')
                .replace(/\//g, '_')
                .replace(/=+$/, '');
        const jwt = (sub: string | number, extra: Dict = {}) =>
            `${b64({ alg: 'HS256' })}.${b64({ sub, ...extra })}.sig_nature-1`;
        const stored = () =>
            JSON.parse(
                localStorage.getItem(SESSION_KEY) ?? 'null',
            ) as Dict | null;
        const session = { token: 'vt_secret', expiresAt: FUTURE };
        const startAs = async (identity: Dict, seed?: Dict | null) => {
            if (seed !== undefined && seed !== null) {
                localStorage.setItem(SESSION_KEY, JSON.stringify(seed));
            }

            return boot({ settings: identity });
        };
        const idOf = async (identity: Dict) => {
            const b = await boot({ settings: identity });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            const id = (stored() as Dict).id as string;
            b.cf('shutdown');
            resetGlobals();
            media = mockMatchMedia();

            return id;
        };

        it('stores a fingerprint of the identity next to the token, never the identity itself', async () => {
            const id = await idOf({ identityToken: jwt('user-42') });
            expect(id).not.toBe('anonymous');
            expect(id).not.toContain('user-42');
            expect(
                await idOf({
                    identityToken: jwt('user-42', { iat: 1, exp: 99 }),
                }),
            ).toBe(id); // a fresh token for the same sub
            expect(await idOf({ identityToken: jwt('user-43') })).not.toBe(id);
            expect(await idOf({})).toBe('anonymous');
            expect(await idOf({ visitor: { name: 'Ann' } })).toBe('anonymous');
            expect(
                await idOf({ visitor: { email: 'a@example.com' } }),
            ).not.toBe('anonymous');
        });

        it('hands the session back to the identity it was created for', async () => {
            const id = await idOf({ identityToken: jwt('u1') });
            resetGlobals();
            media = mockMatchMedia();
            const b = await startAs(
                { identityToken: jwt('u1', { iat: 5 }) },
                { ...session, id },
            );
            expect(b.iframe()).not.toBeNull(); // boots in the background to receive replies
            b.fromPanel('ready', { protocol: 1 });
            expect((last(b, 'init')?.payload ?? {}).visitorSession).toEqual(
                session,
            );
        });

        it.each([
            ['another user', { identityToken: jwt('u2') }],
            ['an anonymous visitor', {}],
            [
                'an unsigned visitor with an email',
                { visitor: { email: 'x@example.com' } },
            ],
        ])(
            'never sends a session that belongs to someone else (%s) and deletes it',
            async (_, identity) => {
                const id = await idOf({ identityToken: jwt('u1') });
                resetGlobals();
                media = mockMatchMedia();
                const b = await startAs(identity, { ...session, id });
                expect(stored()).toBeNull();
                expect(b.iframe()).toBeNull();
                b.cf('open');
                b.fromPanel('ready', { protocol: 1 });
                expect(last(b, 'init')?.payload).not.toHaveProperty(
                    'visitorSession',
                );
            },
        );

        it('a session stored by an older loader (no id) counts as anonymous', async () => {
            const anon = await startAs({}, session);
            anon.fromPanel('ready', { protocol: 1 });
            expect(stored()).toEqual(session);
            expect(anon.iframe()).not.toBeNull();
            resetGlobals();
            media = mockMatchMedia();

            const identified = await startAs(
                { identityToken: jwt('u1') },
                session,
            );
            expect(stored()).toBeNull();
            expect(identified.iframe()).toBeNull();
        });

        it('an expired session is deleted on read, whoever asks', async () => {
            const b = await startAs(
                {},
                {
                    token: 'vt_old',
                    expiresAt: '2000-01-01T00:00:00Z',
                    id: 'anonymous',
                },
            );
            expect(stored()).toBeNull();
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });
            expect(last(b, 'init')?.payload).not.toHaveProperty(
                'visitorSession',
            );
        });

        it('identify() with another user wipes the stored session and starts a fresh panel', async () => {
            const b = await startAs({ identityToken: jwt('u1') });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            const first = b.iframe();
            expect(stored()).not.toBeNull();

            b.cf('identify', jwt('u1', { iat: 99 })); // same sub: nothing changes
            expect(stored()).not.toBeNull();
            expect(b.iframe()).toBe(first);

            b.cf('identify', jwt('u2'));
            expect(stored()).toBeNull();
            expect(b.iframe()).not.toBe(first); // the old identity's panel (and its in-memory session) is gone
            expect(b.cf('getState')).toMatchObject({ open: true });
            b.fromPanel('ready', { protocol: 1 });
            const init = last(b, 'init')?.payload as Dict;
            expect(init).not.toHaveProperty('visitorSession');
            expect(init.identityToken).toBe(jwt('u2'));
        });

        it('update() with a new identity token behaves the same', async () => {
            const b = await startAs({ identityToken: jwt('u1') });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            b.cf('update', { identityToken: jwt('u2') });
            expect(stored()).toBeNull();
        });

        it('a later init() with another identity is treated the same', async () => {
            const b = await startAs({ identityToken: jwt('u1') });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            b.cf('init', { identityToken: jwt('u9') });
            expect(stored()).toBeNull();
        });

        it('setVisitor() with a different email wipes the session; other fields do not', async () => {
            const b = await startAs({ visitor: { email: 'a@example.com' } });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            b.cf('setVisitor', {
                name: 'Ann',
                phone: '+100',
                meta: { plan: 'pro' },
            });
            expect(stored()).not.toBeNull();
            b.cf('setVisitor', { email: 'a@example.com' });
            expect(stored()).not.toBeNull();
            b.cf('setVisitor', { email: 'b@example.com' });
            expect(stored()).toBeNull();
        });

        it('a closed panel is only rebuilt on the next open', async () => {
            const b = await startAs({ identityToken: jwt('u1') });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            b.cf('close');
            b.cf('identify', jwt('u2'));
            expect(b.iframe()).toBeNull();
            b.cf('open');
            expect(b.iframe()).not.toBeNull();
        });

        it('an identity token without a readable sub falls back to the unsigned email, then anonymous', async () => {
            const noSub = `${b64({ alg: 'x' })}.${b64({ name: 'x' })}.sig`;
            expect(await idOf({ identityToken: noSub })).toBe('anonymous');
            expect(
                await idOf({
                    identityToken: 'a.b.c',
                    visitor: { email: 'a@example.com' },
                }),
            ).not.toBe('anonymous');
        });

        it('keeps working without localStorage (memory fallback is bound to the identity too)', async () => {
            vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
                throw new DOMException('quota', 'QuotaExceededError');
            });
            vi.spyOn(Storage.prototype, 'getItem').mockImplementation(
                () => null,
            );
            const b = await startAs({ identityToken: jwt('u1') });
            b.cf('open');
            b.handshake();
            b.fromPanel('session', session);
            b.fromPanel('ready', { protocol: 1 });
            expect((last(b, 'init')?.payload ?? {}).visitorSession).toEqual(
                session,
            );
            b.cf('identify', jwt('u2'));
            b.fromPanel('ready', { protocol: 1 });
            expect(last(b, 'init')?.payload).not.toHaveProperty(
                'visitorSession',
            );
        });
    });

    describe('what the panel receives', () => {
        it('gets overrides with the restriction rule already applied', async () => {
            const b = await boot({
                boot: makeBootCfg({
                    features: { attachments: false, poweredBy: true },
                }),
                settings: {
                    features: {
                        attachments: true,
                        poweredBy: false,
                        rating: false,
                        sounds: true,
                        titleBadge: false,
                        preChat: true,
                    },
                    categories: ['sales', 'nope', 'secret'],
                    greetings: { delaySeconds: 9, enabled: true },
                    theme: { primary: '#112233' },
                    launcher: { label: 'Hi' },
                    texts: { en: { title: 'Help' } },
                    locale: 'en',
                    routing: { queueTimeoutSeconds: 1 },
                    domains: ['evil.example'],
                },
            });
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });
            const overrides = (last(b, 'init')?.payload ?? {})
                .overrides as Dict;
            expect(overrides).toEqual({
                locale: 'en',
                theme: { primary: '#112233' },
                launcher: { label: 'Hi' },
                texts: { en: { title: 'Help' } },
                features: {
                    poweredBy: false,
                    rating: false,
                    sounds: true,
                    titleBadge: false,
                }, // `true` for restrict-only features never travels
                categories: ['sales'], // intersected with the boot's
            });
        });

        it('drops a category override that matches nothing instead of forwarding junk', async () => {
            const b = await boot({ settings: { categories: ['nope'] } });
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });
            const overrides = (last(b, 'init')?.payload ?? {})
                .overrides as Dict;
            expect(overrides.categories).toEqual(['billing', 'sales', 'tech']); // the effective set, i.e. all of them
        });

        it('forwards a rebuilt boot, never the object the host page handed over', async () => {
            const raw = makeBoot({
                routing: { waves: [] },
                identity_secret: 'topsecret',
                api: {
                    base: 'https://evil.example/api',
                    embed: `${APP}/embed/${KEY}`,
                    appOrigin: APP,
                },
                config: {
                    session: { idleTimeoutMinutes: 1 },
                    domains: ['x.example'],
                },
            });
            const b = await boot({ boot: raw });
            b.cf('open');
            b.fromPanel('ready', { protocol: 1 });
            const p = (last(b, 'init')?.payload ?? {}).boot as Dict;
            expect(p.key).toBe(KEY);
            expect(p.api).toEqual({
                base: `${APP}/api/v1/public`,
                embed: `${APP}/embed/${KEY}`,
                appOrigin: APP,
            });
            expect(p).not.toBe(raw);
            expect(p).not.toHaveProperty('routing');
            expect(p).not.toHaveProperty('identity_secret');
            expect(p.config).not.toHaveProperty('session');
            expect(p.config).not.toHaveProperty('domains');
            expect(JSON.stringify(p)).not.toMatch(/evil\.example|topsecret/);
            expect(p.availability).toEqual({
                online: true,
                openNow: true,
                nextOpenAt: null,
            });
        });
    });

    describe('a boot config the host page can write is not trusted blindly', () => {
        const evilBoot = (): Dict =>
            makeBoot({
                api: {
                    embed: 'https://evil.example/embed/' + KEY,
                    appOrigin: 'https://evil.example',
                },
            });

        it('never loads or messages an app origin other than the one the loader came from', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const fetchSpy = vi.fn().mockResolvedValue({
                ok: true,
                json: () => Promise.resolve({ data: makeBoot() }),
            });
            vi.stubGlobal('fetch', fetchSpy);
            const b = await boot({ boot: evilBoot() });
            // the hostile inline config was discarded; the real one was fetched from the script's own origin
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            expect((fetchSpy.mock.calls[0] as string[])[0]).toBe(
                `${APP}/api/v1/public/widgets/${KEY}/config?locale=en-US`,
            );
            b.cf('open');
            expect(b.iframe()?.getAttribute('src')).toBe(`${APP}/embed/${KEY}`);
            b.handshake();
            expect(b.posts().every((p) => p.origin === APP)).toBe(true);
            vi.unstubAllGlobals();
        });

        it('mounts nothing (and sends nothing anywhere) when only the hostile config is available', async () => {
            vi.stubGlobal(
                'fetch',
                vi.fn().mockRejectedValue(new TypeError('offline')),
            );
            const errors: Dict[] = [];
            inlineBootEarly(evilBoot());
            const cf = install(window, makeScriptEl()) as ChatFeatureLike;
            cf('on', 'error', (e: Dict) => errors.push(e));
            await vi.advanceTimersByTimeAsync(0);
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            expect(document.querySelector('iframe')).toBeNull();
            expect(errors.map((e) => e.code)).toEqual(['config_failed']);
            vi.unstubAllGlobals();
        });
    });

    describe('audio is unlocked by every way of opening the chat', () => {
        it('a greeting click, API open() and toggle() unlock it; a silent openOnLoad does not', async () => {
            const b = await boot();
            vi.mocked(unlockSound).mockClear();
            vi.advanceTimersByTime(3000);
            b.q('.g-main').click();
            expect(unlockSound).toHaveBeenCalledTimes(1);

            b.cf('close');
            b.cf('open');
            expect(unlockSound).toHaveBeenCalledTimes(2);
            b.cf('toggle');
            b.cf('toggle');
            expect(unlockSound).toHaveBeenCalledTimes(3);
            b.cf('startChat', {}); // already open: nothing to unlock
            expect(unlockSound).toHaveBeenCalledTimes(3);
            b.cf('close');
            b.cf('startChat', {});
            expect(unlockSound).toHaveBeenCalledTimes(4);
        });

        it('openOnLoad opens without a gesture, so it does not touch the audio context', async () => {
            vi.mocked(unlockSound).mockClear();
            const b = await boot({ script: { 'data-open-on-load': 'true' } });
            expect(b.q('.panel').dataset.open).toBe('true');
            expect(unlockSound).not.toHaveBeenCalled();
        });
    });

    describe('locale and direction in a real boot', () => {
        const withLanguages = (...langs: string[]) =>
            vi
                .spyOn(window.navigator, 'languages', 'get')
                .mockReturnValue(langs);
        const englishOnly = (extra: Dict = {}) =>
            makeBootCfg(
                { texts: { en: { title: 'Support' }, ar: undefined } },
                extra,
            );

        it('an Arabic browser on an English-only widget gets left-to-right English, not RTL chrome', async () => {
            withLanguages('ar-SA', 'ar');
            const b = await boot({ boot: englishOnly() });
            expect(b.q('.root').getAttribute('dir')).toBe('ltr');
            expect(b.q('.panel').getAttribute('aria-label')).toBe('Support');
        });

        it('...but with Arabic texts it is right-to-left, in Arabic', async () => {
            withLanguages('ar-SA');
            const b = await boot();
            expect(b.q('.root').getAttribute('dir')).toBe('rtl');
            expect(b.q('.panel').getAttribute('aria-label')).toBe('الدعم');
        });

        it('a French visitor on a widget whose greetings are all tagged en still gets a greeting', async () => {
            withLanguages('fr-FR');
            const b = await boot({
                boot: englishOnly({
                    greetings: [
                        {
                            id: 'en1',
                            body: 'Hello there',
                            agentName: null,
                            agentAvatarUrl: null,
                            locale: 'en',
                            weight: 1,
                        },
                    ],
                }),
            });
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body').textContent).toBe('Hello there');
        });

        it('an explicit locale with no greetings of its own falls back to the default-locale ones', async () => {
            const b = await boot({
                boot: englishOnly({
                    greetings: [
                        {
                            id: 'en1',
                            body: 'Hello there',
                            agentName: null,
                            agentAvatarUrl: null,
                            locale: 'en',
                            weight: 1,
                        },
                    ],
                }),
                script: { 'data-locale': 'fr' },
            });
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body').textContent).toBe('Hello there');
        });

        it('localises the launcher label, the close label, the unread text and the dismiss label from texts', async () => {
            const b = await boot({
                boot: makeBootCfg({
                    launcher: { style: 'pill', label: 'Chat with us' },
                    texts: {
                        en: { title: 'Support' },
                        ar: {
                            title: 'الدعم',
                            launcherLabel: 'تحدث معنا',
                            closeChat: 'إغلاق الدردشة',
                            unread: 'رسائل غير مقروءة',
                            dismiss: 'إخفاء',
                        },
                    },
                }),
                script: { 'data-locale': 'ar' },
            });
            expect(b.q('.lbl').textContent).toBe('تحدث معنا');
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'تحدث معنا',
            );
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-x').getAttribute('aria-label')).toBe('إخفاء');
            b.cf('open');
            b.handshake();
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'إغلاق الدردشة',
            );
            b.cf('close');
            b.fromPanel('unread', { count: 2 });
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'تحدث معنا, 2 رسائل غير مقروءة',
            );
        });

        it('keeps the English fallbacks when the texts block has none of these keys', async () => {
            const b = await boot({
                boot: makeBootCfg({
                    texts: { en: { title: 'Support' }, ar: undefined },
                }),
            });
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-x').getAttribute('aria-label')).toBe('Dismiss');
            b.cf('open');
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'Close chat',
            );
            b.cf('close');
            b.fromPanel('unread', { count: 1 });
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'Chat with us, 1 unread messages',
            );
        });
    });

    describe('input handling at the public API', () => {
        it('startChat keeps line breaks in the message but strips control and bidi characters', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.cf('startChat', { message: '  Hi,\r\nI need‮ help\u0000 now ⁧' });
            expect(last(b, 'startChat')?.payload).toEqual({
                message: 'Hi,\nI need help  now',
            });
        });

        it('greeting text keeps its line breaks (rendered as text, pre-wrap)', async () => {
            const b = await boot({
                boot: makeBoot({
                    greetings: [
                        {
                            id: 'g',
                            body: 'Line one\nLine two‮',
                            agentName: 'Sara‮',
                            agentAvatarUrl: null,
                            locale: null,
                            weight: 1,
                        },
                    ],
                }),
            });
            vi.advanceTimersByTime(3000);
            expect(b.q('.g-body').textContent).toBe('Line one\nLine two');
            expect(b.q('.g-name').textContent).toBe('Sara');
        });

        it('setVisitor replaces meta instead of merging it, and update() does too', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            b.cf('setVisitor', {
                name: 'Ann',
                meta: { plan: 'pro', ssn: '123' },
            });
            b.cf('setVisitor', { meta: { plan: 'free' } });
            expect(last(b, 'identify')?.payload).toEqual({
                visitor: { name: 'Ann', meta: { plan: 'free' } },
            });
            b.cf('update', { visitor: { meta: { tier: 1 } } });
            expect(last(b, 'identify')?.payload).toEqual({
                visitor: { name: 'Ann', meta: { tier: 1 } },
            });
            b.cf('identify', {
                token: 'aa.bb.cc',
                visitor: { meta: { a: true } },
            });
            expect(last(b, 'identify')?.payload).toEqual({
                token: 'aa.bb.cc',
                visitor: { name: 'Ann', meta: { a: true } },
            });
        });

        it('a later layer replaces meta from an earlier one (settings -> init -> update)', async () => {
            const b = await boot({
                settings: {
                    visitor: { name: 'Ann', meta: { plan: 'pro', old: 1 } },
                },
            });
            b.cf('open');
            b.cf('init', { visitor: { meta: { plan: 'team' } } });
            b.cf('setVisitor', { email: 'a@example.com' });
            b.fromPanel('ready', { protocol: 1 });
            expect(
                ((last(b, 'init') as Posted).payload as Dict).visitor,
            ).toEqual({
                name: 'Ann',
                email: 'a@example.com',
                meta: { plan: 'team' },
            });
        });
    });
});

type ChatFeatureLike = (cmd: string, ...args: unknown[]) => unknown;

function inlineBootEarly(boot: Dict = makeBoot()): void {
    const g = window as unknown as Dict;
    g.__PNE_CHAT_BOOT__ = { [String(boot.key)]: boot };
}

function makeScriptEl(): HTMLScriptElement {
    const s = document.createElement('script');
    s.src = `${APP}/w/${KEY}.js`;
    document.head.append(s);

    return s;
}

function inlineBootAndInstall(boot: Dict): void {
    const g = window as unknown as Dict;
    g.__PNE_CHAT_BOOT__ = { [KEY]: boot };
    const s = document.createElement('script');
    s.src = `${APP}/w/${KEY}.js`;
    document.head.append(s);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    void import('../src/api').then(({ install }) => install(window, s));
}
