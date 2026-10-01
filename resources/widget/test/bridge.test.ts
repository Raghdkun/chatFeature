import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Bridge, HANDSHAKE_MS, RETRY_MS } from '../src/bridge';
import { APP, resetGlobals } from './helpers';

type Dict = Record<string, unknown>;

describe('Bridge', () => {
    let iframe: HTMLIFrameElement;
    let other: HTMLIFrameElement;
    let post: ReturnType<typeof vi.fn>;
    let onMessage: ReturnType<typeof vi.fn>;
    let onTimeout: ReturnType<typeof vi.fn>;
    let initPayload: Dict;
    let bridge: Bridge;

    const dispatch = (
        data: unknown,
        {
            origin = APP,
            source = iframe.contentWindow,
        }: { origin?: string; source?: unknown } = {},
    ): void => {
        window.dispatchEvent(
            new MessageEvent('message', {
                data,
                origin,
                source: source as MessageEventSource | null,
            }),
        );
    };
    const env = (type: string, payload: unknown = {}, id?: string): Dict => ({
        ns: 'chatfeature',
        v: 1,
        type,
        payload,
        ...(id === undefined ? {} : { id }),
    });
    const sent = (): Dict[] => post.mock.calls.map((c) => c[0] as Dict);
    const initId = (): string =>
        sent().find((m) => m.type === 'init')?.id as string;

    beforeEach(() => {
        vi.useFakeTimers();
        iframe = document.createElement('iframe');
        other = document.createElement('iframe');
        document.body.append(iframe, other);
        post = vi
            .spyOn(iframe.contentWindow as Window, 'postMessage')
            .mockImplementation(() => {}) as never;
        onMessage = vi.fn();
        onTimeout = vi.fn();
        initPayload = { boot: { key: 'k' }, n: 1 };
        bridge = new Bridge({
            win: window,
            iframe,
            origin: APP,
            init: () => initPayload,
            onMessage: onMessage as never,
            onTimeout: onTimeout as never,
        });
    });

    afterEach(() => {
        bridge.dispose();
        vi.restoreAllMocks();
        vi.useRealTimers();
        resetGlobals();
    });

    describe('inbound origin / source / envelope checks', () => {
        it('accepts a well-formed message from the iframe at the app origin', () => {
            dispatch(env('state', { status: 'idle' }));
            expect(onMessage).toHaveBeenCalledWith('state', { status: 'idle' });
        });

        it.each([
            ['another origin', 'https://evil.example'],
            ['a lookalike subdomain', 'https://chat.example.com.evil.example'],
            ['http instead of https', 'http://chat.example.com'],
            ['a different port', 'https://chat.example.com:8443'],
            ['the opaque origin "null"', 'null'],
            ['an empty origin', ''],
            ['the host page origin', window.location.origin],
        ])(
            'ignores messages from %s even if the source is the iframe',
            (_, origin) => {
                dispatch(env('state'), { origin });
                dispatch(env('ready', { protocol: 1 }), { origin });
                expect(onMessage).not.toHaveBeenCalled();
                expect(post).not.toHaveBeenCalled();
            },
        );

        it.each([
            ['the host window itself', () => window],
            ['another iframe', () => other.contentWindow],
            ['no source', () => null],
        ])(
            'ignores messages whose source is %s even from the right origin',
            (_, source) => {
                dispatch(env('state'), { source: source() });
                dispatch(env('ready', { protocol: 1 }), { source: source() });
                expect(onMessage).not.toHaveBeenCalled();
                expect(post).not.toHaveBeenCalled();
            },
        );

        it.each([
            ['a string', 'chatfeature'],
            ['null', null],
            ['a number', 7],
            ['an array', [env('state')]],
            ['no namespace', { v: 1, type: 'state', payload: {} }],
            [
                'a foreign namespace',
                { ns: 'other', v: 1, type: 'state', payload: {} },
            ],
            [
                'an unsupported version',
                { ns: 'chatfeature', v: 2, type: 'state', payload: {} },
            ],
            [
                'a string version',
                { ns: 'chatfeature', v: '1', type: 'state', payload: {} },
            ],
            [
                'a non-string type',
                { ns: 'chatfeature', v: 1, type: 5, payload: {} },
            ],
            ['a missing type', { ns: 'chatfeature', v: 1, payload: {} }],
        ])('ignores %s', (_, data) => {
            dispatch(data);
            expect(onMessage).not.toHaveBeenCalled();
        });

        it('normalises a non-object payload to {} rather than trusting it', () => {
            dispatch(env('session', null));
            dispatch(env('state', [1, 2]));
            dispatch(env('state', 'x'));
            expect(onMessage).toHaveBeenNthCalledWith(1, 'session', {});
            expect(onMessage).toHaveBeenNthCalledWith(2, 'state', {});
            expect(onMessage).toHaveBeenNthCalledWith(3, 'state', {});
        });

        it('ignores everything after dispose', () => {
            bridge.dispose();
            dispatch(env('state'));
            dispatch(env('ready', { protocol: 1 }));
            expect(onMessage).not.toHaveBeenCalled();
            expect(post).not.toHaveBeenCalled();
        });
    });

    describe('handshake', () => {
        it('answers ready with init, an id and the explicit target origin', () => {
            dispatch(env('ready', { protocol: 1 }));
            expect(post).toHaveBeenCalledTimes(1);
            const [msg, target] = post.mock.calls[0] as [Dict, string];
            expect(target).toBe(APP);
            expect(msg).toMatchObject({
                ns: 'chatfeature',
                v: 1,
                type: 'init',
                payload: initPayload,
            });
            expect(typeof msg.id).toBe('string');
            expect((msg.id as string).length).toBeGreaterThan(8);
            expect(bridge.panelReady).toBe(true);
            expect(bridge.acked).toBe(false);
        });

        it('never posts to "*" or any other target, whatever the message', () => {
            dispatch(env('ready', { protocol: 1 }));
            bridge.send('open');
            dispatch(env('init:result', {}, initId()));
            bridge.send('close');
            vi.advanceTimersByTime(HANDSHAKE_MS);

            expect(post.mock.calls.length).toBeGreaterThan(1);

            for (const call of post.mock.calls) {
                expect(call[1]).toBe(APP);
            }
        });

        it('ignores ready from an unsupported protocol version', () => {
            dispatch(env('ready', { protocol: 2 }));
            expect(post).not.toHaveBeenCalled();
            dispatch(env('ready', {}));
            expect(post).toHaveBeenCalledTimes(1); // protocol omitted: treated as v1
        });

        it('re-sends init every second until acknowledged, then stops', () => {
            dispatch(env('ready', { protocol: 1 }));
            const id = initId();
            vi.advanceTimersByTime(RETRY_MS * 3);
            const inits = sent().filter((m) => m.type === 'init');
            expect(inits).toHaveLength(4);
            expect(new Set(inits.map((m) => m.id))).toEqual(new Set([id]));

            dispatch(env('init:result', {}, id));
            expect(bridge.acked).toBe(true);
            post.mockClear();
            vi.advanceTimersByTime(HANDSHAKE_MS * 2);
            expect(post).not.toHaveBeenCalled();
            expect(onTimeout).not.toHaveBeenCalled();
        });

        it('builds a fresh init payload for every retry', () => {
            dispatch(env('ready', { protocol: 1 }));
            initPayload = { n: 2 };
            vi.advanceTimersByTime(RETRY_MS);
            expect((sent().at(-1) as Dict).payload).toEqual({ n: 2 });
        });

        it('only acknowledges with the matching id', () => {
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('init:result', {}, 'some-other-id'));
            dispatch(env('init:result', {}));
            expect(bridge.acked).toBe(false);
            expect(onMessage).not.toHaveBeenCalled(); // init:result is handshake plumbing, not an app message
        });

        it('treats the first state/session message as an acknowledgement for panels that do not ack', () => {
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('state', { status: 'idle' }));
            expect(bridge.acked).toBe(true);
            expect(onMessage).toHaveBeenCalledWith('state', { status: 'idle' });
        });

        it('does not treat state before ready as an ack', () => {
            dispatch(env('state', { status: 'idle' }));
            expect(bridge.acked).toBe(false);
        });

        it('times out when the panel never says ready (10 s)', () => {
            vi.advanceTimersByTime(HANDSHAKE_MS - 1);
            expect(onTimeout).not.toHaveBeenCalled();
            vi.advanceTimersByTime(1);
            expect(onTimeout).toHaveBeenCalledWith('ready_timeout');
            expect(onTimeout).toHaveBeenCalledTimes(1);
        });

        it('times out when ready arrived but init is never acknowledged, and stops retrying', () => {
            dispatch(env('ready', { protocol: 1 }));
            vi.advanceTimersByTime(HANDSHAKE_MS);
            expect(onTimeout).toHaveBeenCalledWith('init_timeout');
            expect(onTimeout).not.toHaveBeenCalledWith('ready_timeout');
            post.mockClear();
            vi.advanceTimersByTime(HANDSHAKE_MS);
            expect(post).not.toHaveBeenCalled();
            expect(sent().length).toBe(0);
        });

        it('a late ready after a timeout restarts the handshake', () => {
            vi.advanceTimersByTime(HANDSHAKE_MS);
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('init:result', {}, initId()));
            expect(bridge.acked).toBe(true);
        });

        it('a second ready (panel reloaded) re-handshakes with a new id and re-queues host messages', () => {
            dispatch(env('ready', { protocol: 1 }));
            const first = initId();
            dispatch(env('init:result', {}, first));
            post.mockClear();

            dispatch(env('ready', { protocol: 1 }));
            const second = sent().find((m) => m.type === 'init')?.id;
            expect(second).not.toBe(first);
            expect(bridge.acked).toBe(false);
            bridge.send('open');
            expect(sent().some((m) => m.type === 'open')).toBe(false);
            dispatch(env('init:result', {}, second as string));
            expect(sent().some((m) => m.type === 'open')).toBe(true);
        });
    });

    describe('outbound queue', () => {
        it('queues host messages until the handshake is acknowledged, then flushes them in order', () => {
            bridge.send('open');
            bridge.send('identify', { token: 'a.b.c' });
            bridge.send('setCategory', { slug: 'billing' });
            expect(post).not.toHaveBeenCalled();

            dispatch(env('ready', { protocol: 1 }));
            expect(sent().map((m) => m.type)).toEqual(['init']);
            dispatch(env('init:result', {}, initId()));
            expect(sent().map((m) => m.type)).toEqual([
                'init',
                'open',
                'identify',
                'setCategory',
            ]);
        });

        it('keeps only the latest queued viewport message', () => {
            bridge.send('viewport', { width: 1, height: 1, keyboardInset: 0 });
            bridge.send('open');
            bridge.send('viewport', { width: 2, height: 2, keyboardInset: 0 });
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('init:result', {}, initId()));
            const types = sent().map((m) => m.type);
            expect(types).toEqual(['init', 'open', 'viewport']);
            expect((sent()[2].payload as Dict).width).toBe(2);
        });

        it('sends immediately once acknowledged, using the documented envelope without an id', () => {
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('init:result', {}, initId()));
            post.mockClear();
            bridge.send('close');
            expect(post).toHaveBeenCalledWith(
                { ns: 'chatfeature', v: 1, type: 'close', payload: {} },
                APP,
            );
        });

        it('swallows postMessage failures (detached frame, non-cloneable payload)', () => {
            post.mockImplementation(() => {
                throw new DOMException('nope', 'DataCloneError');
            });
            dispatch(env('ready', { protocol: 1 }));
            dispatch(env('init:result', {}, initId()));
            expect(() =>
                bridge.send('update', { overrides: {} }),
            ).not.toThrow();
        });

        it('send after dispose is a no-op and clears pending timers', () => {
            dispatch(env('ready', { protocol: 1 }));
            bridge.dispose();
            post.mockClear();
            bridge.send('open');
            vi.advanceTimersByTime(HANDSHAKE_MS * 3);
            expect(post).not.toHaveBeenCalled();
            expect(onTimeout).not.toHaveBeenCalled();
            expect(vi.getTimerCount()).toBe(0);
        });
    });
});
