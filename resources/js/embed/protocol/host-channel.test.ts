import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    HostChannel,
    type HostChannelOptions,
} from '@/embed/protocol/host-channel';
import type { HostMessage } from '@/embed/protocol/messages';

const HOST = 'https://shop.example';
const APP = 'https://chat.test';

type Posted = { data: unknown; target: string };

/** jsdom: `window.parent === window` at top level, so the "parent" is a second window (an iframe's) and our window is the child. */
function setup(options: Partial<HostChannelOptions> = {}) {
    const frame = document.createElement('iframe');

    document.body.append(frame);

    const parentWindow = window; // pretend the test window is the PARENT, and `child` is the panel's window
    const child = frame.contentWindow as Window;
    const posted: Posted[] = [];

    vi.spyOn(parentWindow, 'postMessage').mockImplementation(((
        data: unknown,
        target: string,
    ) => {
        posted.push({ data, target });
    }) as typeof window.postMessage);

    const received: { message: HostMessage; origin: string }[] = [];
    const channel = new HostChannel({
        win: child,
        parent: parentWindow,
        appOrigin: APP,
        allowedHosts: ['shop.example', '*.partner.test'],
        preview: false,
        onMessage: (message, origin) => received.push({ message, origin }),
        readyRetryMs: 0,
        ...options,
    });

    /** Deliver a message to the panel as if the browser did. */
    const deliver = (
        data: unknown,
        origin = HOST,
        source: MessageEventSource | null = parentWindow,
    ): void => {
        child.dispatchEvent(
            new MessageEvent('message', { data, origin, source }),
        );
    };

    return { channel, child, posted, received, deliver, frame, parentWindow };
}

const envelope = (type: string, payload: unknown = {}, id?: string) => ({
    ns: 'chatfeature',
    v: 1,
    type,
    ...(id === undefined ? {} : { id }),
    payload,
});

const INIT = {
    boot: { key: 'wk_x' },
    page: { url: 'u', title: 't', referrer: '' },
    overrides: {},
    embedMode: 'launcher',
    viewport: { width: 1, height: 1, keyboardInset: 0 },
};

afterEach(() => {
    vi.restoreAllMocks();
    document.body.innerHTML = '';
});

describe('handshake', () => {
    it('announces ready { protocol: 1 } to the parent, aimed at the embedding origin when it is allowed', () => {
        const { channel, posted } = setup({
            hintOrigins: ['https://evil.test', HOST],
        });

        channel.start();

        expect(posted).toEqual([
            {
                data: {
                    ns: 'chatfeature',
                    v: 1,
                    type: 'ready',
                    payload: { protocol: 1 },
                },
                target: HOST,
            },
        ]);
        channel.stop();
    });

    it('falls back to * only for the content-free ready beacon when no hint is allowed', () => {
        const { channel, posted } = setup({
            hintOrigins: ['https://evil.test', null, undefined],
        });

        channel.start();

        expect(posted).toHaveLength(1);
        expect(posted[0].target).toBe('*');
        expect(posted[0].data).toMatchObject({
            type: 'ready',
            payload: { protocol: 1 },
        });
        channel.stop();
    });

    it('answers init with init:result (same id), pins the origin, and replies only to it afterwards', () => {
        const { channel, posted, received, deliver } = setup();

        channel.start();
        posted.length = 0;
        deliver(envelope('init', INIT, 'id-7'));

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            message: { type: 'init', id: 'id-7' },
            origin: HOST,
        });
        expect(posted).toEqual([
            {
                data: {
                    ns: 'chatfeature',
                    v: 1,
                    type: 'init:result',
                    id: 'id-7',
                    payload: {},
                },
                target: HOST,
            },
        ]);
        expect(channel.origin).toBe(HOST);

        posted.length = 0;
        channel.send({
            type: 'state',
            payload: { status: 'idle', open: true, unread: 0 },
        });
        channel.send({ type: 'close', payload: {} });
        expect(posted.map((p) => p.target)).toEqual([HOST, HOST]);
        channel.stop();
    });

    it('acknowledges a re-sent init again (the loader retries every second) without breaking anything', () => {
        const { channel, posted, received, deliver } = setup();

        channel.start();
        posted.length = 0;
        deliver(envelope('init', INIT, 'a'));
        deliver(envelope('init', INIT, 'b'));

        expect(received).toHaveLength(2);
        expect(posted.map((p) => (p.data as { id: string }).id)).toEqual([
            'a',
            'b',
        ]);
        channel.stop();
    });

    it('repeats ready until the init arrives, then stops', () => {
        vi.useFakeTimers();

        try {
            const { channel, posted, deliver } = setup({
                readyRetryMs: 1000,
                readyRetries: 3,
            });

            channel.start();
            expect(posted).toHaveLength(1);

            vi.advanceTimersByTime(1000);
            expect(posted).toHaveLength(2);

            deliver(envelope('init', INIT, 'id'));
            posted.length = 0;
            vi.advanceTimersByTime(10_000);
            expect(posted).toHaveLength(0);
            channel.stop();
        } finally {
            vi.useRealTimers();
        }
    });

    it('never sends anything but ready before the host has said init', () => {
        const { channel, posted } = setup();

        channel.start();
        posted.length = 0;
        channel.send({
            type: 'state',
            payload: { status: 'idle', open: false, unread: 0 },
        });
        channel.send({ type: 'session', payload: null });

        expect(posted).toEqual([]);
        channel.stop();
    });
});

describe('source, origin and shape checks', () => {
    let ctx: ReturnType<typeof setup>;

    beforeEach(() => {
        ctx = setup();
        ctx.channel.start();
    });
    afterEach(() => ctx.channel.stop());

    it('ignores messages that do not come from the parent window', () => {
        const stranger = document.createElement('iframe');

        document.body.append(stranger);

        ctx.deliver(envelope('init', INIT, 'x'), HOST, stranger.contentWindow);
        ctx.deliver(envelope('init', INIT, 'x'), HOST, null);

        expect(ctx.received).toEqual([]);
        expect(ctx.channel.origin).toBeNull();
    });

    it.each([
        ['an origin outside the whitelist', 'https://evil.test'],
        ['a look-alike of an allowed host', 'https://shop.example.evil.test'],
        ['plain http for a bare entry', 'http://shop.example'],
        ['the null origin', 'null'],
        ['the app origin outside the preview', APP],
    ])('refuses init from %s', (_name, origin) => {
        ctx.deliver(envelope('init', INIT, 'x'), origin);

        expect(ctx.received).toEqual([]);
        expect(ctx.channel.origin).toBeNull();
    });

    it('honours wildcard whitelist entries', () => {
        ctx.deliver(envelope('init', INIT, 'x'), 'https://eu.partner.test');

        expect(ctx.channel.origin).toBe('https://eu.partner.test');
    });

    it('ignores anything before init except init itself', () => {
        ctx.deliver(envelope('open'));
        ctx.deliver(
            envelope('viewport', { width: 1, height: 1, keyboardInset: 0 }),
        );

        expect(ctx.received).toEqual([]);
    });

    it('ignores non-envelopes, wrong namespace or version, unknown types and bad payloads', () => {
        ctx.deliver('chatfeature');
        ctx.deliver(null);
        ctx.deliver({ ns: 'someoneelse', v: 1, type: 'init', payload: INIT });
        ctx.deliver({ ns: 'chatfeature', v: 2, type: 'init', payload: INIT });
        ctx.deliver(envelope('init', { nope: true }));
        ctx.deliver(envelope('mystery', {}));
        ctx.deliver({ some: 'other library message' });

        expect(ctx.received).toEqual([]);
    });

    it('after the first init only that origin is listened to', () => {
        ctx.deliver(envelope('init', INIT, 'x'));
        ctx.received.length = 0;

        ctx.deliver(envelope('open'), 'https://eu.partner.test');
        ctx.deliver(envelope('init', INIT, 'y'), 'https://eu.partner.test');
        expect(ctx.received).toEqual([]);
        expect(ctx.channel.origin).toBe(HOST);

        ctx.deliver(envelope('open'));
        expect(ctx.received.map((r) => r.message.type)).toEqual(['open']);
    });

    it('draft messages are refused outside the preview, even from the app origin', () => {
        ctx.deliver(envelope('draft', { config: {} }), APP);
        ctx.deliver(envelope('draft', { config: {} }), HOST);

        expect(ctx.received).toEqual([]);
    });
});

describe('builder preview', () => {
    it('accepts init and draft from the app origin (the srcdoc host shares the dashboard origin)', () => {
        const { channel, received, deliver, posted } = setup({
            preview: true,
            allowedHosts: [],
        });

        channel.start();
        deliver(envelope('init', INIT, 'p'), APP);
        deliver(
            envelope('draft', {
                config: { theme: { primary: '#ff0000' } },
                greetings: [],
            }),
            APP,
        );

        expect(received.map((r) => r.message.type)).toEqual(['init', 'draft']);
        expect(posted.at(-1)).toMatchObject({
            target: APP,
            data: { type: 'init:result', id: 'p' },
        });
        channel.stop();
    });

    it('still refuses a draft from any other origin', () => {
        const { channel, received, deliver } = setup({
            preview: true,
            allowedHosts: [],
        });

        channel.start();
        deliver(envelope('draft', { config: {} }), 'https://evil.test');
        deliver(envelope('draft', { config: {} }), HOST);

        expect(received).toEqual([]);
        channel.stop();
    });

    it('a draft may arrive before the init without pinning an origin', () => {
        const { channel, received, deliver } = setup({
            preview: true,
            allowedHosts: [],
        });

        channel.start();
        deliver(envelope('draft', { config: {} }), APP);

        expect(received).toHaveLength(1);
        expect(channel.origin).toBeNull();
        channel.stop();
    });

    it('aims ready at the app origin in the preview', () => {
        const { channel, posted } = setup({
            preview: true,
            allowedHosts: [],
            hintOrigins: [APP],
        });

        channel.start();
        expect(posted[0].target).toBe(APP);
        channel.stop();
    });
});

describe('without a parent', () => {
    it('does nothing when the page is not framed (hosted page, direct visit)', () => {
        const spy = vi.spyOn(window, 'postMessage');
        const received: HostMessage[] = [];
        const standalone = new HostChannel({
            win: window,
            appOrigin: APP,
            allowedHosts: [],
            preview: false,
            onMessage: (message) => received.push(message),
        });

        expect(standalone.hasParent).toBe(false);
        standalone.start();
        standalone.send({ type: 'close', payload: {} });
        window.dispatchEvent(
            new MessageEvent('message', {
                data: envelope('init', INIT, 'x'),
                origin: APP,
                source: window,
            }),
        );

        expect(spy).not.toHaveBeenCalled();
        expect(received).toEqual([]);
        standalone.stop();
    });
});
