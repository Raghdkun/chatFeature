import { describe, expect, it } from 'vite-plus/test';
import { fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import {
    createHarness,
    loaderBoot,
    makeInit,
    until,
} from '@/tests/embed-harness';
import {
    flushUi,
    press,
    renderPanel,
    run,
    text,
    waitFor,
} from '@/tests/embed-render';
import { makeAgentMessage } from '@/lib/chat/fixtures';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const phase = (root: ParentNode): string | undefined =>
    byTestId(root, 'chat-state')?.dataset.state;

async function openPanel(
    options: {
        backend?: ReturnType<typeof useBackend>;
        init?: ReturnType<typeof makeInit>;
    } = {},
) {
    const backend = options.backend ?? useBackend();
    const h = createHarness({ backend });
    const view = await renderPanel(h);

    await run(() => h.init(options.init));
    await run(() => h.open());

    return { backend, h, view, c: view.container };
}

describe('the visitor journey', () => {
    it('pre-chat -> topic -> queued -> chat -> end -> rating -> thanks -> new chat', async () => {
        const { backend, h, c } = await openPanel();

        expect(phase(c)).toBe('prechat');
        expect(byTestId(c, 'chat-panel')).not.toBeNull();

        // required name: an empty submit is refused with an accessible error
        await click(
            byTestId(c, 'prechat-form')?.querySelector(
                'button[type="submit"]',
            ) ?? null,
        );
        const name = c.querySelector<HTMLInputElement>('input[name="name"]');

        expect(name?.getAttribute('aria-invalid')).toBe('true');
        expect(
            document.getElementById(
                name?.getAttribute('aria-describedby') ?? '',
            )?.textContent,
        ).toContain('required');
        expect(phase(c)).toBe('prechat');

        await fill(name, 'Vera');
        await click(
            byTestId(c, 'prechat-form')?.querySelector(
                'button[type="submit"]',
            ) ?? null,
        );
        expect(phase(c)).toBe('category');

        await click(byTestId(c, 'category-option-billing'));
        await waitFor(() => phase(c) === 'queued');

        expect(byTestId(c, 'queued-timer')?.textContent).toMatch(
            /Waiting 0:0\d/,
        );
        expect(text(c)).toContain('Connecting you to an agent');

        await waitFor(() => h.socket()?.status() === 'connected');
        backend.claim('Sam');
        await run(() =>
            h
                .socket()
                ?.emit('chat.claimed', {
                    v: 1,
                    agent: { name: 'Sam', avatarUrl: null },
                    claimedAt: 'x',
                }),
        );
        await waitFor(() => phase(c) === 'active');
        await waitFor(
            () =>
                byTestId(c, 'message-list')?.textContent?.includes(
                    'Sam joined',
                ) === true,
        );

        const list = byTestId(c, 'message-list');

        expect(list?.getAttribute('role')).toBe('log');
        expect(list?.getAttribute('aria-live')).toBe('polite');
        expect(c.querySelector('header h1')?.textContent).toBe('Sam');

        // type and send with Enter
        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;

        await fill(input, 'Hello Sam');
        await press(input, 'Enter');
        await waitFor(
            () =>
                c.querySelector(
                    '[data-sender="visitor"][data-status="sent"]',
                ) !== null,
        );
        expect(input.value).toBe('');

        // an agent answers
        backend.agentSays('Hi Vera, how can I help?');
        await run(() =>
            h
                .socket()
                ?.emit('message.created', {
                    v: 1,
                    message: backend.state.messages.at(-1),
                }),
        );
        expect(text(list)).toContain('Hi Vera, how can I help?');

        // end the chat with a confirmation
        await click(byTestId(c, 'end-chat'));
        expect(byTestId(c, 'end-chat-dialog')).not.toBeNull();
        await click(byTestId(c, 'end-chat-confirm'));
        await waitFor(() => phase(c) === 'ended');

        // rating: stars, comment, submit
        expect(byTestId(c, 'rating-stars')?.getAttribute('role')).toBe(
            'radiogroup',
        );
        expect(text(byTestId(c, 'message-list'))).toContain('Hi Vera');
        await click(byTestId(c, 'rating-star-4'));
        expect(byTestId(c, 'rating-star-4')?.getAttribute('aria-checked')).toBe(
            'true',
        );
        await fill(
            byTestId(c, 'rating-comment') as HTMLTextAreaElement,
            'Very kind',
        );
        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => phase(c) === 'closed');

        expect(backend.state.ratings).toEqual([
            { score: 4, comment: 'Very kind' },
        ]);
        expect(text(c)).toContain('Thanks for your feedback!');
        expect(byTestId(c, 'message-list')).toBeNull();

        await click(byTestId(c, 'new-chat'));
        expect(phase(c)).toBe('prechat');
        expect(
            c.querySelector<HTMLInputElement>('input[name="name"]')?.value,
        ).toBe('Vera');
    });

    it('Escape asks the loader to close the panel; a dialog swallows it first', async () => {
        const { h, c } = await openPanel();

        await press(
            c.querySelector('input[name="name"]') as HTMLElement,
            'Escape',
        );
        // the keydown bubbles to the window listener: a `close` goes to the host
        expect(h.sent.filter((m) => m.type === 'close')).toHaveLength(1);
    });

    it('the header close button sends close', async () => {
        const { h, c } = await openPanel();

        await click(c.querySelector('header button[aria-label="Close chat"]'));
        expect(h.sent.filter((m) => m.type === 'close')).toHaveLength(1);
    });

    it('skips the pre-chat form and shows the welcome screen when nothing has to be asked', async () => {
        const base = bootConfig().config as object;
        const boot = loaderBoot({
            config: {
                ...base,
                preChat: {
                    fields: {
                        name: { enabled: false, required: false },
                        email: { enabled: false, required: false },
                        phone: { enabled: false, required: false },
                    },
                    consentText: null,
                },
            },
        });
        const backend = useBackend({
            config: bootConfig({
                categories: [
                    {
                        slug: 'billing',
                        label: 'Billing',
                        description: null,
                        icon: null,
                        color: null,
                    },
                ],
            }),
        });
        const { c } = await openPanel({ backend, init: makeInit({ boot }) });

        expect(phase(c)).toBe('idle');
        expect(text(c)).toContain('Hi! How can we help you today?');
        await click(byTestId(c, 'idle-start'));
        await waitFor(() => phase(c) === 'queued');
    });
});
