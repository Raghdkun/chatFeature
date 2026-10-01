import axe from 'axe-core';
import { describe, expect, it } from 'vite-plus/test';
import { choose, fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import { createHarness, loaderBoot, makeInit } from '@/tests/embed-harness';
import { renderPanel, run, waitFor } from '@/tests/embed-render';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

/** axe-core on the rendered panel. Colour contrast needs real layout and styles: the e2e phase checks it in a browser. */
async function violations(container: HTMLElement): Promise<string[]> {
    const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
    });

    return results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`);
}

const noForm = () => {
    const base = bootConfig().config as object;

    return loaderBoot({
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
};

async function render(init = makeInit(), backend = useBackend()) {
    const h = createHarness({ backend });
    const view = await renderPanel(h);

    await run(() => h.init(init));
    await run(() => h.open());

    return { h, backend, c: view.container };
}

describe('accessibility (axe)', () => {
    it('booting skeleton', async () => {
        const h = createHarness({ backend: useBackend() });
        const view = await renderPanel(h);

        expect(await violations(view.container)).toEqual([]);
    });

    it('pre-chat form, with errors showing', async () => {
        const { c } = await render();

        expect(await violations(c)).toEqual([]);
        await click(c.querySelector('button[type="submit"]'));
        expect(c.querySelector('[aria-invalid="true"]')).not.toBeNull();
        expect(await violations(c)).toEqual([]);
    });

    it('pre-chat form with consent and every field', async () => {
        const base = bootConfig().config as object;
        const { c } = await render(
            makeInit({
                boot: loaderBoot({
                    config: {
                        ...base,
                        preChat: {
                            fields: {
                                name: { enabled: true, required: true },
                                email: { enabled: true, required: true },
                                phone: { enabled: true, required: false },
                            },
                            consentText: 'I agree to the privacy policy.',
                        },
                    },
                }),
            }),
        );

        expect(await violations(c)).toEqual([]);
    });

    it('welcome screen', async () => {
        const { c } = await render(
            makeInit({ boot: loaderBoot({ config: { ...(noForm().config as object) }, categories: [{ slug: 'billing', label: 'Billing' }] }) }),
            useBackend({ config: bootConfig({ categories: [{ slug: 'billing', label: 'Billing', description: null, icon: null, color: null }] }) }),
        );

        expect(byTestId(c, 'idle-start')).not.toBeNull();
        expect(await violations(c)).toEqual([]);
    });

    it('category picker and the queued screen', async () => {
        const { c } = await render(makeInit({ boot: noForm() }));

        expect(byTestId(c, 'category-option-billing')).not.toBeNull();
        expect(await violations(c)).toEqual([]);

        await click(byTestId(c, 'category-option-billing'));
        await waitFor(() => byTestId(c, 'queued-cancel') !== null);
        expect(await violations(c)).toEqual([]);
    });

    it('active chat: messages, image, typing indicator, staged attachment, reconnecting line', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Hello there');
        backend.agentSays('A picture', {
            type: 'image',
            attachments: [{ ulid: 'a1', mime: 'image/webp', size: 1, width: 10, height: 10, url: 'https://f.test/a.webp', thumbUrl: 'https://f.test/t.webp' }],
        });

        const { h, c } = await render(makeInit({ visitorSession: stored }), backend);

        await waitFor(() => h.socket()?.status() === 'connected');
        await run(() => h.socket()?.emit('client-typing', { actor: 'agent', typing: true }));
        await run(() => h.socket()?.setStatus('reconnecting'));
        await fill(byTestId(c, 'composer-input') as HTMLTextAreaElement, 'A draft');

        expect(await violations(c)).toEqual([]);

        await click(byTestId(c, 'message-image'));
        expect(byTestId(c, 'lightbox')).not.toBeNull();
        expect(await violations(c)).toEqual([]);
    });

    it('end-chat dialog and the rating card', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Hi');

        const { c } = await render(makeInit({ visitorSession: stored }), backend);

        await click(byTestId(c, 'end-chat'));
        expect(byTestId(c, 'end-chat-dialog')).not.toBeNull();
        expect(await violations(c)).toEqual([]);

        await click(byTestId(c, 'end-chat-confirm'));
        await waitFor(() => byTestId(c, 'rating-stars') !== null);
        await click(byTestId(c, 'rating-star-2'));
        expect(await violations(c)).toEqual([]);
    });

    it('offline form (with errors) and the closed confirmation', async () => {
        const closed = { online: false, openNow: false, nextOpenAt: '2026-11-23T09:00:00.000Z', categories: [], whatsapp: { enabled: false } };
        const { c } = await render(makeInit({ boot: loaderBoot({ availability: closed }) }), useBackend({ availability: closed }));

        expect(byTestId(c, 'offline-form')).not.toBeNull();
        expect(await violations(c)).toEqual([]);
        await click(c.querySelector('button[type="submit"]'));
        expect(await violations(c)).toEqual([]);

        await fill(c.querySelector('input[name="name"]'), 'Vera');
        await fill(c.querySelector('input[name="email"]'), 'v@x.test');
        await choose(c.querySelector('select[name="category"]'), 'billing');
        await fill(c.querySelector('textarea[name="message"]'), 'Hello');
        await click(c.querySelector('button[type="submit"]'));
        await waitFor(() => byTestId(c, 'new-chat') !== null);

        expect(await violations(c)).toEqual([]);
    });
});

describe('focus management', () => {
    it('moves focus into the first field when the panel opens on a pointer device, and to the heading on a screen change', async () => {
        const { h, c } = await render();

        await run(async () => {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        });
        expect(document.activeElement).toBe(c.querySelector('input[name="name"]'));

        await fill(c.querySelector('input[name="name"]'), 'Vera');
        await click(c.querySelector('button[type="submit"]'));
        await run(async () => {
            await new Promise((resolve) => requestAnimationFrame(resolve));
        });

        expect(h.state().phase).toBe('category');
        expect(document.activeElement).toBe(byTestId(c, 'category-option-billing'));
    });
});
