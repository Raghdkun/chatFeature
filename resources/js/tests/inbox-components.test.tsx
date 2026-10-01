import '@/tests/dom-polyfills';
import { act, useState } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ConnectionBanner } from '@/components/inbox/connection-banner';
import { MessageList } from '@/components/inbox/message-list';
import { OfferCard } from '@/components/inbox/offer-card';
import { toLocalMessage } from '@/lib/chat/messages';
import {
    fakeTime,
    makeAgentMessage,
    makeMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { LocalMessage } from '@/lib/chat/types';
import { useAttentionTitle } from '@/lib/realtime/staff/document-title';
import type { QueueItem } from '@/lib/realtime/staff/store';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { click, render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const NOW = Date.parse('2026-11-20T10:00:00.000Z');

const item = (overrides: Partial<QueueItem> = {}): QueueItem => ({
    conversation: '01JFAKE0000000000000000001',
    ticketNo: null,
    category: { slug: 'billing', label: 'Billing' },
    visitorName: 'Mina',
    verified: false,
    preview: 'Hello',
    widgetName: 'Support widget',
    wave: 1,
    waitingSince: new Date(NOW).toISOString(),
    expiresAt: new Date(NOW + 90_000).toISOString(),
    state: 'open',
    takenBy: null,
    ...overrides,
});

beforeEach(() => {
    resetFixtures();
    resetInertiaMock();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('OfferCard', () => {
    it('counts down to the deadline once a second', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW);
        const view = await render(
            <OfferCard
                item={item()}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(view.byTestId('offer-countdown')?.textContent).toBe('1:30');
        expect(
            view.byTestId('offer-countdown')?.getAttribute('aria-hidden'),
        ).toBe('true');

        await act(async () => {
            vi.advanceTimersByTime(31_000);
        });
        expect(view.byTestId('offer-countdown')?.textContent).toBe('0:59');

        await act(async () => {
            vi.advanceTimersByTime(60_000);
        });
        expect(view.byTestId('offer-countdown')?.textContent).toBe('0:00');
    });

    it('counts up the waiting time when the deadline is not known (a REST snapshot)', async () => {
        vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime(NOW + 42_000);
        const view = await render(
            <OfferCard
                item={item({ expiresAt: null })}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(view.byTestId('offer-countdown')).toBeNull();
        expect(view.container.textContent).toContain('Waiting 0:42');
    });

    it('accepts once, disables the button while the claim runs, and re-enables it afterwards', async () => {
        let finish: () => void = () => undefined;
        const onAccept = vi.fn(
            () => new Promise<void>((resolve) => (finish = resolve)),
        );
        const view = await render(
            <OfferCard item={item()} canAccept onAccept={onAccept} />,
        );
        const button = view.byTestId(
            'offer-accept-01JFAKE0000000000000000001',
        ) as HTMLButtonElement;

        await click(button);
        await click(button);

        expect(onAccept).toHaveBeenCalledTimes(1);
        expect(button.disabled).toBe(true);
        expect(button.getAttribute('aria-busy')).toBe('true');

        await act(async () => finish());
        expect(button.disabled).toBe(false);
    });

    it('names the chat for screen readers on the Accept button', async () => {
        const view = await render(
            <OfferCard
                item={item()}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(
            view.byTestId('offer-accept-01JFAKE0000000000000000001')
                ?.textContent,
        ).toContain('Accept chat from Mina');
    });

    it('turns into a short message when a colleague took it or the offer expired', async () => {
        const taken = await render(
            <OfferCard
                item={item({ state: 'taken', takenBy: 'Omar' })}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(
            taken.byTestId('offer-outcome-01JFAKE0000000000000000001')
                ?.textContent,
        ).toBe('Taken by Omar');
        expect(
            taken.byTestId('offer-accept-01JFAKE0000000000000000001'),
        ).toBeNull();
        expect(
            taken
                .byTestId('offer-01JFAKE0000000000000000001')
                ?.getAttribute('data-state'),
        ).toBe('taken');
        await taken.unmount();

        const expired = await render(
            <OfferCard
                item={item({ state: 'expired' })}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(
            expired.byTestId('offer-outcome-01JFAKE0000000000000000001')
                ?.textContent,
        ).toBe('This request expired');
    });

    it('marks a verified visitor and shows the category as a label', async () => {
        const view = await render(
            <OfferCard
                item={item({ verified: true })}
                canAccept
                onAccept={async () => undefined}
            />,
        );

        expect(
            view.container.querySelector('[aria-label="Verified"]'),
        ).not.toBeNull();
        expect(
            view.byTestId('offer-category-01JFAKE0000000000000000001')
                ?.textContent,
        ).toBe('Billing');
    });
});

describe('ConnectionBanner', () => {
    it('stays silent while connected or connecting', async () => {
        for (const status of ['connected', 'connecting'] as const) {
            const view = await render(<ConnectionBanner status={status} />);

            expect(view.byTestId('connection-banner')).toBeNull();
            await view.unmount();
        }
    });

    it('waits two seconds before it reports a drop, and clears when the link is back', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let setStatus: (status: 'connected' | 'reconnecting') => void = () =>
            undefined;

        function Host() {
            const [status, set] = useState<'connected' | 'reconnecting'>(
                'reconnecting',
            );

            setStatus = set;

            return <ConnectionBanner status={status} />;
        }

        const view = await render(<Host />);

        expect(view.byTestId('connection-banner')).toBeNull();
        await act(async () => {
            vi.advanceTimersByTime(2000);
        });
        expect(view.byTestId('connection-banner')?.textContent).toContain(
            'Reconnecting to live updates.',
        );
        expect(view.byTestId('connection-banner')?.textContent).toContain(
            'every 15 seconds',
        );
        expect(view.byTestId('connection-banner')?.getAttribute('role')).toBe(
            'status',
        );

        await act(async () => setStatus('connected'));
        expect(view.byTestId('connection-banner')).toBeNull();
    });

    it('does not report a blip that heals within the grace period', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        let setStatus: (status: 'connected' | 'disconnected') => void = () =>
            undefined;

        function Host() {
            const [status, set] = useState<'connected' | 'disconnected'>(
                'disconnected',
            );

            setStatus = set;

            return <ConnectionBanner status={status} />;
        }

        const view = await render(<Host />);

        await act(async () => {
            vi.advanceTimersByTime(1500);
        });
        await act(async () => setStatus('connected'));
        await act(async () => {
            vi.advanceTimersByTime(5000);
        });

        expect(view.byTestId('connection-banner')).toBeNull();
    });

    it('says at once that live updates are off when there is no websocket', async () => {
        const view = await render(<ConnectionBanner status="unavailable" />);

        expect(view.byTestId('connection-banner')?.textContent).toContain(
            'Live updates are off.',
        );
    });
});

describe('MessageList scrolling', () => {
    const make = (seq: number, text: string, mine = false): LocalMessage =>
        toLocalMessage(
            (mine ? makeAgentMessage : makeMessage)({
                seq,
                ulid: `01JFAKE0000000000000000${String(seq).padStart(3, '0')}`,
                body: text,
                createdAt: fakeTime(seq),
            }),
        );

    function Harness({ initial }: { initial: LocalMessage[] }) {
        const [messages, set] = useState(initial);

        harness.add = (message) => set((current) => [...current, message]);

        return (
            <MessageList
                messages={messages}
                typing={false}
                visitorName="Vera"
                label="Messages with Vera"
                onRetry={() => undefined}
                onDiscard={() => undefined}
            />
        );
    }

    const harness: { add: (message: LocalMessage) => void } = {
        add: () => undefined,
    };

    const geometry = (element: HTMLElement, scrollTop: number) => {
        Object.defineProperty(element, 'scrollHeight', {
            value: 1000,
            configurable: true,
        });
        Object.defineProperty(element, 'clientHeight', {
            value: 400,
            configurable: true,
        });
        element.scrollTop = scrollTop;
    };

    it('stays pinned to the newest message while the agent is at the bottom', async () => {
        const view = await render(<Harness initial={[make(1, 'one')]} />);
        const log = view.byTestId('message-list') as HTMLElement;

        geometry(log, 600);
        await act(async () => log.dispatchEvent(new Event('scroll')));
        await act(async () => harness.add(make(2, 'two')));

        expect(view.byTestId('messages-jump')).toBeNull();
        expect(log.scrollTop).toBe(1000);
    });

    it('leaves the view alone and offers a jump button when the agent has scrolled up to read', async () => {
        const view = await render(<Harness initial={[make(1, 'one')]} />);
        const log = view.byTestId('message-list') as HTMLElement;

        geometry(log, 0);
        await act(async () => log.dispatchEvent(new Event('scroll')));
        await act(async () => harness.add(make(2, 'two')));
        await act(async () => harness.add(make(3, 'three')));

        expect(log.scrollTop).toBe(0);
        expect(view.byTestId('messages-jump')?.textContent).toContain(
            '2 new messages',
        );

        await click(view.byTestId('messages-jump'));

        expect(view.byTestId('messages-jump')).toBeNull();
        expect(log.scrollTop).toBe(1000);
    });

    it("always scrolls down for the agent's own message", async () => {
        const view = await render(<Harness initial={[make(1, 'one')]} />);
        const log = view.byTestId('message-list') as HTMLElement;

        geometry(log, 0);
        await act(async () => log.dispatchEvent(new Event('scroll')));
        await act(async () =>
            harness.add({
                ...make(2, 'mine', true),
                ulid: null,
                seq: null,
                status: 'sending',
                clientMsgId: 'c1',
            }),
        );

        expect(log.scrollTop).toBe(1000);
        expect(view.byTestId('messages-jump')).toBeNull();
    });

    it('is a labelled, focusable, polite live log', async () => {
        const view = await render(<Harness initial={[make(1, 'one')]} />);
        const log = view.byTestId('message-list') as HTMLElement;

        expect(log.getAttribute('role')).toBe('log');
        expect(log.getAttribute('aria-live')).toBe('polite');
        expect(log.getAttribute('aria-relevant')).toBe('additions');
        expect(log.getAttribute('aria-label')).toBe('Messages with Vera');
        expect(log.tabIndex).toBe(0);
    });
});

describe('useAttentionTitle', () => {
    function Title({ count }: { count: number }) {
        useAttentionTitle(count);

        return null;
    }

    it('keeps the count in front of the title even when a page sets a new one', async () => {
        document.title = 'Inbox - PNE Chat';
        const view = await render(<Title count={3} />);

        expect(document.title).toBe('(3) Inbox - PNE Chat');

        await act(async () => {
            document.title = 'History - PNE Chat';
            await Promise.resolve();
        });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 0));
        });

        expect(document.title).toBe('(3) History - PNE Chat');

        await view.unmount();
        expect(document.title).toBe('History - PNE Chat');
    });

    it('does not touch the title when there is nothing to report', async () => {
        document.title = 'Inbox - PNE Chat';
        await render(<Title count={0} />);

        expect(document.title).toBe('Inbox - PNE Chat');
    });
});
