import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { findKey, findScript, install } from '../src/api';
import type { ChatFeatureFn } from '../src/api';
import type { FakeWindow } from './helpers';
import {
    APP,
    KEY,
    boot,
    flush,
    handles,
    inlineBoot,
    makeBoot,
    makeBootCfg,
    makeScript,
    resetGlobals,
    setHidden,
} from './helpers';

type Dict = Record<string, unknown>;
const g = window as unknown as Dict;

describe('window.ChatFeature API', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        resetGlobals();
    });

    describe('key discovery', () => {
        it.each([
            [{ 'data-widget-key': 'wk_abc123' }, 'wk_abc123'],
            [{ src: `${APP}/w/wk_zzz999.js` }, 'wk_zzz999'],
            [{ src: `${APP}/w/wk_zzz999.js?v=3` }, 'wk_zzz999'],
            [
                {
                    src: `${APP}/widget/v1/loader.js`,
                    'data-widget-key': 'wk_gen',
                },
                'wk_gen',
            ],
            [{ src: `${APP}/widget/v1/loader.js` }, null],
            [{ src: `${APP}/w/bad key.js` }, null],
            [{ 'data-widget-key': '<script>' }, null],
            [{ 'data-widget-key': 'x' }, null],
        ])('%j -> %s', (attrs, key) => {
            const s = document.createElement('script');

            for (const k of Object.keys(attrs)) {
                s.setAttribute(k, (attrs as Dict)[k] as string);
            }

            expect(findKey(s)).toBe(key);
        });

        it('findScript falls back to scanning the document when currentScript is unavailable', () => {
            expect(findScript(document)).toBeNull();
            const s = makeScript();
            expect(findScript(document)).toBe(s);
        });
    });

    describe('boot', () => {
        it('boots from the inlined config of /w/<key>.js without any network request', async () => {
            const fetchSpy = vi.fn();
            vi.stubGlobal('fetch', fetchSpy);
            const b = await boot();
            expect(b.host).not.toBeNull();
            expect(fetchSpy).not.toHaveBeenCalled();
            vi.unstubAllGlobals();
        });

        it('waits for DOMContentLoaded when the body does not exist yet', async () => {
            inlineBoot();
            const s = makeScript();
            const body = document.body;
            body.remove();
            const cf = install(window, s) as ChatFeatureFn;
            await flush();
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            document.documentElement.append(body);
            document.dispatchEvent(new Event('DOMContentLoaded'));
            expect(document.querySelector('pne-chat-widget')).not.toBeNull();
            expect(cf('getState')).toMatchObject({ ready: true });
        });

        it('does nothing at load time without a widget key, and warns when init() has none either', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const s = document.createElement('script');
            s.src = `${APP}/widget/v1/loader.js`;
            document.head.append(s);
            const cf = install(window, s) as ChatFeatureFn;
            await flush();
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            expect(warn).not.toHaveBeenCalled(); // a later init({ widgetKey }) is a legitimate flow
            cf('init', {});
            expect(warn).toHaveBeenCalledTimes(1);
            expect(warn.mock.calls[0].join(' ')).toContain('widget key');
        });

        it('the generic loader can be given its key through init()', async () => {
            inlineBoot();
            const s = document.createElement('script');
            s.src = `${APP}/widget/v1/loader.js`;
            document.head.append(s);
            const cf = install(window, s) as ChatFeatureFn;
            cf('init', { widgetKey: KEY, theme: { primary: '#123456' } });
            await flush();
            const host = document.querySelector(
                'pne-chat-widget',
            ) as HTMLElement;
            expect(host).not.toBeNull();
            expect(
                host.shadowRoot
                    ?.querySelector<HTMLElement>('.root')
                    ?.style.getPropertyValue('--primary'),
            ).toBe('#123456');
        });

        it('ignores an init key that is not a valid widget key', async () => {
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            const s = document.createElement('script');
            s.src = `${APP}/widget/v1/loader.js`;
            document.head.append(s);
            const cf = install(window, s) as ChatFeatureFn;
            cf('init', { widgetKey: '../../etc/passwd' });
            await flush();
            expect(document.querySelector('pne-chat-widget')).toBeNull();
        });

        describe('fetching the config (generic loader)', () => {
            const generic = (attrs: Dict = {}): HTMLScriptElement => {
                const s = document.createElement('script');
                s.src = `${APP}/widget/v1/loader.js`;
                s.setAttribute('data-widget-key', KEY);

                for (const k of Object.keys(attrs)) {
                    s.setAttribute(k, attrs[k] as string);
                }

                document.head.append(s);

                return s;
            };
            const ok = (body: unknown, status = 200) =>
                vi.fn().mockResolvedValue({
                    ok: status < 400,
                    status,
                    json: () => Promise.resolve(body),
                });

            it('GETs {origin of the script}/api/v1/public/widgets/{key}/config with a locale, CORS and no credentials', async () => {
                const f = ok({ data: makeBoot() });
                vi.stubGlobal('fetch', f);
                install(window, generic({ 'data-locale': 'ar' }));
                await flush();
                expect(f).toHaveBeenCalledTimes(1);
                const [url, init] = f.mock.calls[0] as [string, RequestInit];
                expect(url).toBe(
                    `${APP}/api/v1/public/widgets/${KEY}/config?locale=ar`,
                );
                expect(init).toMatchObject({
                    mode: 'cors',
                    credentials: 'omit',
                });
                expect(
                    document.querySelector('pne-chat-widget'),
                ).not.toBeNull();
                vi.unstubAllGlobals();
            });

            it('falls back to the browser language for the locale parameter', async () => {
                const f = ok({ data: makeBoot() });
                vi.stubGlobal('fetch', f);
                install(window, generic());
                await flush();
                expect((f.mock.calls[0] as string[])[0]).toMatch(
                    /config\?locale=en-US$/,
                );
                vi.unstubAllGlobals();
            });

            it.each([
                ['an HTTP error', () => ok({}, 404)],
                [
                    'a network/CORS failure',
                    () =>
                        vi
                            .fn()
                            .mockRejectedValue(
                                new TypeError('Failed to fetch'),
                            ),
                ],
                [
                    'a different widget key',
                    () => ok({ data: makeBoot({ key: 'wk_other' }) }),
                ],
                ['garbage JSON', () => ok('nope')],
                [
                    'an embed url on another origin',
                    () =>
                        ok({
                            data: makeBoot({
                                api: {
                                    embed: 'https://evil.example/e',
                                    appOrigin: APP,
                                },
                            }),
                        }),
                ],
            ])(
                'emits a config_failed error and mounts nothing on %s',
                async (_, factory) => {
                    vi.stubGlobal('fetch', factory());
                    const errors: Dict[] = [];
                    const s = generic();
                    const cf = install(window, s) as ChatFeatureFn;
                    cf('on', 'error', (e: Dict) => errors.push(e));
                    await flush();
                    expect(errors.map((e) => e.code)).toEqual([
                        'config_failed',
                    ]);
                    expect(
                        document.querySelector('pne-chat-widget'),
                    ).toBeNull();
                    vi.unstubAllGlobals();
                },
            );

            it('aborts a hanging request after 10 s', async () => {
                vi.stubGlobal(
                    'fetch',
                    vi.fn().mockImplementation(
                        (_: string, init: RequestInit) =>
                            new Promise((_res, rej) => {
                                init.signal?.addEventListener('abort', () =>
                                    rej(
                                        new DOMException(
                                            'aborted',
                                            'AbortError',
                                        ),
                                    ),
                                );
                            }),
                    ),
                );
                const errors: Dict[] = [];
                const cf = install(window, generic()) as ChatFeatureFn;
                cf('on', 'error', (e: Dict) => errors.push(e));
                await vi.advanceTimersByTimeAsync(10_000);
                expect(errors.map((e) => e.code)).toEqual(['config_failed']);
                vi.unstubAllGlobals();
            });

            it('shutdown during the fetch means nothing gets mounted afterwards', async () => {
                let resolveFetch: (v: unknown) => void = () => {};
                vi.stubGlobal(
                    'fetch',
                    vi
                        .fn()
                        .mockReturnValue(
                            new Promise((r) => (resolveFetch = r)),
                        ),
                );
                const cf = install(window, generic()) as ChatFeatureFn;
                cf('shutdown');
                resolveFetch({
                    ok: true,
                    json: () => Promise.resolve({ data: makeBoot() }),
                });
                await flush();
                expect(document.querySelector('pne-chat-widget')).toBeNull();
                vi.unstubAllGlobals();
            });
        });
    });

    describe('stub queue (ChatFeature.q)', () => {
        it('replays calls made before the loader finished, in order, including `arguments` objects', async () => {
            inlineBoot();
            const calls: unknown[] = [];
            // the classic snippet: (ChatFeature.q = ChatFeature.q || []).push(arguments)
            const stub = function (..._args: unknown[]) {
                // eslint-disable-next-line prefer-rest-params
                ((stub as unknown as { q: unknown[] }).q ||= []).push(
                    arguments,
                );
            } as unknown as { q: unknown[] };
            g.ChatFeature = stub;
            (stub as unknown as (...a: unknown[]) => void)('on', 'ready', () =>
                calls.push('ready'),
            );
            (stub as unknown as (...a: unknown[]) => void)('on', 'open', () =>
                calls.push('open'),
            );
            (stub as unknown as (...a: unknown[]) => void)('open');
            (stub as unknown as (...a: unknown[]) => void)('update', {
                theme: { primary: '#abcdef' },
            });
            expect(stub.q).toHaveLength(4);

            const s = makeScript();
            const cf = install(window, s) as ChatFeatureFn;
            await flush();
            expect(g.ChatFeature).toBe(cf);
            expect(cf.q).toEqual([]);
            expect(calls).toEqual(['ready', 'open']);
            const shadow = (
                document.querySelector('pne-chat-widget') as HTMLElement
            ).shadowRoot as ShadowRoot;
            expect(
                shadow
                    .querySelector<HTMLElement>('.root')
                    ?.style.getPropertyValue('--primary'),
            ).toBe('#abcdef');
            expect(
                shadow.querySelector('.panel')?.getAttribute('data-open'),
            ).toBe('true');
        });

        it('replays a queued init(settings) before the auto-boot so the settings apply', async () => {
            inlineBoot();
            g.ChatFeature = { q: [['init', { theme: { radius: 3 } }]] };
            install(window, makeScript());
            await flush();
            const root = (
                document.querySelector('pne-chat-widget') as HTMLElement
            ).shadowRoot?.querySelector<HTMLElement>('.root');
            expect(root?.style.getPropertyValue('--radius')).toBe('3px');
        });

        it('ignores junk queue entries', async () => {
            inlineBoot();
            g.ChatFeature = { q: [null, 5, 'open', {}, [], [null]] };
            vi.spyOn(console, 'warn').mockImplementation(() => {});
            expect(() => install(window, makeScript())).not.toThrow();
            await flush();
            expect(document.querySelectorAll('pne-chat-widget')).toHaveLength(
                1,
            );
        });
    });

    describe('idempotent init', () => {
        it('including the script twice creates exactly one widget', async () => {
            const b = await boot();
            const second = install(window, makeScript());
            await flush();
            expect(second).toBeNull();
            expect(g.ChatFeature).toBe(b.cf);
            expect(document.querySelectorAll('pne-chat-widget')).toHaveLength(
                1,
            );
        });

        it('calling init again after boot merges settings instead of booting a second widget', async () => {
            const b = await boot();
            b.cf('init', { theme: { primary: '#445566' } });
            b.cf('init', { launcher: { label: 'Hello' } });
            expect(document.querySelectorAll('pne-chat-widget')).toHaveLength(
                1,
            );
            expect(b.q('.root').style.getPropertyValue('--primary')).toBe(
                '#445566',
            );
            expect(b.q('button.launcher').getAttribute('aria-label')).toBe(
                'Hello',
            );
        });

        it('init after shutdown boots a fresh widget', async () => {
            const b = await boot();
            b.cf('shutdown');
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            b.cf('init', {});
            await flush();
            expect(document.querySelectorAll('pne-chat-widget')).toHaveLength(
                1,
            );
        });
    });

    describe('events', () => {
        it('on/off subscribe to ready, open and close with payloads', async () => {
            const b = await boot();
            const open = vi.fn();
            const close = vi.fn();
            b.cf('on', 'open', open);
            b.cf('on', 'close', close);
            b.cf('open');
            b.cf('close');
            expect(open).toHaveBeenCalledTimes(1);
            expect(close).toHaveBeenCalledTimes(1);
            b.cf('off', 'open', open);
            b.cf('open');
            expect(open).toHaveBeenCalledTimes(1);
        });

        it('emits ready once the launcher is mounted, and late subscribers are not replayed', async () => {
            const b = await boot();
            const late = vi.fn();
            b.cf('on', 'ready', late);
            expect(late).not.toHaveBeenCalled();
            expect(b.cf('getState')).toMatchObject({ ready: true });
        });

        it('also dispatches chatfeature:<name> DOM CustomEvents (window and document listeners)', async () => {
            const b = await boot();
            const onWindow = vi.fn();
            const onDocument = vi.fn();
            window.addEventListener('chatfeature:open', onWindow);
            document.addEventListener('chatfeature:open', onDocument);
            b.cf('open');
            expect(onWindow).toHaveBeenCalledTimes(1);
            expect(onDocument).toHaveBeenCalledTimes(1);
            expect((onWindow.mock.calls[0][0] as CustomEvent).detail).toEqual(
                {},
            );
            window.removeEventListener('chatfeature:open', onWindow);
            document.removeEventListener('chatfeature:open', onDocument);
        });

        it('on() returns an unsubscribe function and ignores unknown event names / non-functions', async () => {
            const b = await boot();
            const fn = vi.fn();
            const off = b.cf('on', 'open', fn) as () => void;
            off();
            b.cf('open');
            expect(fn).not.toHaveBeenCalled();
            expect(() => b.cf('on', 'nonsense', fn)).not.toThrow();
            expect(() => b.cf('on', 'open', 'not a function')).not.toThrow();
        });

        it('a throwing host handler does not break the widget or other handlers', async () => {
            const b = await boot();
            const ok = vi.fn();
            b.cf('on', 'open', () => {
                throw new Error('host bug');
            });
            b.cf('on', 'open', ok);
            expect(() => b.cf('open')).not.toThrow();
            expect(ok).toHaveBeenCalledTimes(1);
        });

        it('subscriptions survive shutdown/init (they belong to the host page)', async () => {
            const b = await boot();
            const fn = vi.fn();
            b.cf('on', 'ready', fn);
            b.cf('shutdown');
            b.cf('init', {});
            await flush();
            expect(fn).toHaveBeenCalledTimes(1);
        });
    });

    describe('commands', () => {
        it('open / close / toggle drive the panel and aria-expanded', async () => {
            const b = await boot();
            const exp = () =>
                b.q('button.launcher').getAttribute('aria-expanded');
            b.cf('open');
            expect(exp()).toBe('true');
            b.cf('toggle');
            expect(exp()).toBe('false');
            b.cf('toggle');
            expect(exp()).toBe('true');
            b.cf('close');
            expect(exp()).toBe('false');
        });

        it('show / hide toggle the whole widget and hide closes the panel', async () => {
            const b = await boot();
            b.cf('open');
            b.cf('hide');
            expect(b.host.style.getPropertyValue('display')).toBe('none');
            expect(b.cf('getState')).toMatchObject({ open: false });
            b.cf('show');
            expect(b.host.style.getPropertyValue('display')).toBe('block');
        });

        it('commands issued before the widget mounted run once it has', async () => {
            inlineBoot();
            const cf = install(window, makeScript()) as ChatFeatureFn;
            cf('open'); // boot is still resolving
            expect(document.querySelector('pne-chat-widget')).toBeNull();
            await flush();
            const shadow = (
                document.querySelector('pne-chat-widget') as HTMLElement
            ).shadowRoot as ShadowRoot;
            expect(
                shadow.querySelector('.panel')?.getAttribute('data-open'),
            ).toBe('true');
        });

        it('commands before the first init are kept until a widget exists', async () => {
            inlineBoot();
            const s = document.createElement('script');
            s.src = `${APP}/widget/v1/loader.js`;
            document.head.append(s);
            const cf = install(window, s) as ChatFeatureFn;
            cf('open');
            cf('init', { widgetKey: KEY });
            await flush();
            const shadow = (
                document.querySelector('pne-chat-widget') as HTMLElement
            ).shadowRoot as ShadowRoot;
            expect(
                shadow.querySelector('.panel')?.getAttribute('data-open'),
            ).toBe('true');
        });

        it('warns about unknown commands instead of throwing', async () => {
            const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
            const b = await boot();
            expect(() => b.cf('doesNotExist')).not.toThrow();
            expect(() => b.cf(42 as never)).not.toThrow();
            expect(warn).toHaveBeenCalled();
        });

        it('getState returns an idle snapshot before boot and the live state after', async () => {
            inlineBoot();
            const cf = install(window, makeScript()) as ChatFeatureFn;
            expect(cf('getState')).toEqual({
                status: 'idle',
                open: false,
                unread: 0,
                ready: false,
                panelReady: false,
                widgetKey: KEY,
                configVersion: null,
            });
            await flush();
            expect(cf('getState')).toMatchObject({
                ready: true,
                configVersion: 7,
                widgetKey: KEY,
                open: false,
            });
            cf('open');
            const b = handles(cf);
            b.handshake();
            b.fromPanel('state', {
                status: 'active',
                open: true,
                unread: 0,
                agent: { name: 'Sara', avatarUrl: 'javascript:alert(1)' },
            });
            expect(cf('getState')).toMatchObject({
                status: 'active',
                open: true,
                panelReady: true,
                agent: { name: 'Sara' },
            });
            expect((cf('getState') as Dict).agent).not.toHaveProperty(
                'avatarUrl',
            );
        });
    });

    describe('shutdown', () => {
        it('removes the widget, its iframe, timers, listeners, stored session and host side effects', async () => {
            const addSpy = vi.spyOn(window, 'addEventListener');
            const removeSpy = vi.spyOn(window, 'removeEventListener');
            const docAdd = vi.spyOn(document, 'addEventListener');
            const docRemove = vi.spyOn(document, 'removeEventListener');
            const mm = (await import('./helpers')).mockMatchMedia({
                mobile: true,
            });
            void mm;

            const b = await boot({
                boot: makeBootCfg({
                    theme: {
                        fontUrl: 'https://fonts.bunny.net/css?family=inter',
                    },
                    features: { titleBadge: true },
                }),
            });
            document.title = 'My shop';
            b.cf('open');
            b.handshake();
            b.fromPanel('session', {
                token: 'vt_abc',
                expiresAt: '2999-01-01T00:00:00Z',
            });
            b.fromPanel('unread', { count: 0 });
            b.cf('close');
            b.cf('open');
            expect(
                localStorage.getItem(`chatfeature:${KEY}:session`),
            ).not.toBeNull();
            expect(document.documentElement.style.overflow).toBe('hidden');
            b.cf('close');
            b.fromPanel('unread', { count: 4 });
            expect(document.title).toBe('(4) My shop');
            vi.advanceTimersByTime(3000); // greeting on screen
            expect(b.shadow.querySelector('.greet')).not.toBeNull();

            const frame = b.iframe() as unknown as {
                contentWindow: FakeWindow;
            };
            const posts = b.posts();
            b.cf('shutdown');

            expect(document.querySelector('pne-chat-widget')).toBeNull();
            expect(document.querySelector('iframe')).toBeNull();
            expect(
                document.head.querySelector('link[data-pne-chat-font]'),
            ).toBeNull();
            expect(
                localStorage.getItem(`chatfeature:${KEY}:session`),
            ).toBeNull();
            expect(document.title).toBe('My shop');
            expect(document.documentElement.style.overflow).toBe('');
            expect(document.body.style.overflow).toBe('');
            expect(posts.map((p) => p.type)).not.toContain('shutdown'); // snapshot taken before
            const last = frame.contentWindow.postMessage.mock.calls.at(-1) as [
                Dict,
                string,
            ];
            expect(last[0]).toMatchObject({ type: 'shutdown', payload: {} });
            expect(last[1]).toBe(APP);
            vi.advanceTimersByTime(24 * 3600_000);
            expect(vi.getTimerCount()).toBe(0);

            // every listener the widget added was removed again
            type Calls = { mock: { calls: unknown[][] } };
            const balance = (add: Calls, remove: Calls) => {
                const added = add.mock.calls
                    .map((c) => `${String(c[0])}`)
                    .sort();
                const removed = remove.mock.calls
                    .map((c) => `${String(c[0])}`)
                    .sort();

                return {
                    added: added.filter(
                        (e) => !['pointerdown', 'keydown'].includes(e),
                    ),
                    removed,
                };
            };
            const w = balance(addSpy, removeSpy);
            for (const type of new Set(w.added)) {
                expect(w.removed, `window listener "${type}" leaked`).toContain(
                    type,
                );
            }
            const d = balance(docAdd, docRemove);
            for (const type of new Set(d.added)) {
                expect(
                    d.removed,
                    `document listener "${type}" leaked`,
                ).toContain(type);
            }
        });

        it('is safe to call twice and when never booted', async () => {
            const b = await boot();
            b.cf('shutdown');
            expect(() => b.cf('shutdown')).not.toThrow();
            const fresh = await (async () => {
                resetGlobals();
                const s = document.createElement('script');
                s.src = `${APP}/widget/v1/loader.js`;
                document.head.append(s);
                return install(window, s) as ChatFeatureFn;
            })();
            expect(() => fresh('shutdown')).not.toThrow();
        });

        it('stops reacting to panel messages after shutdown', async () => {
            const b = await boot();
            b.cf('open');
            b.handshake();
            const open = vi.fn();
            b.cf('on', 'unread-changed', open);
            const frame = b.iframe();
            b.cf('shutdown');
            window.dispatchEvent(
                new MessageEvent('message', {
                    data: {
                        ns: 'chatfeature',
                        v: 1,
                        type: 'unread',
                        payload: { count: 5 },
                    },
                    origin: APP,
                    source: frame?.contentWindow ?? null,
                }),
            );
            expect(open).not.toHaveBeenCalled();
        });

        it('a running shutdown clears pending commands so they cannot leak into the next init', async () => {
            const b = await boot();
            b.cf('shutdown');
            b.cf('open'); // no widget: waits for the next init...
            b.cf('shutdown'); // ...and shutdown forgets it
            b.cf('init', {});
            await flush();
            expect(b.cf('getState')).toMatchObject({ open: false });
        });
    });

    it('tab visibility does not leak listeners after shutdown', async () => {
        const b = await boot();
        b.cf('shutdown');
        expect(() => setHidden(true)).not.toThrow();
        setHidden(false);
        vi.advanceTimersByTime(60_000);
        expect(document.querySelector('pne-chat-widget')).toBeNull();
    });
});

describe('failure isolation', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => {
        vi.restoreAllMocks();
        vi.useRealTimers();
        resetGlobals();
    });

    it('a browser without Shadow DOM yields an error event instead of an unhandled rejection', async () => {
        inlineBoot();
        const unhandled = vi.fn();
        process.on('unhandledRejection', unhandled);
        vi.spyOn(Element.prototype, 'attachShadow').mockImplementation(() => {
            throw new DOMException('not supported', 'NotSupportedError');
        });
        const cf = install(window, makeScript()) as ChatFeatureFn;
        const errors: Dict[] = [];
        cf('on', 'error', (e: Dict) => errors.push(e));
        await flush();
        expect(errors.map((e) => e.code)).toEqual(['internal']);
        expect(document.querySelector('pne-chat-widget')).toBeNull();
        expect(unhandled).not.toHaveBeenCalled();
        process.off('unhandledRejection', unhandled);
    });
});
