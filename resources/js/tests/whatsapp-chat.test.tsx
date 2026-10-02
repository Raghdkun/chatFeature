import { act } from 'react';
import { toast } from 'sonner';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { ChatView } from '@/components/whatsapp/chat-view';
import { fakeTime, fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { READ_DELAY_MS } from '@/lib/realtime/whatsapp/use-wa-chat';
import {
    makeHandoff,
    makeLinkedWaChat,
    makeWaChat,
    makeWaChatDetail,
    makeWaDocument,
    makeWaImage,
    makeWaMessage,
    makeWaReply,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import type { WaChat, WaMessage } from '@/lib/whatsapp/types';
import { body, fill, keyDown } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { click } from '@/tests/render';
import {
    ADMIN,
    renderWa,
    useWaBackend,
    waitFor,
    type WaRender,
} from '@/tests/whatsapp-kit';

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

vi.setConfig({ testTimeout: 20_000 });

const backend = useWaBackend();
const byTestId = body.byTestId;

const SESSION = makeWaSession({ ulid: fakeUlid(5000), name: 'support-main' });
const CHAT_ULID = fakeUlid(6001);

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
});

const chat = (overrides: Partial<WaChat> = {}) =>
    makeWaChat({
        ulid: CHAT_ULID,
        pushName: 'Vera Visitor',
        phone: '+4915112345678',
        session: { ulid: SESSION.ulid, name: SESSION.name },
        ...overrides,
    });

const inbound = (text: string, n: number, overrides: Partial<WaMessage> = {}) =>
    makeWaMessage({
        ulid: fakeUlid(7000 + n),
        chat: CHAT_ULID,
        body: text,
        createdAt: fakeTime(n * 10),
        waTimestamp: fakeTime(n * 10),
        ...overrides,
    });

const reply = (text: string, n: number, overrides: Partial<WaMessage> = {}) =>
    makeWaReply({
        ulid: fakeUlid(7000 + n),
        chat: CHAT_ULID,
        body: text,
        sentBy: { id: ADMIN.id, name: ADMIN.name },
        createdAt: fakeTime(n * 10),
        waTimestamp: fakeTime(n * 10),
        ...overrides,
    });

async function open(
    options: {
        chat?: WaChat;
        messages?: WaMessage[];
        hasOlder?: boolean;
        replyOnlyToInbound?: boolean;
        sockets?: boolean;
        sessionStatus?: 'ready' | 'disconnected' | null;
        detail?: ReturnType<typeof makeWaChatDetail>;
    } = {},
): Promise<WaRender> {
    const current = options.chat ?? chat();
    const messages = options.messages ?? [];

    backend.current.state.chats.set(current.ulid, current);
    backend.current.state.messages.set(current.ulid, messages);

    const rendered = await renderWa(
        <ChatView
            detail={options.detail ?? makeWaChatDetail({ chat: current })}
            messages={messages}
            hasOlder={options.hasOlder ?? false}
            replyOnlyToInbound={options.replyOnlyToInbound ?? true}
        />,
        { sockets: options.sockets },
    );

    if (options.sessionStatus !== null) {
        await act(async () =>
            rendered.session.store.dispatch({
                type: 'sessionsLoaded',
                sessions: [
                    { ...SESSION, status: options.sessionStatus ?? 'ready' },
                ],
            }),
        );
    }

    return rendered;
}

const input = () => byTestId('wa-composer-input') as HTMLTextAreaElement;
const send = () => byTestId('wa-composer-send') as HTMLButtonElement;
const bubbles = () =>
    Array.from(
        document.body.querySelectorAll<HTMLElement>(
            '[data-testid^="wa-message-"]:not([data-testid*="status"]):not([data-testid*="failure"]):not([data-testid*="retry"]):not([data-testid*="discard"]):not([data-testid*="media"]):not([data-testid*="image"])',
        ),
    );
const posts = () =>
    backend.current.state.calls.filter(
        (call) => call.method === 'POST' && call.path.endsWith('/messages'),
    );
const messageGets = () =>
    backend.current.state.calls.filter(
        (call) => call.method === 'GET' && call.path.endsWith('/messages'),
    );

async function type(text: string): Promise<void> {
    await fill(input(), text);
}

async function enter(): Promise<void> {
    await keyDown(input(), 'Enter');
}

describe('the transcript', () => {
    it('is a labelled live log with the customer on one side and the replies on the other', async () => {
        const messages = [
            inbound('Hello, I need help', 1),
            reply('Of course, what is wrong?', 2, { status: 'read' }),
        ];

        await open({ messages });

        const log = byTestId('wa-transcript');

        expect(log?.getAttribute('role')).toBe('log');
        expect(log?.getAttribute('aria-live')).toBe('polite');
        expect(log?.getAttribute('aria-label')).toBe(
            'Messages with Vera Visitor',
        );
        expect(
            byTestId(`wa-message-${messages[0].ulid}`)?.dataset.direction,
        ).toBe('in');
        expect(
            byTestId(`wa-message-${messages[1].ulid}`)?.dataset.direction,
        ).toBe('out');
        expect(log?.textContent).toContain('Hello, I need help');
        expect(log?.textContent).toContain('Ada');
    });

    it('draws day dividers between days', async () => {
        const messages = [
            inbound('Yesterday', 1),
            inbound('Much later', 1, {
                ulid: fakeUlid(7099),
                createdAt: fakeTime(3 * 24 * 3600),
            }),
        ];

        await open({ messages });

        const dividers = document.body.querySelectorAll(
            '[data-testid="wa-transcript"] li[aria-label]',
        );

        expect(dividers).toHaveLength(2);
    });

    it('shows the delivery state of a reply as ticks with words for assistive technology', async () => {
        const messages = [
            reply('one', 1, { status: 'sent' }),
            reply('two', 3, { status: 'delivered' }),
            reply('three', 5, { status: 'read' }),
            reply('four', 7, { status: 'pending' }),
        ];

        await open({ messages });

        // Every distinct status shows its own ticks, even a few seconds apart.
        const state = (n: number) =>
            byTestId(`wa-message-status-${messages[n].ulid}`);

        expect(state(0)?.textContent).toBe('Sent');
        expect(state(1)?.textContent).toBe('Delivered');
        expect(state(2)?.textContent).toBe('Read');
        expect(state(2)?.dataset.status).toBe('read');
        expect(state(3)?.textContent).toBe('Sending');
    });

    it('says why a reply the gateway could not deliver failed', async () => {
        const failed = reply('lost', 1, {
            status: 'failed',
            error: 'The number is not on WhatsApp',
        });

        await open({ messages: [failed] });

        expect(byTestId(`wa-message-failure-${failed.ulid}`)?.textContent).toBe(
            'Not delivered: The number is not on WhatsApp',
        );
        // A reply the server rejected after accepting it has no retry: a new reply is typed instead.
        expect(byTestId(`wa-message-retry-${failed.ulid}`)).toBeNull();
    });

    it('shows a stored photo through its signed URL', async () => {
        const photo = makeWaImage({ ulid: fakeUlid(7050), chat: CHAT_ULID });

        await open({ messages: [photo] });

        const image = byTestId(`wa-message-image-${photo.ulid}`);

        expect(image?.querySelector('img')?.getAttribute('src')).toBe(
            photo.media?.url,
        );
        expect(image?.getAttribute('aria-label')).toBe('Open photo');
    });

    it('opens the photo in the lightbox', async () => {
        const photo = makeWaImage({ ulid: fakeUlid(7050), chat: CHAT_ULID });

        await open({ messages: [photo] });
        await click(byTestId(`wa-message-image-${photo.ulid}`));

        expect(byTestId('lightbox')).not.toBeNull();
    });

    it('asks for fresh signed URLs when a photo fails to load, and shows the new one', async () => {
        const photo = makeWaImage({ ulid: fakeUlid(7050), chat: CHAT_ULID });

        await open({ messages: [photo] });

        const fresh = {
            ...photo,
            media: {
                ...(photo.media as NonNullable<typeof photo.media>),
                url: 'https://files.test/whatsapp/fresh?signature=new',
            },
        };

        backend.current.state.messages.set(CHAT_ULID, [fresh]);

        const before = messageGets().length;

        await act(async () => {
            byTestId(`wa-message-image-${photo.ulid}`)
                ?.querySelector('img')
                ?.dispatchEvent(new Event('error'));
        });
        await waitFor(() => expect(messageGets().length).toBe(before + 1));
        await waitFor(() =>
            expect(
                byTestId(`wa-message-image-${photo.ulid}`)
                    ?.querySelector('img')
                    ?.getAttribute('src'),
            ).toBe('https://files.test/whatsapp/fresh?signature=new'),
        );
        expect(messageGets().at(-1)?.query.limit).toBe('100');
    });

    it('records documents, audio and voice as typed placeholders: "attachment not stored", with the name and size', async () => {
        const document_ = makeWaDocument({
            ulid: fakeUlid(7060),
            chat: CHAT_ULID,
        });
        const voice = makeWaMessage({
            ulid: fakeUlid(7061),
            chat: CHAT_ULID,
            type: 'voice',
            body: null,
            media: {
                mime: 'audio/ogg',
                filename: null,
                size: 20_000,
                available: false,
                url: null,
            },
            createdAt: fakeTime(900),
        });

        await open({ messages: [document_, voice] });

        const doc = byTestId(`wa-message-media-${document_.ulid}`);

        expect(doc?.textContent).toContain('Document');
        expect(doc?.textContent).toContain('attachment not stored');
        expect(doc?.textContent).toContain('invoice.pdf');
        expect(doc?.textContent).toMatch(/117\s?kB/i);
        expect(
            byTestId(`wa-message-media-${voice.ulid}`)?.textContent,
        ).toContain('Voice message');
        // Never a download link for a file this app does not keep.
        expect(doc?.querySelector('a')).toBeNull();
    });

    it('shows a plain text only: HTML stays text, and URLs become safe links', async () => {
        const messages = [
            inbound('<img src=x onerror=alert(1)> <b>bold</b>', 1),
            inbound('see https://example.com/page now', 2),
            inbound('javascript:alert(1)', 3),
        ];

        await open({ messages });

        const log = byTestId('wa-transcript') as HTMLElement;

        expect(log.querySelector('img')).toBeNull();
        expect(log.querySelector('b')).toBeNull();
        expect(log.textContent).toContain('<img src=x onerror=alert(1)>');

        const links = Array.from(log.querySelectorAll('a'));

        expect(links).toHaveLength(1);
        expect(links[0].getAttribute('href')).toBe('https://example.com/page');
        expect(links[0].getAttribute('rel')).toBe(
            'noopener noreferrer nofollow',
        );
        expect(links[0].getAttribute('target')).toBe('_blank');
    });
});

describe('sending a reply', () => {
    it('shows the reply at once, sends it with a client id, and settles on the stored copy', async () => {
        backend.current.state.sendDelayMs = 150;
        await open({ messages: [inbound('Hi', 1)] });

        await type('On my way');
        await enter();

        // Optimistic: there before the server answered, still pending.
        expect(input().value).toBe('');
        expect(bubbles()).toHaveLength(2);
        expect(bubbles()[1].dataset.status).toBe('pending');
        expect(bubbles()[1].textContent).toContain('On my way');

        await waitFor(() => expect(posts()).toHaveLength(1));

        const sent = posts()[0].body as { body: string; client_msg_id: string };

        expect(sent.body).toBe('On my way');
        expect(sent.client_msg_id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);

        await waitFor(() =>
            expect(bubbles()[1].dataset.testid).not.toBe(
                `wa-message-${sent.client_msg_id}`,
            ),
        );
        // One bubble, not two: the stored copy replaced the optimistic one.
        expect(bubbles()).toHaveLength(2);
        expect(bubbles()[1].textContent).toContain('On my way');
    });

    it('moves the tick forward as the acks arrive, and never back', async () => {
        await open({ messages: [inbound('Hi', 1)] });
        await type('Ping');
        await enter();
        await waitFor(() => expect(posts()).toHaveLength(1));

        const clientId = (posts()[0].body as { client_msg_id: string })
            .client_msg_id;

        // The stored copy has replaced the optimistic bubble (whose id is the client's).
        await waitFor(() =>
            expect(bubbles()[1].dataset.testid).not.toBe(
                `wa-message-${clientId}`,
            ),
        );

        const ulid =
            bubbles()[1].dataset.testid?.replace('wa-message-', '') ?? '';
        const message = (status: WaMessage['status']): WaMessage => ({
            ...reply('Ping', 9, { ulid, status }),
        });

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.updated', {
                v: 1,
                message: message('read'),
            }),
        );
        expect(byTestId(`wa-message-status-${ulid}`)?.textContent).toBe('Read');

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.updated', {
                v: 1,
                message: message('delivered'),
            }),
        );
        expect(byTestId(`wa-message-status-${ulid}`)?.textContent).toBe('Read');
    });

    it('keeps Shift+Enter for a new line, counts the characters and does not send an empty reply', async () => {
        await open();

        expect(send().disabled).toBe(true);
        await type('   ');
        expect(send().disabled).toBe(true);

        await type('Hello');
        expect(byTestId('wa-composer-count')?.textContent).toBe('5 / 4096');
        expect(send().disabled).toBe(false);

        await act(async () => {
            input().dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    shiftKey: true,
                    bubbles: true,
                    cancelable: true,
                }),
            );
        });
        expect(posts()).toHaveLength(0);

        await enter();
        await waitFor(() => expect(posts()).toHaveLength(1));
    });

    it('sends nothing while an input method is composing', async () => {
        await open();
        await type('こんにちは');
        await act(async () => {
            const event = new KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
                isComposing: true,
            });

            input().dispatchEvent(event);
        });

        expect(posts()).toHaveLength(0);
    });

    it('shows one bubble when the stored copy arrives over the websocket before the answer', async () => {
        backend.current.state.sendDelayMs = 300;
        await open({ messages: [inbound('Hi', 1)] });

        await type('Race me');
        await enter();
        await waitFor(() => expect(posts()).toHaveLength(1));

        // The server has stored it; the event is faster than the POST's answer.
        const stored = backend.current.state.messages
            .get(CHAT_ULID)
            ?.find((message) => message.body === 'Race me') as WaMessage;

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.created', {
                v: 1,
                chat: chat(),
                message: stored,
            }),
        );

        const racing = () =>
            bubbles().filter((b) => b.textContent?.includes('Race me'));

        expect(racing()).toHaveLength(1);
        expect(racing()[0].dataset.testid).toBe(`wa-message-${stored.ulid}`);

        // The answer lands later: still one.
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 450));
        });
        expect(racing()).toHaveLength(1);
    });

    it('lists consecutive replies in the order they were typed', async () => {
        await open();

        await type('first');
        await enter();
        await type('second');
        await enter();
        await waitFor(() => expect(posts()).toHaveLength(2));

        expect(
            posts().map((call) => (call.body as { body: string }).body),
        ).toEqual(['first', 'second']);
        await waitFor(() =>
            expect(bubbles().map((b) => b.textContent)).toEqual([
                expect.stringContaining('first'),
                expect.stringContaining('second'),
            ]),
        );
    });
});

describe('a reply that does not go out', () => {
    it('keeps it, says why, and sends it again on Retry', async () => {
        backend.current.state.failSends = [
            { status: 500, code: 'server_error' },
        ];
        await open();

        await type('try me');
        await enter();

        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-failure-"]',
                ),
            ).not.toBeNull(),
        );

        const failure = document.body.querySelector(
            '[data-testid^="wa-message-failure-"]',
        ) as HTMLElement;
        const clientId =
            failure.dataset.testid?.replace('wa-message-failure-', '') ?? '';

        expect(failure.textContent).toBe('Not sent.');
        expect(byTestId(`wa-message-retry-${clientId}`)).not.toBeNull();

        await click(byTestId(`wa-message-retry-${clientId}`));
        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-failure-"]',
                ),
            ).toBeNull(),
        );

        expect(
            posts().map(
                (call) =>
                    (call.body as { client_msg_id: string }).client_msg_id,
            ),
        ).toEqual([clientId, clientId]);
        await waitFor(() => expect(bubbles()).toHaveLength(1));
    });

    it('lets the administrator discard it', async () => {
        backend.current.state.failSends = [
            { status: 500, code: 'server_error' },
        ];
        await open();
        await type('never mind');
        await enter();
        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-discard-"]',
                ),
            ).not.toBeNull(),
        );
        await click(
            document.body.querySelector('[data-testid^="wa-message-discard-"]'),
        );

        expect(bubbles()).toHaveLength(0);
    });

    it('does not send twice when the answer was lost but the server stored the reply: Retry looks first', async () => {
        backend.current.state.loseAnswers = 1;
        await open({ messages: [inbound('Hi', 1)] });

        await type('Only once please');
        await enter();
        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-failure-"]',
                )?.textContent,
            ).toContain('no connection'),
        );

        const clientId =
            document.body
                .querySelector('[data-testid^="wa-message-failure-"]')
                ?.getAttribute('data-testid')
                ?.replace('wa-message-failure-', '') ?? '';

        await click(byTestId(`wa-message-retry-${clientId}`));
        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-failure-"]',
                ),
            ).toBeNull(),
        );

        // One POST in total: the second attempt found the reply already stored and adopted it.
        expect(posts()).toHaveLength(1);
        expect(
            bubbles().filter((b) =>
                b.textContent?.includes('Only once please'),
            ),
        ).toHaveLength(1);
    });

    it.each([
        [
            'the session is not connected',
            { status: 409, code: 'session_not_ready' },
            'the WhatsApp session is not connected',
            true,
        ],
        [
            'the daily limit is reached',
            { status: 429, code: 'daily_cap_reached' },
            'the daily sending limit is reached',
            true,
        ],
        [
            'the customer never wrote first',
            { status: 409, code: 'reply_only_to_inbound' },
            'this customer has not written first',
            false,
        ],
        [
            'the message is refused as too long',
            { status: 422, code: 'validation_failed' },
            'the server refused',
            false,
        ],
    ])('explains it when %s', async (_name, failure, text, retryable) => {
        backend.current.state.failSends = [failure];
        await open();
        await type('hello');
        await enter();
        await waitFor(() =>
            expect(
                document.body.querySelector(
                    '[data-testid^="wa-message-failure-"]',
                ),
            ).not.toBeNull(),
        );

        const element = document.body.querySelector(
            '[data-testid^="wa-message-failure-"]',
        ) as HTMLElement;
        const id =
            element.dataset.testid?.replace('wa-message-failure-', '') ?? '';

        expect(element.textContent).toContain(text);
        expect(byTestId(`wa-message-retry-${id}`) !== null).toBe(retryable);
        // Discard is always there.
        expect(byTestId(`wa-message-discard-${id}`)).not.toBeNull();
    });

    it('pauses the box for as long as the server asked ("Retry-After") and then lets the next reply go', async () => {
        backend.current.state.failSends = [
            { status: 429, code: 'SEND_PACING_LIMITED', retryAfter: 2 },
        ];
        await open();
        await type('too fast');
        await enter();

        await waitFor(() =>
            expect(byTestId('wa-composer-paused')).not.toBeNull(),
        );
        expect(byTestId('wa-composer-paused')?.textContent).toMatch(
            /[23] seconds/,
        );
        expect(
            document.body.querySelector('[data-testid^="wa-message-failure-"]')
                ?.textContent,
        ).toContain('Try again in 2 seconds');

        await type('next');
        expect(send().disabled).toBe(true);
        await enter();
        expect(posts()).toHaveLength(1);

        await waitFor(
            () => expect(byTestId('wa-composer-paused')).toBeNull(),
            6000,
        );
        expect(send().disabled).toBe(false);
    });
});

describe('when a reply cannot be sent at all', () => {
    it('replaces the box when the session is not connected, with a way to the settings, and brings it back when it reconnects', async () => {
        const { session } = await open({ sessionStatus: 'disconnected' });

        expect(byTestId('wa-composer-disabled')?.dataset.reason).toBe(
            'session_not_ready',
        );
        expect(byTestId('wa-composer-input')).toBeNull();
        expect(
            byTestId('wa-composer-disabled')
                ?.querySelector('a')
                ?.getAttribute('href'),
        ).toBe('/settings/whatsapp');

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.session.status', {
                v: 1,
                session: { ...SESSION, status: 'ready' },
            }),
        );

        expect(byTestId('wa-composer-disabled')).toBeNull();
        expect(byTestId('wa-composer-input')).not.toBeNull();
        expect(session.store.getState().sessions[SESSION.ulid].status).toBe(
            'ready',
        );
    });

    it('says so when the customer has not written first and replies are limited to those who did', async () => {
        await open({ chat: chat({ inboundInitiated: false }) });

        expect(byTestId('wa-composer-disabled')?.dataset.reason).toBe(
            'not_inbound',
        );
        expect(byTestId('wa-composer-disabled')?.textContent).toContain(
            'wrote first',
        );

        await act(async () => undefined);
    });

    it('lets the administrator write when that limit is switched off', async () => {
        await open({
            chat: chat({ inboundInitiated: false }),
            replyOnlyToInbound: false,
        });

        expect(byTestId('wa-composer-input')).not.toBeNull();
    });
});

describe('reading', () => {
    it('marks the chat read a moment after it is opened, and tells the server', async () => {
        await open({ chat: chat({ unreadByAdmin: 3 }) });

        await waitFor(() =>
            expect(
                backend.current.state.calls.some(
                    (call) =>
                        call.method === 'POST' && call.path.endsWith('/read'),
                ),
            ).toBe(true),
        );
        expect(READ_DELAY_MS).toBeGreaterThan(0);
        expect(backend.current.state.chats.get(CHAT_ULID)?.unreadByAdmin).toBe(
            0,
        );
    });

    it('does not call the server for a chat with nothing unread', async () => {
        await open({ chat: chat({ unreadByAdmin: 0 }) });
        await act(async () => {
            await new Promise((resolve) =>
                setTimeout(resolve, READ_DELAY_MS + 100),
            );
        });

        expect(
            backend.current.state.calls.some((call) =>
                call.path.endsWith('/read'),
            ),
        ).toBe(false);
    });

    it('reads a message that arrives while the chat is open', async () => {
        const { session } = await open({ chat: chat({ unreadByAdmin: 0 }) });

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.created', {
                v: 1,
                chat: chat({ unreadByAdmin: 1 }),
                message: inbound('Are you there?', 5),
            }),
        );

        expect(byTestId('wa-transcript')?.textContent).toContain(
            'Are you there?',
        );
        await waitFor(() =>
            expect(
                session.store.getState().chats[CHAT_ULID].unreadByAdmin,
            ).toBe(0),
        );
    });
});

describe('history and catching up', () => {
    it('loads older messages on request and drops the button when there are no more', async () => {
        const older = [inbound('ancient', 1), inbound('old', 2)];
        const newest = inbound('newest', 3);

        backend.current.state.messages.set(CHAT_ULID, [...older, newest]);
        await open({ messages: [newest], hasOlder: true });
        backend.current.state.messages.set(CHAT_ULID, [...older, newest]);

        await click(byTestId('wa-load-older'));
        await waitFor(() =>
            expect(byTestId('wa-transcript')?.textContent).toContain('ancient'),
        );

        expect(messageGets().at(-1)?.query.before_id).toBe(newest.ulid);
        expect(byTestId('wa-load-older')).toBeNull();
    });

    it('reads what it missed when the websocket comes back', async () => {
        await open({ messages: [inbound('Hi', 1)] });

        const missed = inbound('You there?', 2);

        backend.current.state.messages.set(CHAT_ULID, [
            inbound('Hi', 1),
            missed,
        ]);
        await act(async () => fakeEcho.setConnection('reconnecting'));
        await act(async () => fakeEcho.setConnection('connected'));

        await waitFor(() =>
            expect(byTestId('wa-transcript')?.textContent).toContain(
                'You there?',
            ),
        );
    });

    it('polls every 15 seconds without a websocket, and says so', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            await open({ messages: [inbound('Hi', 1)], sockets: false });

            expect(byTestId('connection-banner-conversation')).not.toBeNull();

            const missed = inbound('Polled in', 2);

            backend.current.state.messages.set(CHAT_ULID, [
                inbound('Hi', 1),
                missed,
            ]);

            await act(async () => {
                vi.advanceTimersByTime(15_000);
            });
            await waitFor(() =>
                expect(byTestId('wa-transcript')?.textContent).toContain(
                    'Polled in',
                ),
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it('refreshes the statuses of replies that were not settled when it catches up', async () => {
        const sent = reply('Did you get it?', 2, { status: 'sent' });

        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            await open({
                messages: [inbound('Hi', 1), sent, inbound('Yes', 3)],
                sockets: false,
            });

            backend.current.state.messages.set(CHAT_ULID, [
                inbound('Hi', 1),
                { ...sent, status: 'read' },
                inbound('Yes', 3),
            ]);

            await act(async () => {
                vi.advanceTimersByTime(15_000);
            });
            await waitFor(() =>
                expect(
                    byTestId(`wa-message-status-${sent.ulid}`)?.textContent,
                ).toBe('Read'),
            );
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('the header and the details', () => {
    it('shows who the chat is with, the number, the session and what links it to the website', async () => {
        const linked = makeLinkedWaChat({
            ulid: CHAT_ULID,
            pushName: 'Vera Visitor',
            phone: '+4915112345678',
            session: { ulid: SESSION.ulid, name: SESSION.name },
        });

        await open({ chat: linked });

        expect(byTestId('wa-chat-name')?.textContent).toBe('Vera Visitor');
        expect(byTestId('wa-chat-header')?.textContent).toContain(
            '+4915112345678',
        );
        expect(byTestId('wa-chat-header')?.textContent).toContain(
            'support-main',
        );
        expect(byTestId('wa-chat-linked')?.textContent).toBe(
            'Main site · Sales',
        );
    });

    it('opens the details: contact, session, the visitor and the hand-off code that linked it', async () => {
        const linked = makeLinkedWaChat({
            ulid: CHAT_ULID,
            session: { ulid: SESSION.ulid, name: SESSION.name },
        });
        const detail = makeWaChatDetail({
            chat: linked,
            visitor: {
                ulid: fakeUlid(300),
                name: 'Vera V.',
                email: 'vera@example.com',
                phone: '+49 151 111',
                verified: true,
            },
            handoff: {
                code: makeHandoff().code,
                createdAt: fakeTime(-600),
                consumedAt: fakeTime(-300),
            },
        });

        await open({ chat: linked, detail });
        await click(byTestId('wa-chat-info'));

        const sheet = byTestId('wa-details') as HTMLElement;

        expect(sheet.textContent).toContain('+4915112345678');
        expect(sheet.textContent).toContain('support-main');
        expect(sheet.textContent).toContain('Main site');
        expect(sheet.textContent).toContain('Sales');
        expect(sheet.textContent).toContain('Vera V.');
        expect(sheet.textContent).toContain('vera@example.com');
        expect(byTestId('wa-details-code')?.textContent).toBe('K7M2QX4P');
        expect(sheet.textContent).toContain('The customer');
    });

    it('says that an unlinked chat matched no code', async () => {
        await open();
        await click(byTestId('wa-chat-info'));

        expect(byTestId('wa-details-unlinked')).not.toBeNull();
    });
});

describe('archiving', () => {
    it('archives the chat, says so, and offers to move it back', async () => {
        await open();

        await click(byTestId('wa-archive'));
        await waitFor(() =>
            expect(byTestId('wa-chat-view')?.dataset.status).toBe('archived'),
        );

        expect(toast.success).toHaveBeenCalledWith('Chat archived.');
        expect(byTestId('wa-archive')?.getAttribute('aria-label')).toBe(
            'Move back to inbox',
        );
        expect(byTestId('wa-chat-archived')).not.toBeNull();

        await click(byTestId('wa-archive'));
        await waitFor(() =>
            expect(byTestId('wa-chat-view')?.dataset.status).toBe('open'),
        );
        expect(toast.success).toHaveBeenLastCalledWith(
            'Chat moved back to the inbox.',
        );
    });

    it('says so when archiving fails', async () => {
        backend.current.state.forbidden = true;
        await open();

        await click(byTestId('wa-archive'));
        await waitFor(() => expect(toast.error).toHaveBeenCalled());

        expect(byTestId('wa-chat-view')?.dataset.status).toBe('open');
    });
});
