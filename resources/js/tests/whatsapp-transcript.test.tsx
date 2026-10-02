import '@/tests/dom-polyfills';
import { act, useState } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { Transcript } from '@/components/whatsapp/transcript';
import { fakeTime, resetFixtures } from '@/lib/chat/fixtures';
import { newClientMsgId } from '@/lib/realtime/staff/client-id';
import {
    makeWaMessage,
    makeWaReply,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import {
    outboxAsMessage,
    type DisplayMessage,
    type OutboxEntry,
} from '@/lib/whatsapp/transcript';
import { render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const ME = { id: 1, name: 'Ada' };

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

/** jsdom has no layout: give the scroll region a height, a viewport and a `scrollTop` that remembers what was set. */
function layout(element: HTMLElement) {
    let scrollTop = 0;

    Object.defineProperty(element, 'scrollHeight', {
        configurable: true,
        get: () => 2000,
    });
    Object.defineProperty(element, 'clientHeight', {
        configurable: true,
        get: () => 400,
    });
    Object.defineProperty(element, 'scrollTop', {
        configurable: true,
        get: () => scrollTop,
        set: (value: number) => {
            scrollTop = value;
        },
    });

    return {
        scrollTo: async (top: number) => {
            scrollTop = top;
            await act(async () => {
                element.dispatchEvent(new Event('scroll'));
            });
        },
        get top() {
            return scrollTop;
        },
    };
}

const outbox = (clientMsgId: string, body = 'On my way'): OutboxEntry => ({
    clientMsgId,
    body,
    createdAt: fakeTime(900),
    state: 'sending',
    failure: null,
    retryAfter: null,
    serverUlid: null,
    after: null,
});

async function mount(initial: DisplayMessage[]) {
    let setMessages: (messages: DisplayMessage[]) => void = () => undefined;

    function Harness() {
        const [messages, set] = useState(initial);

        setMessages = set;

        return (
            <Transcript
                messages={messages}
                label="Chat with Vera"
                hasOlder={false}
                loadingOlder={false}
                onLoadOlder={() => undefined}
                onRetry={() => undefined}
                onDiscard={() => undefined}
            />
        );
    }

    const view = await render(<Harness />);
    const element = view.byTestId('wa-transcript') as HTMLElement;
    const scroll = layout(element);

    return {
        view,
        scroll,
        element,
        add: async (messages: DisplayMessage[]) =>
            act(async () => setMessages(messages)),
    };
}

describe('the transcript keeps up with the conversation', () => {
    const history = () => [
        makeWaMessage({ body: 'one' }),
        makeWaMessage({ body: 'two' }),
        makeWaMessage({ body: 'three' }),
    ];

    it('scrolls to the administrator’s own reply even when they had scrolled up to read (a client id is a lower-case ULID like the server’s)', async () => {
        const base = history();
        const { scroll, add } = await mount(base);

        await scroll.scrollTo(0);

        const reply = outboxAsMessage(
            outbox(newClientMsgId(Date.now())),
            base[0].chat,
            ME,
        );

        await add([...base, reply]);

        expect(scroll.top).toBe(2000);
    });

    it('scrolls to an own reply whatever its id sorts like (a browser clock behind the server’s, an upper-case id)', async () => {
        const base = history();
        const { scroll, add } = await mount(base);

        await scroll.scrollTo(0);
        await add([
            ...base,
            outboxAsMessage(
                outbox('00000000000000000000000001'),
                base[0].chat,
                ME,
            ),
        ]);
        expect(scroll.top).toBe(2000);

        await scroll.scrollTo(0);
        await add([
            ...base,
            outboxAsMessage(
                outbox('00000000000000000000000001'),
                base[0].chat,
                ME,
            ),
            outboxAsMessage(
                outbox('01JZZZZZZZZZZZZZZZZZZZZZZZ'),
                base[0].chat,
                ME,
            ),
        ]);
        expect(scroll.top).toBe(2000);
    });

    it('does not yank the view for the customer’s new message while the administrator reads older ones, and counts it', async () => {
        const base = history();
        const { view, scroll, add } = await mount(base);

        await scroll.scrollTo(0);
        await add([...base, makeWaMessage({ body: 'four' })]);

        expect(scroll.top).toBe(0);
        expect(view.container.textContent).toContain('1 new message');
    });

    it('stays pinned to the bottom for new messages while the administrator is at the bottom', async () => {
        const base = history();
        const { scroll, add } = await mount(base);

        await scroll.scrollTo(2000 - 400);
        await add([...base, makeWaMessage({ body: 'four' })]);

        expect(scroll.top).toBe(2000);
    });

    it('a page of older history added at the top is not news', async () => {
        const base = history();
        const { view, scroll, add } = await mount(base);

        await scroll.scrollTo(0);
        await add([
            makeWaReply({ ulid: '00000000000000000000000001', body: 'older' }),
            ...base,
        ]);

        expect(scroll.top).toBe(0);
        expect(view.container.textContent).not.toContain('new message');
    });
});
