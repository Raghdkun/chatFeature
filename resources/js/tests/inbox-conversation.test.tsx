import '@/tests/dom-polyfills';
import { act } from 'react';
import { http, HttpResponse } from 'msw';
import { toast } from 'sonner';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    fakeTime,
    fakeUlid,
    makeActiveConversationStaff,
    makeAgentMessage,
    makeAttachment,
    makeConversationStaff,
    makeMessage,
    makeSystemMessage,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { ConversationStaff, MessageData } from '@/lib/chat/types';
import { TYPING_DEBOUNCE_MS, TYPING_EXPIRE_MS } from '@/lib/chat/typing';
import InboxShow from '@/pages/inbox/show';
import { body, byTestId, fill } from '@/tests/dom';
import { fakeEcho, whispers } from '@/tests/fake-echo';
import { FakeXhr } from '@/tests/fake-xhr';
import { CATEGORIES } from '@/tests/fixtures';
import { routerMock } from '@/tests/inertia-mock';
import { click } from '@/tests/render';
import {
    ADMIN,
    AGENT,
    renderStaff,
    useStaffBackend,
    waitFor,
} from '@/tests/staff-kit';
import type { InboxShowProps } from '@/types/chat-staff';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

// The network and the clock are real here: a loaded machine (CI, parallel agents) must not turn a slow tick into a failure.
vi.setConfig({ testTimeout: 20_000 });

const backend = useStaffBackend();

const CONVERSATION = fakeUlid(7000);
const channel = `conversation.${CONVERSATION}`;

const visitorMsg = (
    seq: number,
    text: string,
    overrides: Partial<MessageData> = {},
): MessageData =>
    makeMessage({
        seq,
        ulid: fakeUlid(6000 + seq),
        conversation: CONVERSATION,
        body: text,
        createdAt: fakeTime(seq * 10),
        ...overrides,
    });

const agentMsg = (
    seq: number,
    text: string,
    overrides: Partial<MessageData> = {},
): MessageData =>
    makeAgentMessage({
        seq,
        ulid: fakeUlid(6000 + seq),
        conversation: CONVERSATION,
        body: text,
        createdAt: fakeTime(seq * 10),
        sender: { type: 'agent', name: 'Sam', avatarUrl: null, id: AGENT.id },
        ...overrides,
    });

function activeChat(
    overrides: Partial<ConversationStaff> = {},
): ConversationStaff {
    return makeActiveConversationStaff({
        ulid: CONVERSATION,
        ticketNo: 'K7M2QX',
        category: { slug: 'billing', label: 'Billing' },
        assignedAgent: { id: AGENT.id, name: AGENT.name },
        visitor: {
            ulid: fakeUlid(7100),
            name: 'Vera Visitor',
            email: 'vera@visitor.example',
            phone: '+49 30 1234',
            verified: true,
            meta: { plan: 'pro', page_url: 'https://shop.example/pricing' },
        },
        lastSeq: 3,
        ...overrides,
    });
}

function props(overrides: Partial<InboxShowProps> = {}): InboxShowProps {
    return {
        queue: [],
        mine: [],
        presence: { status: 'online' },
        categories: CATEGORIES,
        conversation: activeChat(),
        messages: [
            visitorMsg(1, 'Hello, I need help with my invoice'),
            agentMsg(2, 'Sure, let me look'),
            visitorMsg(3, 'It is order 4411'),
        ],
        ...overrides,
    };
}

/** Seed the fake API with what the page was given, so REST calls agree with the props. */
function seed(p: InboxShowProps): void {
    backend.current.state.conversations.set(
        p.conversation.ulid,
        p.conversation,
    );
    backend.current.state.messages.set(p.conversation.ulid, p.messages);
}

async function mount(
    p: InboxShowProps = props(),
    options: Parameters<typeof renderStaff>[1] = {},
) {
    seed(p);

    return renderStaff(<InboxShow {...p} />, options);
}

const composer = (view: { byTestId: (id: string) => HTMLElement | null }) =>
    view.byTestId('composer-input') as HTMLTextAreaElement;

const press = (
    element: HTMLElement,
    key: string,
    init: KeyboardEventInit = {},
) =>
    act(async () => {
        element.dispatchEvent(
            new KeyboardEvent('keydown', {
                key,
                bubbles: true,
                cancelable: true,
                ...init,
            }),
        );
    });

const visible = (state: 'visible' | 'hidden') =>
    Object.defineProperty(document, 'visibilityState', {
        value: state,
        configurable: true,
    });

beforeEach(() => {
    resetFixtures();
    visible('visible');
    FakeXhr.reset();
});

afterEach(() => {
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('the conversation', () => {
    it('shows who the visitor is, what the chat is about and the transcript in a live log', async () => {
        const { view } = await mount();

        expect(view.byTestId('conversation-name')?.textContent).toBe(
            'Vera Visitor',
        );
        expect(view.byTestId('conversation-verified')).not.toBeNull();
        expect(view.byTestId('conversation-header')?.textContent).toContain(
            '#K7M2QX',
        );
        expect(view.byTestId('conversation-header')?.textContent).toContain(
            'Billing',
        );
        expect(view.byTestId('conversation-header')?.textContent).toContain(
            'Support widget',
        );

        const log = view.byTestId('message-list');

        expect(log?.getAttribute('role')).toBe('log');
        expect(log?.getAttribute('aria-live')).toBe('polite');
        expect(log?.textContent).toContain(
            'Hello, I need help with my invoice',
        );
        expect(
            view
                .byTestId(`message-${fakeUlid(6001)}`)
                ?.getAttribute('data-sender'),
        ).toBe('visitor');
        expect(
            view
                .byTestId(`message-${fakeUlid(6002)}`)
                ?.getAttribute('data-sender'),
        ).toBe('agent');
        expect(
            view
                .byTestId(`message-${fakeUlid(6002)}`)
                ?.getAttribute('data-status'),
        ).toBe('sent');
        expect(
            view.container.querySelectorAll(
                '[aria-label="Today"], li[aria-label]',
            ).length,
        ).toBeGreaterThan(0);
    });

    it("puts the visitor's email, phone and page in the header (the page only as a safe web link)", async () => {
        const { view } = await mount();
        const contact = view.byTestId('conversation-contact') as HTMLElement;

        expect(
            contact.querySelector('a[href="mailto:vera@visitor.example"]'),
        ).not.toBeNull();
        expect(
            contact.querySelector('a[href="tel:+49 30 1234"]'),
        ).not.toBeNull();

        const page = contact.querySelector(
            'a[href^="https://shop.example"]',
        ) as HTMLAnchorElement;

        expect(page.textContent).toBe('shop.example/pricing');
        expect(page.rel).toBe('noopener noreferrer');
        await view.unmount();

        const hostile = activeChat({
            visitor: {
                ulid: 'v9',
                name: 'Hal',
                email: null,
                phone: null,
                verified: false,
                meta: { page_url: 'javascript:alert(1)' },
            },
        });
        const second = await mount(props({ conversation: hostile }));

        expect(second.view.byTestId('conversation-contact')).toBeNull();
    });

    it('renders message text as text, never as markup, and links URLs safely', async () => {
        const nasty =
            '<img src=x onerror="alert(1)"> see https://example.com/a?b=1 now';
        const { view } = await mount(
            props({
                messages: [visitorMsg(1, nasty)],
                conversation: activeChat({ lastSeq: 1 }),
            }),
        );
        const bubble = view.byTestId(
            `message-${fakeUlid(6001)}`,
        ) as HTMLElement;

        expect(bubble.querySelector('img[src="x"]')).toBeNull();
        expect(bubble.textContent).toContain('<img src=x onerror="alert(1)">');

        const link = bubble.querySelector('a') as HTMLAnchorElement;

        expect(link.href).toBe('https://example.com/a?b=1');
        expect(link.rel).toBe('noopener noreferrer nofollow');
        expect(link.target).toBe('_blank');
    });

    it('shows system lines and image attachments, and opens an image in a lightbox', async () => {
        const attachment = makeAttachment({
            ulid: 'att1',
            width: 640,
            height: 480,
        });
        const { view } = await mount(
            props({
                conversation: activeChat({ lastSeq: 2 }),
                messages: [
                    makeSystemMessage({
                        seq: 1,
                        ulid: fakeUlid(6001),
                        conversation: CONVERSATION,
                        body: 'Sam joined the chat',
                        createdAt: fakeTime(10),
                    }),
                    visitorMsg(2, '', {
                        type: 'image',
                        body: null,
                        attachments: [attachment],
                    }),
                ],
            }),
        );

        expect(view.byTestId(`message-${fakeUlid(6001)}`)?.textContent).toBe(
            'Sam joined the chat',
        );

        const thumb = view
            .byTestId('attachment-att1')
            ?.querySelector('img') as HTMLImageElement;

        expect(thumb.src).toBe(attachment.thumbUrl);
        expect(thumb.getAttribute('loading')).toBe('lazy');

        await click(view.byTestId('attachment-att1'));
        const full = body
            .byTestId('lightbox')
            ?.querySelector('img') as HTMLImageElement;

        expect(full.src).toBe(attachment.url);

        await act(async () => {
            body.byTestId('lightbox')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        await waitFor(() => expect(body.byTestId('lightbox')).toBeNull());
    });

    it('has a labelled composer with attach and send controls', async () => {
        const { view } = await mount();

        const label = Array.from(view.container.querySelectorAll('label')).find(
            (l) => l.textContent === 'Message',
        );

        expect(label?.htmlFor).toBe(composer(view).id);
        expect(
            view.byTestId('composer-attach')?.getAttribute('aria-label'),
        ).toBe('Attach images');
        expect(view.byTestId('composer-send')?.getAttribute('aria-label')).toBe(
            'Send message',
        );
        expect(view.byTestId('composer-canned')?.hasAttribute('disabled')).toBe(
            true,
        );
        expect(
            (view.byTestId('composer-send') as HTMLButtonElement).disabled,
        ).toBe(true);
    });
});

describe('sending', () => {
    it('sends on Enter: shows the message at once, then confirms it with the server copy', async () => {
        const { view } = await mount();

        await fill(composer(view), '  Found it, one moment  ');
        expect(
            (view.byTestId('composer-send') as HTMLButtonElement).disabled,
        ).toBe(false);
        await press(composer(view), 'Enter');

        expect(composer(view).value).toBe('');
        expect(view.container.textContent).toContain('Found it, one moment');

        await waitFor(() => {
            const sent = backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/messages`,
            );

            expect(sent).toHaveLength(1);
        });

        const sent = backend.current.calls(
            'POST',
            `/api/v1/conversations/${CONVERSATION}/messages`,
        )[0].body as { client_msg_id: string; body: string };

        expect(sent.body).toBe('Found it, one moment');
        expect(sent.client_msg_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
        await waitFor(() =>
            expect(
                view.container.querySelector(
                    '[data-sender="agent"][data-status="sent"] ',
                ),
            ).not.toBeNull(),
        );
        expect(
            view.container.querySelectorAll('[data-sender="agent"]'),
        ).toHaveLength(2);
    });

    it('does not send on Shift+Enter, during an IME composition, or when empty', async () => {
        const { view } = await mount();

        await fill(composer(view), 'line one');
        await press(composer(view), 'Enter', { shiftKey: true });
        await press(composer(view), 'Enter', { isComposing: true });
        await fill(composer(view), '   ');
        await press(composer(view), 'Enter');

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/messages`,
            ),
        ).toHaveLength(0);
    });

    it('sends with the button too', async () => {
        const { view } = await mount();

        await fill(composer(view), 'Via button');
        await click(view.byTestId('composer-send'));
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/messages`,
                ),
            ).toHaveLength(1),
        );
    });

    it('marks a failed send, retries it with the same id, and ends up with one message', async () => {
        backend.current.state.failNextSends = 1;
        const { view } = await mount();

        await fill(composer(view), 'Please retry me');
        await press(composer(view), 'Enter');
        await waitFor(() =>
            expect(
                view.container.querySelector('[data-status="failed"]'),
            ).not.toBeNull(),
        );

        const failed = view.container.querySelector(
            '[data-status="failed"]',
        ) as HTMLElement;

        expect(failed.textContent).toContain('Not sent.');

        const retry = failed.querySelector(
            '[data-testid^="message-retry-"]',
        ) as HTMLElement;

        await click(retry);
        await waitFor(() =>
            expect(
                view.container.querySelector('[data-status="failed"]'),
            ).toBeNull(),
        );
        await waitFor(() =>
            expect(
                view.container.querySelectorAll(
                    '[data-sender="agent"][data-status="sent"]',
                ).length,
            ).toBe(2),
        );

        const calls = backend.current.calls(
            'POST',
            `/api/v1/conversations/${CONVERSATION}/messages`,
        );

        expect(calls).toHaveLength(2);
        expect((calls[0].body as { client_msg_id: string }).client_msg_id).toBe(
            (calls[1].body as { client_msg_id: string }).client_msg_id,
        );
        expect(
            view.container.textContent?.match(/Please retry me/g),
        ).toHaveLength(1);
    });

    it('discards a message the agent gives up on', async () => {
        backend.current.state.failNextSends = 1;
        const { view } = await mount();

        await fill(composer(view), 'Never mind');
        await press(composer(view), 'Enter');
        await waitFor(() =>
            expect(
                view.container.querySelector('[data-status="failed"]'),
            ).not.toBeNull(),
        );
        await click(
            view.container.querySelector(
                '[data-testid^="message-discard-"]',
            ) as HTMLElement,
        );

        expect(view.container.textContent).not.toContain('Never mind');
    });

    it('explains a send to a chat that is no longer active', async () => {
        const { view } = await mount();

        backend.current.state.conversations.set(CONVERSATION, {
            ...activeChat(),
            status: 'closed',
        });
        await fill(composer(view), 'Too late');
        await press(composer(view), 'Enter');
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                'This chat is no longer active',
            ),
        );
    });
});

describe('realtime', () => {
    it('subscribes to the conversation channel and adds incoming messages', async () => {
        const { view } = await mount();

        expect(fakeEcho.channels()).toContain(`private:${channel}`);

        await act(async () =>
            fakeEcho.emitServer(channel, 'message.created', {
                v: 1,
                message: visitorMsg(4, 'Are you still there?'),
            }),
        );

        expect(view.byTestId('message-list')?.textContent).toContain(
            'Are you still there?',
        );
    });

    it('shows the typing indicator from the whisper and drops it when the message lands or the whisper expires', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
        const { view } = await mount();

        await act(async () =>
            fakeEcho.emit(channel, '.client-typing', {
                actor: 'visitor',
                typing: true,
            }),
        );
        expect(view.byTestId('typing-indicator')).not.toBeNull();
        expect(view.byTestId('typing-indicator')?.textContent).toContain(
            'Vera Visitor is typing',
        );

        await act(async () => {
            vi.advanceTimersByTime(TYPING_EXPIRE_MS + 100);
        });
        expect(view.byTestId('typing-indicator')).toBeNull();

        await act(async () =>
            fakeEcho.emit(channel, '.client-typing', {
                actor: 'visitor',
                typing: true,
            }),
        );
        expect(view.byTestId('typing-indicator')).not.toBeNull();
        await act(async () =>
            fakeEcho.emitServer(channel, 'message.created', {
                v: 1,
                message: visitorMsg(4, 'Done typing'),
            }),
        );
        expect(view.byTestId('typing-indicator')).toBeNull();

        await act(async () =>
            fakeEcho.emit(channel, '.client-typing', {
                actor: 'agent',
                typing: true,
            }),
        );
        expect(view.byTestId('typing-indicator')).toBeNull();
    });

    it("also listens to the server's typing event (the fallback for whispers a server cannot send)", async () => {
        const { view } = await mount();

        await act(async () =>
            fakeEcho.emitServer(channel, 'typing', {
                v: 1,
                actor: 'visitor',
                typing: true,
            }),
        );
        expect(view.byTestId('typing-indicator')).not.toBeNull();

        await act(async () =>
            fakeEcho.emitServer(channel, 'typing', {
                v: 1,
                actor: 'visitor',
                typing: false,
            }),
        );
        expect(view.byTestId('typing-indicator')).toBeNull();

        await act(async () =>
            fakeEcho.emitServer(channel, 'typing', {
                v: 1,
                actor: 'agent',
                typing: true,
            }),
        );
        await act(async () =>
            fakeEcho.emitServer(channel, 'typing', {
                v: 2,
                actor: 'visitor',
                typing: true,
            }),
        );
        expect(view.byTestId('typing-indicator')).toBeNull();
    });

    it('whispers that the agent is typing, at most once per 3 seconds, and stops when the message is sent', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        const { view } = await mount();

        await fill(composer(view), 'H');
        await fill(composer(view), 'He');
        await fill(composer(view), 'Hel');

        expect(whispers.filter((w) => w.channel === channel)).toEqual([
            {
                channel,
                event: 'client-typing',
                payload: { actor: 'agent', typing: true },
            },
        ]);

        vi.setSystemTime(Date.now() + TYPING_DEBOUNCE_MS + 1);
        await fill(composer(view), 'Hell');
        expect(
            whispers.filter(
                (w) => w.payload && (w.payload as { typing: boolean }).typing,
            ),
        ).toHaveLength(2);

        await press(composer(view), 'Enter');
        expect(whispers.at(-1)?.payload).toEqual({
            actor: 'agent',
            typing: false,
        });
    });

    it('ticks my messages as seen when the visitor reads them', async () => {
        const { view } = await mount();

        expect(
            view
                .byTestId(`message-${fakeUlid(6002)}`)
                ?.getAttribute('data-status'),
        ).toBe('sent');
        await act(async () =>
            fakeEcho.emitServer(channel, 'message.seen', {
                v: 1,
                upToSeq: 3,
                by: 'visitor',
                at: fakeTime(500),
            }),
        );

        expect(
            view
                .byTestId(`message-${fakeUlid(6002)}`)
                ?.getAttribute('data-status'),
        ).toBe('seen');
    });

    it('fetches the hole when a message arrives out of order', async () => {
        const p = props();

        backend.current.state.messages.set(CONVERSATION, [
            ...p.messages,
            visitorMsg(4, 'Message four'),
            visitorMsg(5, 'Message five'),
        ]);
        backend.current.state.conversations.set(CONVERSATION, {
            ...p.conversation,
            lastSeq: 5,
        });
        const { view } = await renderStaff(<InboxShow {...p} />);

        await act(async () =>
            fakeEcho.emitServer(channel, 'message.created', {
                v: 1,
                message: visitorMsg(5, 'Message five'),
            }),
        );

        await waitFor(() =>
            expect(view.byTestId('message-list')?.textContent).toContain(
                'Message four',
            ),
        );
        expect(
            backend.current.calls(
                'GET',
                `/api/v1/conversations/${CONVERSATION}/messages`,
            )[0].query.after_seq,
        ).toBe('3');
        expect(view.container.textContent?.match(/Message five/g)).toHaveLength(
            1,
        );
    });

    it('catches up after the websocket reconnects', async () => {
        const p = props();

        seed(p);
        const { view } = await renderStaff(<InboxShow {...p} />);

        backend.current.state.messages.set(CONVERSATION, [
            ...p.messages,
            visitorMsg(4, 'Sent while offline'),
        ]);
        await act(async () => fakeEcho.setConnection('reconnecting'));
        await act(async () => fakeEcho.setConnection('connected'));

        await waitFor(() =>
            expect(view.byTestId('message-list')?.textContent).toContain(
                'Sent while offline',
            ),
        );
    });

    it('catches up when the tab comes back to the foreground', async () => {
        const p = props();

        seed(p);
        const { view } = await renderStaff(<InboxShow {...p} />);

        backend.current.state.messages.set(CONVERSATION, [
            ...p.messages,
            visitorMsg(4, 'While you were away'),
        ]);
        visible('hidden');
        await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
        );
        visible('visible');
        await act(async () =>
            document.dispatchEvent(new Event('visibilitychange')),
        );

        await waitFor(() =>
            expect(view.byTestId('message-list')?.textContent).toContain(
                'While you were away',
            ),
        );
    });

    it('polls every 15 seconds when there is no websocket', async () => {
        const p = props();

        seed(p);
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
        await renderStaff(<InboxShow {...p} />, { sockets: false });

        const polls = () =>
            backend.current.calls(
                'GET',
                `/api/v1/conversations/${CONVERSATION}/messages`,
            ).length;
        const before = polls();

        await act(async () => {
            vi.advanceTimersByTime(15_000);
        });
        await waitFor(() => expect(polls()).toBe(before + 1));
    });
});

describe('what the agent has read', () => {
    it("acknowledges the visitor's messages once the chat is on screen, and clears the unread badge", async () => {
        const p = props({ conversation: activeChat({ unseenByAgent: 2 }) });

        seed(p);
        const { session } = await renderStaff(<InboxShow {...p} />);

        session.store.dispatch({
            type: 'hydrate',
            queue: [],
            mine: [p.conversation],
        });
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/receipts`,
                ),
            ).toHaveLength(1),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/receipts`,
            )[0].body,
        ).toEqual({
            delivered_upto: 3,
            seen_upto: 3,
        });
        expect(session.store.getState().mine[0].unseenByAgent).toBe(0);
    });

    it('does not acknowledge while the tab is hidden', async () => {
        visible('hidden');
        await mount();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
        });

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/receipts`,
            ),
        ).toHaveLength(0);
    });

    it("never reads a colleague's chat on their behalf (an admin watching)", async () => {
        const watched = activeChat({ assignedAgent: { id: 99, name: 'Omar' } });

        await mount(props({ conversation: watched }), { viewer: ADMIN });
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 600));
        });

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/receipts`,
            ),
        ).toHaveLength(0);
    });

    it("tells the admin they are viewing someone else's chat", async () => {
        const watched = activeChat({ assignedAgent: { id: 99, name: 'Omar' } });
        const { view } = await mount(props({ conversation: watched }), {
            viewer: ADMIN,
        });

        expect(view.byTestId('conversation-monitoring')?.textContent).toContain(
            'Assigned to Omar',
        );
    });

    it('does not announce unread messages of the chat that is open', async () => {
        const { session, sound } = await mount();

        session.store.dispatch({
            type: 'hydrate',
            queue: [],
            mine: [activeChat()],
        });
        await act(async () =>
            fakeEcho.emitServer('staff.7', 'unread.updated', {
                v: 1,
                conversation: CONVERSATION,
                unseen: 1,
            }),
        );

        expect(sound.play).not.toHaveBeenCalled();
        expect(session.store.getState().mine[0].unseenByAgent).toBe(0);
    });
});

describe('ending, closing and transferring', () => {
    it('asks before ending a chat, then ends it and stops the composer', async () => {
        const { view } = await mount();

        await click(view.byTestId('end-chat'));
        expect(body.byTestId('end-chat-dialog')?.textContent).toContain(
            'End this chat?',
        );
        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/end`,
            ),
        ).toHaveLength(0);

        await click(body.byTestId('end-chat-confirm'));
        await waitFor(() =>
            expect(view.byTestId('composer-disabled')?.textContent).toBe(
                'This chat has ended.',
            ),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/end`,
            ),
        ).toHaveLength(1);
        expect(view.byTestId('end-chat')).toBeNull();
        expect(
            view.byTestId('conversation-view')?.getAttribute('data-status'),
        ).toBe('ended');
    });

    it('reads the full conversation when an action answers with the public form only', async () => {
        const { view } = await mount();
        const original = activeChat();

        // 4A may answer `end` with `ConversationPublic` (no visitor): the view must not crash, it re-reads the staff record.
        backend.server.use(
            http.post(`/api/v1/conversations/${CONVERSATION}/end`, () => {
                backend.current.state.conversations.set(CONVERSATION, {
                    ...original,
                    status: 'ended',
                });

                return HttpResponse.json({
                    data: {
                        ulid: CONVERSATION,
                        ticketNo: 'K7M2QX',
                        status: 'ended',
                        type: 'live',
                        category: null,
                        agent: null,
                        createdAt: fakeTime(0),
                        endedAt: fakeTime(9),
                        ratingRequested: true,
                        lastSeq: 3,
                    },
                });
            }),
        );

        await click(view.byTestId('end-chat'));
        await click(body.byTestId('end-chat-confirm'));
        await waitFor(() =>
            expect(view.byTestId('composer-disabled')?.textContent).toBe(
                'This chat has ended.',
            ),
        );

        expect(view.byTestId('conversation-name')?.textContent).toBe(
            'Vera Visitor',
        );
    });

    it('closes an offline ticket without a rating', async () => {
        const ticket = activeChat({ type: 'offline' });
        const { view } = await mount(props({ conversation: ticket }));

        expect(view.byTestId('end-chat')?.textContent).toContain(
            'Close ticket',
        );
        expect(view.byTestId('transfer-chat')).toBeNull();
        expect(view.byTestId('composer-email-notice')?.textContent).toContain(
            'vera@visitor.example',
        );

        await click(view.byTestId('end-chat'));
        await click(body.byTestId('end-chat-confirm'));
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/close`,
                ),
            ).toHaveLength(1),
        );
        await waitFor(() =>
            expect(view.byTestId('composer-disabled')?.textContent).toBe(
                'This chat is closed.',
            ),
        );
    });

    it('transfers to a colleague picked from the roster', async () => {
        const { view } = await mount();

        await act(async () =>
            fakeEcho.presence.here([
                {
                    id: AGENT.id,
                    name: 'Sam',
                    avatarUrl: null,
                    status: 'online',
                },
                { id: 9, name: 'Omar', avatarUrl: null, status: 'away' },
                { id: 11, name: 'Lina', avatarUrl: null, status: 'online' },
            ]),
        );
        await click(view.byTestId('transfer-chat'));

        const dialog = body.byTestId('transfer-dialog') as HTMLElement;
        const options = Array.from(
            dialog.querySelectorAll(
                '[data-testid^="transfer-agent-"][role="radio"]',
            ),
        ).map((o) => o.getAttribute('data-testid'));

        expect(options).toEqual(['transfer-agent-11', 'transfer-agent-9']);
        expect(
            (body.byTestId('transfer-confirm') as HTMLButtonElement).disabled,
        ).toBe(true);

        await click(body.byTestId('transfer-agent-9'));
        await click(body.byTestId('transfer-confirm'));
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/transfer`,
                ),
            ).toHaveLength(1),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/transfer`,
            )[0].body,
        ).toEqual({ agent_id: 9 });
        await waitFor(() =>
            expect(routerMock.visit).toHaveBeenCalledWith('/inbox'),
        );
    });

    it('transfers to another category (the current one is not offered)', async () => {
        const { view } = await mount();

        await click(view.byTestId('transfer-chat'));
        expect(body.byTestId('transfer-no-agents')).not.toBeNull();

        const tab = body.byTestId('transfer-tab-category') as HTMLElement;

        await act(async () => {
            tab.dispatchEvent(
                new MouseEvent('mousedown', { bubbles: true, button: 0 }),
            );
            tab.focus();
            tab.click();
        });

        const select = body.byTestId('transfer-category') as HTMLSelectElement;

        // Only active categories other than the chat's own.
        expect(Array.from(select.options).map((o) => o.value)).toEqual([
            '',
            'sales',
        ]);

        await act(async () => {
            select.value = 'sales';
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await click(body.byTestId('transfer-confirm'));
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/transfer`,
                ),
            ).toHaveLength(1),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/transfer`,
            )[0].body,
        ).toEqual({ category: 'sales' });
    });
});

describe('other actions', () => {
    it('copies the transcript', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);

        vi.stubGlobal('navigator', { clipboard: { writeText } });
        const { view } = await mount();

        await click(view.byTestId('copy-transcript'));
        await waitFor(() => expect(writeText).toHaveBeenCalled());

        const text = writeText.mock.calls[0][0] as string;

        expect(text.split('\n')).toHaveLength(3);
        expect(text).toContain(
            'Vera Visitor: Hello, I need help with my invoice',
        );
        expect(text).toContain('Sam: Sure, let me look');
        expect(toast.success).toHaveBeenCalledWith('Transcript copied');
    });

    it('opens the details with contact data, the page the visitor is on and their metadata', async () => {
        const { view } = await mount();

        await click(view.byTestId('conversation-info'));

        const sheet = body.byTestId('conversation-details') as HTMLElement;

        expect(sheet.textContent).toContain('vera@visitor.example');
        expect(sheet.textContent).toContain('+49 30 1234');
        expect(sheet.textContent).toContain('K7M2QX');
        expect(sheet.textContent).toContain('pro');
        expect(
            (
                sheet.querySelector(
                    'a[href^="https://shop.example"]',
                ) as HTMLAnchorElement
            ).rel,
        ).toBe('noopener noreferrer');
        expect(
            (
                sheet.querySelector('a[href^="mailto:"]') as HTMLAnchorElement
            ).getAttribute('href'),
        ).toBe('mailto:vera@visitor.example');
    });

    it('lets the agent accept a chat they opened while it was still queued', async () => {
        const queued = makeConversationStaff({
            ulid: CONVERSATION,
            status: 'queued',
        });
        const { view } = await mount(
            props({ conversation: queued, messages: [] }),
        );

        expect(view.byTestId('conversation-claim')?.textContent).toContain(
            'waiting for an agent',
        );
        expect(view.byTestId('composer-disabled')?.textContent).toContain(
            'not been accepted',
        );

        await click(view.byTestId('conversation-claim-button'));
        await waitFor(() =>
            expect(view.byTestId('conversation-claim')).toBeNull(),
        );

        expect(view.byTestId('composer-input')).not.toBeNull();
        expect(view.byTestId('end-chat')).not.toBeNull();
    });

    it('replaces the composer with a reason when the chat cannot be written to', async () => {
        for (const [status, text] of [
            ['ended', 'This chat has ended.'],
            ['closed', 'This chat is closed.'],
            [
                'missed',
                'Nobody answered this chat, so there is nothing to reply to.',
            ],
        ] as const) {
            const { view } = await mount(
                props({ conversation: activeChat({ status }) }),
            );

            expect(view.byTestId('composer-disabled')?.textContent).toBe(text);
            expect(view.byTestId('composer-input')).toBeNull();
            await view.unmount();
        }
    });

    it('shows the back arrow and a queue pill for phones while somebody waits', async () => {
        const { view, session } = await mount();

        expect(view.byTestId('conversation-back')?.getAttribute('href')).toBe(
            '/inbox',
        );
        expect(view.byTestId('conversation-queue-pill')).toBeNull();

        await act(async () =>
            session.store.dispatch({
                type: 'hydrate',
                queue: [makeConversationStaff()],
            }),
        );
        expect(
            view.byTestId('conversation-queue-pill')?.getAttribute('href'),
        ).toBe('/inbox');
        expect(view.byTestId('conversation-queue-pill')?.textContent).toBe('1');
    });
});

describe('attachments', () => {
    const choose = async (
        view: { byTestId: (id: string) => HTMLElement | null },
        ...files: File[]
    ) => {
        const input = view.byTestId('composer-file') as HTMLInputElement;

        Object.defineProperty(input, 'files', {
            value: files,
            configurable: true,
        });
        await act(async () => {
            input.dispatchEvent(new Event('change', { bubbles: true }));
        });
    };
    const stored = {
        ulid: 'att-1',
        mime: 'image/webp',
        size: 99,
        width: 10,
        height: 10,
        url: 'https://f.test/u',
        thumbUrl: 'https://f.test/t',
    };

    beforeEach(() => {
        vi.stubGlobal('XMLHttpRequest', FakeXhr);
    });

    it('uploads an image with progress, then sends it with the message', async () => {
        const { view } = await mount();

        await choose(view, new File(['x'], 'photo.png', { type: 'image/png' }));

        const chip = view.container.querySelector(
            '[data-testid^="composer-attachment-"][data-status="uploading"]',
        ) as HTMLElement;

        expect(chip.textContent).toContain('photo.png');
        expect(FakeXhr.last.url).toBe(
            `/api/v1/conversations/${CONVERSATION}/attachments`,
        );
        expect(
            (view.byTestId('composer-send') as HTMLButtonElement).disabled,
        ).toBe(true);

        await act(async () => FakeXhr.last.progress(40, 100));
        expect(chip.textContent).toContain('Uploading 40%');

        await act(async () => FakeXhr.last.reply(201, { data: stored }));
        expect(chip.getAttribute('data-status')).toBe('ready');
        expect(
            (view.byTestId('composer-send') as HTMLButtonElement).disabled,
        ).toBe(false);

        await click(view.byTestId('composer-send'));
        await waitFor(() =>
            expect(
                backend.current.calls(
                    'POST',
                    `/api/v1/conversations/${CONVERSATION}/messages`,
                ),
            ).toHaveLength(1),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${CONVERSATION}/messages`,
            )[0].body,
        ).toMatchObject({ attachments: ['att-1'] });
        expect(view.byTestId('composer-attachments')).toBeNull();
    });

    it('refuses a file that is not an allowed image before uploading it', async () => {
        const { view } = await mount();

        await choose(
            view,
            new File(['<svg/>'], 'logo.svg', { type: 'image/svg+xml' }),
        );

        expect(FakeXhr.instances).toHaveLength(0);
        expect(view.byTestId('composer-attachments')?.textContent).toContain(
            'Only JPEG, PNG, WebP or GIF images.',
        );
        expect(view.container.querySelector('[role="alert"]')).not.toBeNull();
    });

    it('refuses a file over the size limit', async () => {
        const { view } = await mount();
        const big = new File([new Uint8Array(1)], 'huge.png', {
            type: 'image/png',
        });

        Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
        await choose(view, big);

        expect(FakeXhr.instances).toHaveLength(0);
        expect(view.byTestId('composer-attachments')?.textContent).toContain(
            'Larger than 5 MB.',
        );
    });

    it('cancels a running upload when the agent removes it', async () => {
        const { view } = await mount();

        await choose(view, new File(['x'], 'photo.png', { type: 'image/png' }));
        await click(
            view.container.querySelector(
                '[data-testid^="composer-attachment-remove-"]',
            ) as HTMLElement,
        );

        expect(FakeXhr.last.aborted).toBe(true);
        expect(view.byTestId('composer-attachments')).toBeNull();
    });

    it("shows the server's reason when an upload is rejected", async () => {
        const { view } = await mount();

        await choose(view, new File(['x'], 'photo.png', { type: 'image/png' }));
        await act(async () =>
            FakeXhr.last.reply(422, {
                error: {
                    code: 'validation_failed',
                    message: 'Bad.',
                    details: { file: ['The file is not a valid image.'] },
                },
            }),
        );

        expect(view.byTestId('composer-attachments')?.textContent).toContain(
            'The file is not a valid image.',
        );
        expect(
            byTestId(view.container, 'composer-send')?.hasAttribute('disabled'),
        ).toBe(true);
    });
});

const MESSAGES_URL = `/api/v1/conversations/${CONVERSATION}/messages`;

const refuse = (
    status: number,
    code: string,
    message: string,
    details?: Record<string, string[]>,
) =>
    http.post(MESSAGES_URL, () =>
        HttpResponse.json(
            { error: { code, message, ...(details ? { details } : {}) } },
            { status },
        ),
    );

describe('a send that does not go through', () => {
    const failedBubble = (view: { container: HTMLElement }) =>
        view.container.querySelector<HTMLElement>('[data-status="failed"]');

    const attempt = async (
        view: { byTestId: (id: string) => HTMLElement | null },
        text: string,
    ) => {
        await fill(composer(view), text);
        await press(composer(view), 'Enter');
    };

    it('says why a message is too long, and offers no futile retry (only discard)', async () => {
        backend.server.use(
            refuse(422, 'validation_failed', 'Too long.', {
                body: [
                    'The body field must not be greater than 4000 characters.',
                ],
            }),
        );

        const { view } = await mount();

        await attempt(view, 'A very long message');
        await waitFor(() => expect(failedBubble(view)).not.toBeNull());

        const bubble = failedBubble(view) as HTMLElement;

        expect(bubble.textContent).toContain(
            'Not sent: the message is too long.',
        );
        expect(
            bubble.querySelector('[data-testid^="message-retry-"]'),
        ).toBeNull();
        expect(
            bubble.querySelector('[data-testid^="message-discard-"]'),
        ).not.toBeNull();
    });

    it('a refusal of the content (422) and a lost permission (403) are final too, with their own reason', async () => {
        backend.server.use(
            refuse(422, 'validation_failed', 'Nope.', { attachments: ['bad'] }),
        );

        const first = await mount();

        await attempt(first.view, 'With a picture');
        await waitFor(() => expect(failedBubble(first.view)).not.toBeNull());
        expect(failedBubble(first.view)?.textContent).toContain(
            'the server refused this message',
        );
        expect(
            failedBubble(first.view)?.querySelector(
                '[data-testid^="message-retry-"]',
            ),
        ).toBeNull();
        await first.view.unmount();

        backend.server.use(
            refuse(403, 'forbidden', 'This action is unauthorized.'),
        );

        const second = await mount();

        await attempt(second.view, 'Not mine any more');
        await waitFor(() => expect(failedBubble(second.view)).not.toBeNull());
        expect(failedBubble(second.view)?.textContent).toContain(
            'you cannot reply in this chat any more',
        );
        expect(
            failedBubble(second.view)?.querySelector(
                '[data-testid^="message-retry-"]',
            ),
        ).toBeNull();
    });

    it('a rate limit asks to wait and still allows the retry', async () => {
        backend.server.use(refuse(429, 'rate_limited', 'Too many requests.'));

        const { view } = await mount();

        await attempt(view, 'Fast fingers');
        await waitFor(() => expect(failedBubble(view)).not.toBeNull());

        expect(failedBubble(view)?.textContent).toContain('too many messages');
        expect(
            failedBubble(view)?.querySelector(
                '[data-testid^="message-retry-"]',
            ),
        ).not.toBeNull();
    });

    it('leaves one message per request: two quick sends go out one after the other, in the order they were typed', async () => {
        let inFlight = 0;
        let mostInFlight = 0;
        const order: string[] = [];
        let releaseFirst: () => void = () => undefined;
        const firstDone = new Promise<void>((resolve) => {
            releaseFirst = resolve;
        });

        backend.server.use(
            http.post(MESSAGES_URL, async ({ request }) => {
                const sent = (await request.json()) as {
                    client_msg_id: string;
                    body: string;
                };

                inFlight += 1;
                mostInFlight = Math.max(mostInFlight, inFlight);
                order.push(sent.body);

                if (sent.body === 'first') {
                    await firstDone;
                }

                inFlight -= 1;

                return HttpResponse.json(
                    {
                        data: makeAgentMessage({
                            ulid: fakeUlid(5100 + order.length),
                            seq: 3 + order.length,
                            conversation: CONVERSATION,
                            body: sent.body,
                            clientMsgId: sent.client_msg_id,
                            sender: {
                                type: 'agent',
                                name: 'Sam',
                                avatarUrl: null,
                                id: AGENT.id,
                            },
                        }),
                    },
                    { status: 201 },
                );
            }),
        );

        const { view } = await mount();

        await attempt(view, 'first');
        await attempt(view, 'second');
        // the second request has not left while the first is still out
        await act(
            async () => new Promise((resolve) => setTimeout(resolve, 60)),
        );
        expect(order).toEqual(['first']);

        releaseFirst();
        await waitFor(() => expect(order).toEqual(['first', 'second']));
        expect(mostInFlight).toBe(1);
    });

    it('a request that never answers fails after the deadline, so the next message is not stuck behind it', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        try {
            backend.server.use(
                http.post(MESSAGES_URL, () => new Promise(() => undefined)),
            );

            const { view } = await mount();

            await attempt(view, 'Hello?');
            await act(async () => {
                await vi.advanceTimersByTimeAsync(20_001);
            });
            await waitFor(() => expect(failedBubble(view)).not.toBeNull());

            expect(failedBubble(view)?.textContent).toContain(
                'the connection dropped',
            );
            expect(
                failedBubble(view)?.querySelector(
                    '[data-testid^="message-retry-"]',
                ),
            ).not.toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });

    it('gives the box a sane length limit', async () => {
        const { view } = await mount();

        expect(composer(view).maxLength).toBe(4000);
    });
});

describe('offline tickets and images', () => {
    it('does not offer to attach images to an offline ticket (the server only takes them for live chats)', async () => {
        const ticket = activeChat({ type: 'offline', category: null });
        const { view } = await mount(props({ conversation: ticket }));

        expect(view.byTestId('composer-input')).not.toBeNull();
        expect(view.byTestId('composer-attach')).toBeNull();
        expect(view.byTestId('composer-file')).toBeNull();
    });

    it('keeps the attach control for a live chat', async () => {
        const { view } = await mount();

        expect(view.byTestId('composer-attach')).not.toBeNull();
    });
});

describe("a chat that stops being the agent's", () => {
    it('re-reads it when it leaves the lists and then shows who has it, with the composer off', async () => {
        const { view, session } = await mount();

        await act(async () =>
            session.store.dispatch({
                type: 'hydrate',
                queue: [],
                mine: [activeChat()],
            }),
        );
        expect(view.byTestId('composer-input')).not.toBeNull();

        // somebody else has it now: the server's copy says so; the agent's own `conversation.updated` has it leave "My chats"
        const handedOver = activeChat({
            assignedAgent: { id: 99, name: 'Mia' },
        });

        backend.current.state.conversations.set(CONVERSATION, handedOver);
        await act(async () =>
            session.store.dispatch({
                type: 'conversationUpdated',
                conversation: handedOver,
                viewer: { id: AGENT.id, isAdmin: false },
            }),
        );
        await waitFor(() =>
            expect(view.byTestId('conversation-reassigned')).not.toBeNull(),
        );

        expect(view.byTestId('conversation-reassigned')?.textContent).toContain(
            'Mia',
        );
        expect(view.byTestId('composer-input')).toBeNull();
        expect(view.byTestId('composer-disabled')?.textContent).toBe(
            'This chat is no longer assigned to you.',
        );
    });

    it('when the server no longer lets the agent see the chat at all, it is read-only as well', async () => {
        const { view, session } = await mount();

        await act(async () =>
            session.store.dispatch({
                type: 'hydrate',
                queue: [],
                mine: [activeChat()],
            }),
        );

        backend.server.use(
            http.get(`/api/v1/conversations/${CONVERSATION}`, () =>
                HttpResponse.json(
                    { error: { code: 'forbidden', message: 'Forbidden.' } },
                    { status: 403 },
                ),
            ),
        );
        await act(async () =>
            session.store.dispatch({
                type: 'removed',
                conversation: CONVERSATION,
            }),
        );
        await waitFor(() =>
            expect(view.byTestId('conversation-reassigned')).not.toBeNull(),
        );

        expect(view.byTestId('composer-input')).toBeNull();
    });

    it("an admin watching a colleague's chat is not locked out by this", async () => {
        const { view, session } = await mount(props(), { viewer: ADMIN });

        await act(async () =>
            session.store.dispatch({
                type: 'hydrate',
                queue: [],
                mine: [activeChat()],
            }),
        );
        await act(async () =>
            session.store.dispatch({
                type: 'removed',
                conversation: CONVERSATION,
            }),
        );

        expect(view.byTestId('conversation-reassigned')).toBeNull();
    });
});
