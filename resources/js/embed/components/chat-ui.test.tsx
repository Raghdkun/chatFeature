import { act } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { AttachmentData } from '@/lib/chat/types';
import { fakeTime } from '@/lib/chat/fixtures';
import { fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { useBackend } from '@/tests/msw/server';
import { createHarness, makeInit } from '@/tests/embed-harness';
import {
    flushUi,
    press,
    renderPanel,
    run,
    text,
    waitFor,
} from '@/tests/embed-render';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (root: ParentNode, id: string): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

/** An active chat that was resumed from a stored session (so the transcript is whatever the test seeded). */
async function activeChat(
    seed?: (backend: ReturnType<typeof useBackend>) => void,
    options: {
        open?: boolean;
        backend?: Parameters<typeof useBackend>[0];
    } = {},
) {
    const backend = useBackend(options.backend);
    const stored = backend.issueToken();

    backend.seedConversation(stored.token, 'active');
    seed?.(backend);

    const h = createHarness({ backend });
    const view = await renderPanel(h);

    await run(() => h.init(makeInit({ visitorSession: stored })));

    if (options.open !== false) {
        await run(() => h.open());
        // the panel focuses its first control on the next frame: let that settle before a test moves focus itself
        await run(
            () =>
                new Promise<void>((resolve) =>
                    requestAnimationFrame(() => resolve()),
                ),
        );
    }

    await waitFor(() => h.socket()?.status() === 'connected');

    return { backend, h, view, c: view.container };
}

function pickFile(input: HTMLInputElement, files: File[]): Promise<void> {
    Object.defineProperty(input, 'files', { value: files, configurable: true });

    return act(async () => {
        input.dispatchEvent(new Event('change', { bubbles: true }));
    });
}

const png = (name = 'photo.png', size = 1000): File => {
    const file = new File(['x'], name, { type: 'image/png' });

    Object.defineProperty(file, 'size', { value: size });

    return file;
};

describe('message list', () => {
    it('shows a date separator, grouped bubbles, a system line and the agent name once per run', async () => {
        const { c } = await activeChat((backend) => {
            backend.agentSays('First', {
                createdAt: new Date(2026, 10, 18, 10, 0).toISOString(),
            });
            backend.agentSays('Second', {
                createdAt: new Date(2026, 10, 18, 10, 1).toISOString(),
            });
            backend.agentSays('Next day', {
                createdAt: new Date(2026, 10, 19, 9, 0).toISOString(),
            });
        });
        const list = byTestId(c, 'message-list');

        expect(list?.querySelectorAll('time').length).toBeGreaterThanOrEqual(2);
        expect(text(list)).toContain('First');
        // one name label for the two messages of the first run
        expect((text(list).match(/Sam/g) ?? []).length).toBe(2);
        expect(all(c, 'message-image')).toHaveLength(0);
    });

    it('renders delivered and seen ticks from the receipts', async () => {
        const { backend, h, c } = await activeChat();

        await run(() => h.controller.send({ body: 'Did you get this?' }));
        await waitFor(
            () =>
                c.querySelector(
                    '[data-sender="visitor"][data-status="sent"]',
                ) !== null,
        );

        const bubble = (): HTMLElement =>
            c.querySelector<HTMLElement>(
                '[data-sender="visitor"]',
            ) as HTMLElement;

        expect(text(bubble())).toContain('Sent');

        const seq = h.state().messages.at(-1)?.seq ?? 0;

        await run(() =>
            h.socket()?.emit('message.created', {
                v: 1,
                message: {
                    ...backend.state.messages.at(-1),
                    deliveredAt: fakeTime(5),
                },
            }),
        );
        expect(bubble().dataset.status).toBe('delivered');
        expect(text(bubble())).toContain('Delivered');

        await run(() =>
            h.socket()?.emit('message.seen', {
                v: 1,
                upToSeq: seq,
                by: 'agent',
                at: fakeTime(9),
            }),
        );
        expect(bubble().dataset.status).toBe('seen');
        expect(text(bubble())).toContain('Seen');
    });

    it('ticks go sent, delivered, seen live from the receipt events (no resent message)', async () => {
        const { h, c } = await activeChat();

        await run(() => h.controller.send({ body: 'Live ticks' }));
        await waitFor(
            () =>
                c.querySelector(
                    '[data-sender="visitor"][data-status="sent"]',
                ) !== null,
        );

        const bubble = (): HTMLElement =>
            c.querySelector<HTMLElement>(
                '[data-sender="visitor"]',
            ) as HTMLElement;
        const seq = h.state().messages.at(-1)?.seq ?? 0;

        expect(text(bubble())).toContain('Sent');

        await run(() =>
            h.socket()?.emit('message.delivered', {
                v: 1,
                upToSeq: seq,
                by: 'agent',
                at: fakeTime(5),
            }),
        );
        expect(bubble().dataset.status).toBe('delivered');
        expect(text(bubble())).toContain('Delivered');

        await run(() =>
            h.socket()?.emit('message.seen', {
                v: 1,
                upToSeq: seq,
                by: 'agent',
                at: fakeTime(9),
            }),
        );
        expect(bubble().dataset.status).toBe('seen');
        expect(text(bubble())).toContain('Seen');
    });

    it('turns URLs into safe links and shows everything else as text', async () => {
        const { c } = await activeChat((backend) => {
            backend.agentSays(
                'Docs: https://example.com/help and www.example.org.',
            );
            backend.agentSays(
                '<script>alert(1)</script> <img src=x onerror=alert(2)> javascript:alert(3)',
            );
            backend.agentSays('https://user:pass@evil.test/');
        });
        const list = byTestId(c, 'message-list') as HTMLElement;
        const links = Array.from(list.querySelectorAll('a'));

        expect(links.map((a) => a.getAttribute('href'))).toEqual([
            'https://example.com/help',
            'https://www.example.org/',
        ]);

        for (const link of links) {
            expect(link.getAttribute('rel')).toBe(
                'noopener noreferrer nofollow',
            );
            expect(link.getAttribute('target')).toBe('_blank');
        }

        expect(list.querySelector('script')).toBeNull();
        expect(list.querySelector('img[src="x"]')).toBeNull();
        expect(text(list)).toContain('<script>alert(1)</script>');
        expect(text(list)).toContain('javascript:alert(3)');
        expect(text(list)).toContain('https://user:pass@evil.test/');
    });

    it('gives each message its own direction, so an English sentence in an Arabic panel (and the reverse) reads correctly', async () => {
        const { c } = await activeChat((backend) => {
            backend.agentSays('Where is my order #48213?');
            backend.agentSays('مرحبا، أحتاج مساعدة بخصوص طلبي.');
        });
        const list = byTestId(c, 'message-list') as HTMLElement;
        const bodies = Array.from(list.querySelectorAll('p[dir="auto"]'));

        expect(bodies.map((body) => body.textContent)).toEqual([
            'Where is my order #48213?',
            'مرحبا، أحتاج مساعدة بخصوص طلبي.',
        ]);
    });

    it('shows the agent typing (visually and to screen readers) until it stops', async () => {
        const { h, c } = await activeChat();

        expect(byTestId(c, 'typing-indicator')).toBeNull();

        await run(() =>
            h.socket()?.emit('client-typing', { actor: 'agent', typing: true }),
        );
        expect(byTestId(c, 'typing-indicator')).not.toBeNull();
        expect(c.querySelector('[role="status"].sr-only')?.textContent).toBe(
            'Sam is typing…',
        );

        await run(() =>
            h
                .socket()
                ?.emit('client-typing', { actor: 'agent', typing: false }),
        );
        expect(byTestId(c, 'typing-indicator')).toBeNull();
        expect(c.querySelector('[role="status"].sr-only')?.textContent).toBe(
            '',
        );
    });

    it('shows a calm "Reconnecting…" line while the socket is down', async () => {
        const { h, c } = await activeChat();

        expect(byTestId(c, 'connection-status')).toBeNull();
        await run(() => h.socket()?.setStatus('disconnected'));
        expect(text(byTestId(c, 'connection-status'))).toBe('Reconnecting…');
        await run(() => h.socket()?.setStatus('connected'));
        expect(byTestId(c, 'connection-status')).toBeNull();
    });

    it('a failed send offers retry and delete; retry sends the same message once', async () => {
        const { backend, h, c } = await activeChat();

        backend.fail('POST', '/messages$', 500, undefined, 1);
        await run(() => h.controller.send({ body: 'Flaky' }));
        await waitFor(() => c.querySelector('[data-status="failed"]') !== null);

        expect(text(c.querySelector('[data-status="failed"]'))).toContain(
            'Not sent. Tap to retry.',
        );

        await click(byTestId(c, 'message-retry'));
        await waitFor(
            () =>
                c.querySelector(
                    '[data-sender="visitor"][data-status="sent"]',
                ) !== null,
        );

        expect(all(c, 'message-retry')).toHaveLength(0);
        expect(
            backend.state.messages.filter((m) => m.body === 'Flaky'),
        ).toHaveLength(1);
    });

    it('a send the server refuses for good (422) says why and offers no futile retry', async () => {
        const { backend, h, c } = await activeChat();

        backend.fail(
            'POST',
            '/messages$',
            422,
            {
                error: {
                    code: 'validation_failed',
                    message:
                        'The body field must not be greater than 4000 characters.',
                    details: {
                        body: [
                            'The body field must not be greater than 4000 characters.',
                        ],
                    },
                },
            },
            1,
        );
        await run(() => h.controller.send({ body: 'Way too long' }));
        await waitFor(() => c.querySelector('[data-status="failed"]') !== null);

        expect(text(c.querySelector('[data-status="failed"]'))).toContain(
            'Not sent: this message is too long.',
        );
        expect(all(c, 'message-retry')).toHaveLength(0);
        expect(
            Array.from(c.querySelectorAll('button')).some(
                (b) => b.textContent === 'Delete',
            ),
        ).toBe(true);
    });

    it('a rate-limited send can be retried and says to wait', async () => {
        const { backend, h, c } = await activeChat();

        backend.fail('POST', '/messages$', 429, undefined, 3, {
            'Retry-After': '60',
        });
        await run(() => h.controller.send({ body: 'Fast fingers' }));
        await waitFor(() => c.querySelector('[data-status="failed"]') !== null);

        expect(text(c.querySelector('[data-status="failed"]'))).toContain(
            'too many messages',
        );
        expect(all(c, 'message-retry')).toHaveLength(1);
    });

    it('a failed send can be deleted from the list', async () => {
        const { backend, h, c } = await activeChat();

        backend.fail('POST', '/messages$', 500, undefined, 1);
        await run(() => h.controller.send({ body: 'Never mind' }));
        await waitFor(() => c.querySelector('[data-status="failed"]') !== null);
        await click(
            Array.from(c.querySelectorAll('button')).find(
                (b) => b.textContent === 'Delete',
            ) ?? null,
        );

        expect(text(byTestId(c, 'message-list'))).not.toContain('Never mind');
    });

    it('shows a "New messages" pill when the visitor scrolled up, and scrolling down clears it', async () => {
        const { backend, h, c } = await activeChat();
        const list = byTestId(c, 'message-list') as HTMLElement;

        Object.defineProperty(list, 'scrollHeight', {
            value: 1000,
            configurable: true,
        });
        Object.defineProperty(list, 'clientHeight', {
            value: 300,
            configurable: true,
        });
        // at the end of the list first, then the visitor scrolls up to the top
        for (const top of [700, 0]) {
            list.scrollTop = top;
            await act(async () => {
                list.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
        }

        backend.agentSays('Down below');
        await run(() =>
            h.socket()?.emit('message.created', {
                v: 1,
                message: backend.state.messages.at(-1),
            }),
        );

        const pill = byTestId(c, 'new-messages-pill');

        expect(pill?.textContent).toContain('New messages (1)');

        await click(pill);
        expect(byTestId(c, 'new-messages-pill')).toBeNull();
    });

    it('keeps following the end through a burst: the smooth scroll that is still on its way down does not let go of the list', async () => {
        const { backend, h, c } = await activeChat();
        const list = byTestId(c, 'message-list') as HTMLElement;
        const size = (height: number): void => {
            Object.defineProperty(list, 'scrollHeight', {
                value: height,
                configurable: true,
            });
        };
        const scrollTo = async (top: number): Promise<void> => {
            list.scrollTop = top;
            await act(async () => {
                list.dispatchEvent(new Event('scroll', { bubbles: true }));
            });
        };
        const arrive = (body: string) => {
            backend.agentSays(body);

            return run(() =>
                h.socket()?.emit('message.created', {
                    v: 1,
                    message: backend.state.messages.at(-1),
                }),
            );
        };

        Object.defineProperty(list, 'clientHeight', {
            value: 300,
            configurable: true,
        });
        size(1000);
        await scrollTo(700);

        // A message makes the list 200px taller; the smooth scroll to its end has only got to 750 when the next message arrives
        // (150px from the end: farther than "at the bottom", but moving down, which is not the visitor scrolling away).
        size(1200);
        await scrollTo(750);
        size(1400);
        await arrive('Second of the burst');

        expect(list.scrollTop).toBe(1400);
        expect(byTestId(c, 'new-messages-pill')).toBeNull();

        // Scrolling UP is still the visitor's decision: the next message waits behind the pill.
        await scrollTo(100);
        size(1600);
        await arrive('Third, while reading older messages');

        expect(list.scrollTop).toBe(100);
        expect(byTestId(c, 'new-messages-pill')?.textContent).toContain(
            'New messages',
        );
    });
});

describe('expiring attachment URLs', () => {
    const picture = (version: number): AttachmentData => ({
        ulid: 'att-exp',
        mime: 'image/webp',
        size: 10,
        width: 320,
        height: 200,
        url: `https://files.test/full.webp?v=${version}`,
        thumbUrl: `https://files.test/thumb.webp?v=${version}`,
    });
    const fire = (element: Element | null, type: 'error' | 'load') =>
        act(async () => {
            element?.dispatchEvent(new Event(type));
        });

    it('a picture that fails to load makes the panel read the messages again and show the refreshed URL, once per failure burst', async () => {
        const { backend, c } = await activeChat((b) => {
            b.agentSays('See this', {
                attachments: [picture(1)],
                type: 'image',
            });
        });
        const thumb = () =>
            c.querySelector<HTMLImageElement>(
                '[data-testid="message-image"] img',
            );

        expect(thumb()?.getAttribute('src')).toBe(
            'https://files.test/thumb.webp?v=1',
        );

        // the server now signs the same picture with new URLs
        const stored = backend.state.messages.find(
            (m) => m.attachments.length > 0,
        );

        if (stored !== undefined) {
            stored.attachments = [picture(2)];
        }

        const before = backend.callsTo('GET', '/messages').length;

        await fire(thumb(), 'error');
        await waitFor(
            () =>
                thumb()?.getAttribute('src') ===
                'https://files.test/thumb.webp?v=2',
        );
        expect(backend.callsTo('GET', '/messages').length).toBe(before + 1);

        // still failing right after: that is a broken picture, not an expired URL: no second refresh
        await fire(thumb(), 'error');
        await flushUi();
        expect(backend.callsTo('GET', '/messages').length).toBe(before + 1);
    });

    it('an open lightbox follows the refreshed URL when its picture fails', async () => {
        const { backend, c } = await activeChat((b) => {
            b.agentSays('See this', {
                attachments: [picture(1)],
                type: 'image',
            });
        });

        await click(byTestId(c, 'message-image'));

        const big = () => byTestId(c, 'lightbox')?.querySelector('img') ?? null;

        expect(big()?.getAttribute('src')).toBe(
            'https://files.test/full.webp?v=1',
        );

        const stored = backend.state.messages.find(
            (m) => m.attachments.length > 0,
        );

        if (stored !== undefined) {
            stored.attachments = [picture(2)];
        }

        await fire(big(), 'error');
        await waitFor(
            () =>
                big()?.getAttribute('src') ===
                'https://files.test/full.webp?v=2',
        );
    });

    it('a loaded picture keeps the list pinned to the end', async () => {
        const { c } = await activeChat((b) => {
            b.agentSays('See this', {
                attachments: [picture(1)],
                type: 'image',
            });
        });
        const list = byTestId(c, 'message-list') as HTMLElement;

        Object.defineProperty(list, 'scrollHeight', {
            value: 900,
            configurable: true,
        });
        list.scrollTop = 0;

        await fire(
            c.querySelector('[data-testid="message-image"] img'),
            'load',
        );

        expect(list.scrollTop).toBe(900);
    });
});

describe('screen reader chatter', () => {
    it('the log announces additions only; typing, receipts and times stay out of it', async () => {
        const { h, c } = await activeChat((b) => {
            b.agentSays('Hello');
        });
        const log = byTestId(c, 'message-list') as HTMLElement;

        expect(log.getAttribute('role')).toBe('log');
        expect(log.getAttribute('aria-relevant')).toBe('additions');

        await run(() =>
            h.socket()?.emit('client-typing', { actor: 'agent', typing: true }),
        );

        // the typing status is a polite region OUTSIDE the log
        const status = Array.from(c.querySelectorAll('[role="status"]')).find(
            (node) => node.textContent?.includes('typing'),
        );

        expect(status).toBeDefined();
        expect(log.contains(status ?? null)).toBe(false);

        // the time / receipt line is excluded from the live announcements
        const stamp = log.querySelector(
            '[data-sender="agent"] time',
        )?.parentElement;

        expect(stamp?.getAttribute('aria-live')).toBe('off');
    });
});

describe('bottom inset', () => {
    it('the footer carries the home-indicator inset, so the composer above it does not add it again', async () => {
        const { c } = await activeChat();
        const main = byTestId(c, 'chat-state') as HTMLElement;

        expect(main.style.getPropertyValue('--pne-safe-b')).toBe('0px');
    });
});

describe('lightbox', () => {
    it('opens an attached image full size, traps focus, closes on Escape without asking the loader to close, and restores focus', async () => {
        const { backend, h, c } = await activeChat((b) => {
            const attachment: AttachmentData = {
                ulid: 'att-1',
                mime: 'image/webp',
                size: 10,
                width: 320,
                height: 200,
                url: 'https://files.test/full.webp',
                thumbUrl: 'https://files.test/thumb.webp',
            };

            b.agentSays('See this', {
                attachments: [attachment],
                type: 'image',
            });
        });

        expect(backend).toBeTruthy();

        const thumb = c.querySelector<HTMLImageElement>(
            '[data-testid="message-image"] img',
        );

        expect(thumb?.getAttribute('src')).toBe(
            'https://files.test/thumb.webp',
        );
        expect(thumb?.getAttribute('alt')).toBe('Image from Sam');
        // The room is reserved from the server's size (a lazy picture of no size is never fetched at the end of a scroller).
        expect(thumb?.style.inlineSize).toBe('220px');
        expect(thumb?.style.aspectRatio.replace(/\s/g, '')).toBe('320/200');

        const trigger = byTestId(c, 'message-image') as HTMLElement;

        trigger.focus();
        await click(trigger);

        const dialog = byTestId(c, 'lightbox');

        expect(dialog?.getAttribute('role')).toBe('dialog');
        expect(dialog?.getAttribute('aria-modal')).toBe('true');
        expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(
            'https://files.test/full.webp',
        );
        expect(document.activeElement).toBe(byTestId(c, 'lightbox-close'));
        // everything behind it is inert
        expect(c.querySelector('[inert]')).not.toBeNull();

        await press(byTestId(c, 'lightbox-close'), 'Tab');
        expect(document.activeElement).toBe(byTestId(c, 'lightbox-close'));

        await press(byTestId(c, 'lightbox-close'), 'Escape');
        expect(byTestId(c, 'lightbox')).toBeNull();
        expect(h.sent.filter((m) => m.type === 'close')).toHaveLength(0);
        expect(document.activeElement).toBe(trigger);
        expect(c.querySelector('[inert]')).toBeNull();
    });
});

describe('end chat confirmation', () => {
    it('focuses the safe answer, Escape and "Keep chatting" cancel, and only the confirm ends the chat', async () => {
        const { backend, c, h } = await activeChat();

        await click(byTestId(c, 'end-chat'));
        expect(byTestId(c, 'end-chat-dialog')?.getAttribute('role')).toBe(
            'alertdialog',
        );
        expect(document.activeElement).toBe(byTestId(c, 'end-chat-keep'));

        // The two buttons are the whole tab cycle, in document order (confirm, then keep): Tab from the last one wraps to the first
        // and Shift+Tab from the first wraps to the last, instead of leaving the dialog.
        await press(byTestId(c, 'end-chat-keep'), 'Tab');
        expect(document.activeElement).toBe(byTestId(c, 'end-chat-confirm'));
        await press(byTestId(c, 'end-chat-confirm'), 'Tab', {
            shiftKey: true,
        });
        expect(document.activeElement).toBe(byTestId(c, 'end-chat-keep'));

        await press(byTestId(c, 'end-chat-keep'), 'Escape');
        expect(byTestId(c, 'end-chat-dialog')).toBeNull();
        expect(h.sent.filter((m) => m.type === 'close')).toHaveLength(0);
        expect(backend.callsTo('POST', '/end')).toHaveLength(0);

        await click(byTestId(c, 'end-chat'));
        await click(byTestId(c, 'end-chat-keep'));
        expect(byTestId(c, 'end-chat-dialog')).toBeNull();

        await click(byTestId(c, 'end-chat'));
        await click(byTestId(c, 'end-chat-confirm'));
        await waitFor(
            () => byTestId(c, 'chat-state')?.dataset.state === 'ended',
        );
        expect(backend.callsTo('POST', '/end')).toHaveLength(1);
    });

    it('the end button is hidden when the widget does not let visitors end chats', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const h = createHarness({ backend });
        const view = await renderPanel(h);
        const boot = (await import('@/tests/embed-harness')).loaderBoot();
        const config = boot.config as { features: object };

        await run(() =>
            h.init(
                makeInit({
                    visitorSession: stored,
                    boot: {
                        ...boot,
                        config: {
                            ...config,
                            features: {
                                ...config.features,
                                endChatByVisitor: false,
                            },
                        },
                    },
                }),
            ),
        );
        await run(() => h.open());

        expect(byTestId(view.container, 'end-chat')).toBeNull();
    });
});

describe('composer', () => {
    it('Enter sends, Shift+Enter and IME composition do not; the send button follows the draft', async () => {
        const { backend, c } = await activeChat();
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;
        const send = byTestId(c, 'composer-send') as HTMLButtonElement;

        expect(send.disabled).toBe(true);

        await fill(input, 'Line one');
        expect(send.disabled).toBe(false);

        const shift = await press(input, 'Enter', { shiftKey: true });

        expect(shift.defaultPrevented).toBe(false);
        expect(backend.callsTo('POST', '/messages')).toHaveLength(0);

        await press(input, 'Enter', { isComposing: true } as KeyboardEventInit);
        expect(backend.callsTo('POST', '/messages')).toHaveLength(0);

        const enter = await press(input, 'Enter');

        expect(enter.defaultPrevented).toBe(true);
        await waitFor(() => backend.callsTo('POST', '/messages').length === 1);
        expect(input.value).toBe('');
        expect(send.disabled).toBe(true);
    });

    it('is labelled, limits the length, and grows with its content', async () => {
        const { c } = await activeChat();
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;

        expect(input.getAttribute('aria-label')).toBe('Message');
        expect(input.getAttribute('placeholder')).toBe('Type your message…');
        expect(input.maxLength).toBe(4000);

        Object.defineProperty(input, 'scrollHeight', {
            value: 90,
            configurable: true,
        });
        await fill(input, 'a\nb\nc');
        expect(input.style.height).toBe('90px');

        Object.defineProperty(input, 'scrollHeight', {
            value: 400,
            configurable: true,
        });
        await fill(input, 'a\nb\nc\nd');
        expect(input.style.height).toBe('120px');
    });

    it('whispers typing while the visitor types and stops when the draft is cleared', async () => {
        const { h, c } = await activeChat();
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;

        await fill(input, 'h');
        await fill(input, '');

        expect(h.socket()?.whispers.map((w) => w.payload.typing)).toEqual([
            true,
            false,
        ]);
    });

    it('hides the attach button when the widget has attachments off', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const h = createHarness({ backend });
        const view = await renderPanel(h);
        const boot = (await import('@/tests/embed-harness')).loaderBoot();
        const config = boot.config as { features: object };

        await run(() =>
            h.init(
                makeInit({
                    visitorSession: stored,
                    boot: {
                        ...boot,
                        config: {
                            ...config,
                            features: {
                                ...config.features,
                                attachments: false,
                            },
                        },
                    },
                }),
            ),
        );
        await run(() => h.open());

        expect(byTestId(view.container, 'composer-attach')).toBeNull();
        expect(byTestId(view.container, 'composer-input')).not.toBeNull();
    });
});

describe('attachments', () => {
    it('refuses a wrong type and an oversized file, with an accessible message, and accepts a valid image', async () => {
        const { c } = await activeChat();
        const input = byTestId(c, 'composer-file') as HTMLInputElement;

        expect(input.accept).toBe('image/jpeg,image/png,image/webp,image/gif');

        await pickFile(input, [
            new File(['x'], 'doc.pdf', { type: 'application/pdf' }),
        ]);
        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'Only JPEG, PNG, WebP and GIF images can be sent.',
        );
        expect(all(c, 'composer-attachment')).toHaveLength(0);

        await pickFile(input, [png('big.png', 6 * 1024 * 1024)]);
        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'Images must be 5 MB or smaller.',
        );

        await pickFile(input, [png()]);
        await waitFor(
            () =>
                byTestId(c, 'composer-attachment')?.dataset.status === 'ready',
        );
        expect(c.querySelector('[role="alert"]')).toBeNull();
    });

    it('shows a thumbnail with upload progress, lets the visitor remove it before sending, and blocks sending while it uploads', async () => {
        const { h, c } = await activeChat();
        const finish: {
            resolve?: (a: AttachmentData) => void;
            progress?: (n: number) => void;
        } = {};

        vi.spyOn(h.controller, 'uploadAttachment').mockImplementation(
            (_file, options = {}) =>
                new Promise<AttachmentData>((resolve) => {
                    finish.resolve = resolve;
                    finish.progress = options.onProgress;
                }),
        );

        const input = byTestId(c, 'composer-file') as HTMLInputElement;

        await pickFile(input, [png('a.png')]);

        const chip = byTestId(c, 'composer-attachment') as HTMLElement;

        expect(chip.dataset.status).toBe('uploading');
        expect(chip.querySelector('img')?.getAttribute('alt')).toBe('a.png');

        await run(() => finish.progress?.(0.4));
        expect(
            chip
                .querySelector('[role="progressbar"]')
                ?.getAttribute('aria-valuenow'),
        ).toBe('40');
        // text typed, but the upload is still running: not sendable
        await fill(
            byTestId(c, 'composer-input') as HTMLTextAreaElement,
            'with image',
        );
        expect(
            (byTestId(c, 'composer-send') as HTMLButtonElement).disabled,
        ).toBe(true);

        await click(byTestId(c, 'composer-attachment-remove'));
        expect(all(c, 'composer-attachment')).toHaveLength(0);
        expect(
            (byTestId(c, 'composer-send') as HTMLButtonElement).disabled,
        ).toBe(false);
    });

    it('sends the uploaded image with the message and shows it in the list', async () => {
        const { backend, c } = await activeChat();

        await pickFile(byTestId(c, 'composer-file') as HTMLInputElement, [
            png(),
        ]);
        await waitFor(
            () =>
                byTestId(c, 'composer-attachment')?.dataset.status === 'ready',
        );

        // an image alone is enough to send
        const send = byTestId(c, 'composer-send') as HTMLButtonElement;

        expect(send.disabled).toBe(false);
        await click(send);
        await waitFor(() => backend.callsTo('POST', '/messages').length === 1);
        await waitFor(
            () =>
                c.querySelector(
                    '[data-sender="visitor"] [data-testid="message-image"]',
                ) !== null,
        );

        const body = backend.callsTo('POST', '/messages')[0].body as {
            attachments: string[];
            body?: string;
        };

        expect(body.attachments).toHaveLength(1);
        expect(body.body).toBeUndefined();
        expect(all(c, 'composer-attachment')).toHaveLength(0);
    });

    it('takes the size, count and message limits from the session response instead of the built-in defaults', async () => {
        const { c } = await activeChat(undefined, {
            backend: {
                limits: {
                    maxMessageLength: 1500,
                    attachmentMaxBytes: 2 * 1024 * 1024,
                    attachmentMaxDimension: 2048,
                    attachmentMaxPerMessage: 2,
                },
            },
        });
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;
        const files = byTestId(c, 'composer-file') as HTMLInputElement;

        expect(input.maxLength).toBe(1500);

        await pickFile(files, [png('big.png', 3 * 1024 * 1024)]);
        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'Images must be 2 MB or smaller.',
        );

        await pickFile(files, [png('1.png'), png('2.png'), png('3.png')]);
        expect(all(c, 'composer-attachment')).toHaveLength(2);
        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'You can attach up to 2 images.',
        );
    });

    it('limits how many images go with one message', async () => {
        const { c } = await activeChat();

        await pickFile(byTestId(c, 'composer-file') as HTMLInputElement, [
            png('1.png'),
            png('2.png'),
            png('3.png'),
            png('4.png'),
            png('5.png'),
        ]);
        expect(all(c, 'composer-attachment')).toHaveLength(4);
        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'You can attach up to 4 images.',
        );
    });

    it('a failed upload marks the chip and says so; it can be removed', async () => {
        const { backend, c } = await activeChat();

        backend.fail('POST', '/attachments$', 500, undefined, 1);
        await pickFile(byTestId(c, 'composer-file') as HTMLInputElement, [
            png(),
        ]);
        await waitFor(
            () =>
                byTestId(c, 'composer-attachment')?.dataset.status === 'error',
        );

        expect(c.querySelector('[role="alert"]')?.textContent).toBe(
            'Upload failed',
        );
        await click(byTestId(c, 'composer-attachment-remove'));
        expect(all(c, 'composer-attachment')).toHaveLength(0);
    });

    it.each([
        [
            422,
            'validation_failed',
            "That image can't be sent. Try a smaller JPEG, PNG, WebP or GIF.",
        ],
        [403, 'feature_disabled', "Images can't be sent in this chat."],
        [429, 'rate_limited', 'Too many uploads. Wait a moment and try again.'],
    ] as const)(
        'a refused upload (%i %s) is explained in the panel language, not with the server text',
        async (status, code, copy) => {
            const { backend, c } = await activeChat();

            backend.fail(
                'POST',
                '/attachments$',
                status,
                {
                    error: {
                        code,
                        message: 'Server wording',
                        details: { file: ['Server wording'] },
                    },
                },
                1,
            );
            await pickFile(byTestId(c, 'composer-file') as HTMLInputElement, [
                png(),
            ]);
            await waitFor(
                () =>
                    byTestId(c, 'composer-attachment')?.dataset.status ===
                    'error',
            );

            expect(c.querySelector('[role="alert"]')?.textContent).toBe(copy);
        },
    );

    it('an upload to a chat that has just ended re-reads the chat instead of leaving the visitor stuck', async () => {
        const { backend, h, c } = await activeChat();

        backend.agentEnds(true);
        backend.fail(
            'POST',
            '/attachments$',
            409,
            { error: { code: 'conversation_not_active', message: 'x' } },
            1,
        );
        await pickFile(byTestId(c, 'composer-file') as HTMLInputElement, [
            png(),
        ]);
        await waitFor(() => h.state().phase === 'ended');
    });

    it('pasting an image stages it', async () => {
        const { c } = await activeChat();
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;
        const event = new Event('paste', { bubbles: true, cancelable: true });

        Object.defineProperty(event, 'clipboardData', {
            value: { files: [png('pasted.png')] },
        });
        await act(async () => {
            input.dispatchEvent(event);
        });

        expect(event.defaultPrevented).toBe(true);
        await waitFor(() => all(c, 'composer-attachment').length === 1);
    });
});
