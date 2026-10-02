/**
 * The whole chain a visitor with the bubble closed depends on, with the REAL loader (`resources/widget/src`), the REAL panel
 * (React app + controller) and the fake backend: the two sides are joined by the same envelopes the iframe would carry, and the
 * panel's `message.created` events come from the fake socket. What this proves (docs/widget-embed-api.md, "Unread badge and reply
 * alert"): replies reach a closed bubble, the badge and the accessible label follow, the alert is raised once per burst, opening
 * marks the messages seen on the server, closing does not bring the count back, and a chat that is over shows nothing.
 */
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { install } from '../../widget/src/api';
import type { ChatFeatureFn } from '../../widget/src/api';
import { ping } from '../../widget/src/sound';
import { makeAgentMessage } from '@/lib/chat/fixtures';
import { parseHostMessage } from '@/embed/protocol/messages';
import type { PanelMessage } from '@/embed/protocol/messages';
import { KEY, bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import { createHarness } from '@/tests/embed-harness';
import { renderPanel, run, waitFor } from '@/tests/embed-render';

vi.mock('../../widget/src/sound', () => ({
    ping: vi.fn(),
    unlockSound: vi.fn(),
}));

const ORIGIN = 'https://chat.test';
const SESSION_KEY = `chatfeature:${KEY}:session`;
const ALERT_KEY = `chatfeature:${KEY}:alert`;

type FakeFrame = { postMessage: ReturnType<typeof vi.fn> };

// jsdom gives no browsing context to an iframe inside a shadow root: one fake window per iframe, like a browser would.
const frames = new WeakMap<HTMLIFrameElement, FakeFrame>();

Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get(this: HTMLIFrameElement): FakeFrame {
        let frame = frames.get(this);

        if (frame === undefined) {
            frame = { postMessage: vi.fn() };
            frames.set(this, frame);
        }

        return frame;
    },
});

type Chain = Awaited<ReturnType<typeof setup>>;

async function setup(options: { unseen?: number } = {}) {
    const backend = useBackend();
    const stored = backend.issueToken();

    backend.seedConversation(stored.token, 'active');

    for (let n = 0; n < (options.unseen ?? 0); n++) {
        backend.agentSays(`Reply ${n + 1} while no page was open`);
    }

    // What the loader finds in the host page's storage after a navigation.
    localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ ...stored, id: 'anonymous' }),
    );

    const script = document.createElement('script');

    script.src = `${ORIGIN}/w/${KEY}.js`;
    document.head.append(script);
    (window as unknown as Record<string, unknown>).__PNE_CHAT_BOOT__ = {
        [KEY]: bootConfig(),
    };

    let frame: HTMLIFrameElement | null = null;
    const toLoader = (message: PanelMessage): void => {
        window.dispatchEvent(
            new MessageEvent('message', {
                data: {
                    ns: 'chatfeature',
                    v: 1,
                    type: message.type,
                    ...('id' in message ? { id: message.id } : {}),
                    payload: message.payload,
                },
                origin: ORIGIN,
                source: frame?.contentWindow as unknown as MessageEventSource,
            }),
        );
    };
    const harness = createHarness({
        backend,
        deps: {
            host: { send: toLoader },
            // what `main.tsx` does in launcher mode: the loader keeps the token in the host page's storage
            persistSession: (session) =>
                toLoader({ type: 'session', payload: session }),
        },
    });
    const view = await renderPanel(harness);
    const cf = install(window, script) as ChatFeatureFn;

    await vi.waitFor(() =>
        expect(document.querySelector('pne-chat-widget')).not.toBeNull(),
    );

    const host = document.querySelector('pne-chat-widget') as HTMLElement;
    const shadow = host.shadowRoot as ShadowRoot;

    frame = shadow.querySelector('iframe');

    if (frame === null) {
        throw new Error('the loader did not create the panel iframe');
    }

    // The loader -> panel direction: whatever the loader posts into the frame reaches the controller (init is acknowledged the way
    // `HostChannel` does, right after the controller took it).
    (
        frame.contentWindow as unknown as FakeFrame
    ).postMessage.mockImplementation((data: unknown) => {
        const message = parseHostMessage(data);

        if (message === null) {
            return;
        }

        harness.controller.handleHostMessage(message);

        if (message.type === 'init' && message.id !== undefined) {
            toLoader({
                type: 'init:result',
                payload: {},
                id: message.id,
            });
        }
    });
    toLoader({ type: 'ready', payload: { protocol: 1 } });

    const q = <T extends Element = HTMLElement>(selector: string): T =>
        shadow.querySelector(selector) as T;

    return { backend, stored, harness, view, cf, shadow, q };
}

const unread = (chain: Chain): unknown =>
    (chain.cf('getState') as { unread: number }).unread;
const alerting = (chain: Chain): boolean =>
    chain.q('button.launcher').dataset.alert === 'true';

const emit = (chain: Chain, event: string, payload: unknown): Promise<void> =>
    run(() => chain.harness.socket()?.emit(event, payload));

function reply(chain: Chain, body: string): Promise<void> {
    const message = chain.backend.agentSays(body);

    return emit(chain, 'message.created', { v: 1, message });
}

describe('closed bubble, live chat: the loader and the real panel together', () => {
    beforeEach(() => {
        vi.mocked(ping).mockClear();
    });
    afterEach(() => {
        try {
            (
                window as unknown as { ChatFeature?: ChatFeatureFn }
            ).ChatFeature?.('shutdown');
        } catch {
            // ignore
        }

        delete (window as unknown as Record<string, unknown>).ChatFeature;
        delete (window as unknown as Record<string, unknown>).__PNE_CHAT_BOOT__;
        document.head.innerHTML = '';
        document.body.innerHTML = '';
        localStorage.clear();
    });

    it('a page that boots with replies nobody read: badge, label and one alert; opening marks them seen; closing keeps it quiet', async () => {
        const chain = await setup({ unseen: 2 });

        await waitFor(() => unread(chain) === 2);

        expect(chain.q('.badge').textContent).toBe('2');
        expect(chain.q('.badge').dataset.show).toBe('true');
        expect(chain.q('button.launcher').getAttribute('aria-label')).toBe(
            'Chat with us, 2 unread messages',
        );
        expect(alerting(chain)).toBe(true);
        expect(chain.q('[role="status"]').textContent).toBe(
            'Chat with us, 2 unread messages',
        );
        expect(ping).toHaveBeenCalledTimes(1);
        expect(chain.cf('getState')).toMatchObject({
            status: 'active',
            open: false,
            unread: 2,
            panelReady: true,
            agent: { name: 'Sam' },
        });

        // the panel rotated the session on resume and the loader keeps the new token for the next page
        const rotated = JSON.parse(
            localStorage.getItem(SESSION_KEY) ?? '{}',
        ) as {
            token: string;
        };

        expect(rotated.token).not.toBe(chain.stored.token);

        // delivered at boot, but not "seen": nobody looked
        await waitFor(() => chain.backend.state.receipts.length > 0);
        expect(
            chain.backend.state.receipts.some((r) => r.seen_upto !== undefined),
        ).toBe(false);

        await run(() => void chain.cf('open'));
        await waitFor(() =>
            chain.backend.state.receipts.some((r) => r.seen_upto === 2),
        );
        expect(unread(chain)).toBe(0);
        expect(chain.q('.badge').dataset.show).toBe('false');
        expect(alerting(chain)).toBe(false);
        expect(localStorage.getItem(ALERT_KEY)).toBeNull();

        await run(() => void chain.cf('close'));
        expect(unread(chain)).toBe(0);
        expect(chain.q('.badge').dataset.show).toBe('false');
    });

    it('live replies: every one moves the badge and the events, the alert (and sound) only once per burst', async () => {
        const chain = await setup();
        const changed = vi.fn();

        chain.cf('on', 'unread-changed', changed);
        await waitFor(() => chain.harness.socket()?.status() === 'connected');
        expect(unread(chain)).toBe(0);

        await reply(chain, 'One moment');
        await reply(chain, 'I am looking');
        await reply(chain, 'Found it');

        await waitFor(() => unread(chain) === 3);
        expect(chain.q('.badge').textContent).toBe('3');
        expect(
            changed.mock.calls.map((c) => (c[0] as { count: number }).count),
        ).toEqual([1, 2, 3]);
        // message text never reaches host code unless the host opted in
        expect(JSON.stringify(changed.mock.calls)).not.toContain('Found it');
        expect(alerting(chain)).toBe(true);
        expect(ping).toHaveBeenCalledTimes(1);
    });

    it('the visitor reads the replies in another tab: the count and the badge drop here without a new message', async () => {
        const chain = await setup({ unseen: 1 });

        await waitFor(() => unread(chain) === 1);

        await waitFor(() => chain.harness.socket()?.status() === 'connected');
        await emit(chain, 'message.seen', {
            v: 1,
            upToSeq: 1,
            by: 'visitor',
            at: '2026-11-20T10:09:00.000Z',
        });

        await waitFor(() => unread(chain) === 0);
        expect(chain.q('.badge').dataset.show).toBe('false');
    });

    it("a chat that ends with replies unread shows nothing afterwards, and a message of the visitor's own never counts", async () => {
        const chain = await setup({ unseen: 1 });

        await waitFor(() => unread(chain) === 1);
        await waitFor(() => chain.harness.socket()?.status() === 'connected');

        await emit(chain, 'message.created', {
            v: 1,
            message: makeAgentMessage({
                conversation: chain.harness.state().conversation?.ulid,
                seq: 99,
                sender: { type: 'visitor', name: 'Vera', avatarUrl: null },
                body: 'Typed in my other tab',
            }),
        });
        expect(unread(chain)).toBe(1);

        await emit(chain, 'conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: true,
        });

        await waitFor(
            () =>
                (chain.cf('getState') as { status: string }).status === 'ended',
        );
        expect(unread(chain)).toBe(0);
        expect(chain.q('.badge').dataset.show).toBe('false');
        expect(chain.q('button.launcher').getAttribute('aria-label')).toBe(
            'Chat with us',
        );
    });
});
