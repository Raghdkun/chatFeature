import { act } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import type { AttachmentData } from '@/lib/chat/types';
import { fakeTime } from '@/lib/chat/fixtures';
import { fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { useBackend } from '@/tests/msw/server';
import { createHarness, makeInit } from '@/tests/embed-harness';
import { press, renderPanel, run, text, waitFor } from '@/tests/embed-render';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (root: ParentNode, id: string): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`));

/** An active chat that was resumed from a stored session (so the transcript is whatever the test seeded). */
async function activeChat(
    seed?: (backend: ReturnType<typeof useBackend>) => void,
    options: { open?: boolean } = {},
) {
    const backend = useBackend();
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
        list.scrollTop = 0;
        await act(async () => {
            list.dispatchEvent(new Event('scroll', { bubbles: true }));
        });

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
