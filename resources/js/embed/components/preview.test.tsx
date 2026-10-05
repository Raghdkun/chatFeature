import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { choose, fill } from '@/tests/dom';
import { click } from '@/tests/render';
import '@/tests/msw/server';
import { createHarness, loaderBoot, makeInit } from '@/tests/embed-harness';
import { press, renderPanel, run, text, waitFor } from '@/tests/embed-render';
import { createDemoBackend } from '@/embed/preview/demo';
import { previewAvailability } from '@/embed/preview/availability';
import { bootConfig } from '@/tests/msw/chat-visitor';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const phase = (root: ParentNode): string | undefined =>
    byTestId(root, 'chat-state')?.dataset.state;

function previewHarness() {
    const demo = createDemoBackend({ delay: 0.02 });
    const h = createHarness({
        deps: {
            preview: true,
            createApi: () => demo.api,
            socketFactory: demo.socketFactory,
        },
    });

    return { demo, h };
}

afterEach(() => vi.restoreAllMocks());

describe('builder preview mode', () => {
    it('runs the whole chat against canned data and never calls the visitor API or stores a session', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
        const { demo, h } = previewHarness();
        const view = await renderPanel(h);
        const c = view.container;

        await run(() => h.init(makeInit()));
        await run(() => h.open());
        expect(phase(c)).toBe('prechat');

        await fill(c.querySelector('input[name="name"]'), 'Admin');
        await click(c.querySelector('button[type="submit"]'));
        await click(byTestId(c, 'category-option-billing'));
        await waitFor(() => phase(c) === 'queued');
        await waitFor(() => phase(c) === 'active', 4000);
        expect(text(c.querySelector('header h1'))).toBe('Alex (preview)');

        await waitFor(
            () =>
                text(byTestId(c, 'message-list')).includes(
                    'looking at a preview',
                ),
            4000,
        );

        const input = byTestId(c, 'composer-input') as HTMLTextAreaElement;

        await fill(input, 'Hello demo');
        await press(input, 'Enter');
        await waitFor(
            () =>
                text(byTestId(c, 'message-list')).includes(
                    'Thanks for your message',
                ),
            4000,
        );

        await click(byTestId(c, 'end-chat'));
        await click(byTestId(c, 'end-chat-confirm'));
        await waitFor(() => phase(c) === 'ended');
        await click(byTestId(c, 'rating-star-5'));
        await click(byTestId(c, 'rating-submit'));
        await waitFor(() => phase(c) === 'closed');
        await click(byTestId(c, 'new-chat'));

        expect(fetchSpy).not.toHaveBeenCalled();
        expect(xhrSpy).not.toHaveBeenCalled();
        // the demo token never reaches the host (the loader would store it in the dashboard's origin)
        expect(h.sessions).toEqual([]);
        expect(h.sent.some((m) => m.type === 'session')).toBe(false);
        demo.dispose();
    });

    it('shows the offline screens when the draft says always offline, and the demo form works', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const { h } = previewHarness();
        const view = await renderPanel(h);
        const c = view.container;
        const base = bootConfig().config as { hours: object };

        await run(() =>
            h.init(
                makeInit({
                    boot: loaderBoot({
                        config: {
                            ...base,
                            hours: { ...base.hours, mode: 'always_offline' },
                        },
                    }),
                }),
            ),
        );
        await run(() => h.open());

        expect(phase(c)).toBe('offline');

        await fill(c.querySelector('input[name="name"]'), 'Admin');
        await fill(c.querySelector('input[name="email"]'), 'admin@x.test');
        await fill(c.querySelector('textarea[name="message"]'), 'Testing');
        await choose(c.querySelector('select[name="category"]'), 'billing');
        await click(c.querySelector('button[type="submit"]'));
        await waitFor(() => phase(c) === 'closed');

        expect(text(c)).toContain('Message sent');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('draft messages restyle the panel live (colours, texts, radius) and can flip hours', async () => {
        const { h } = previewHarness();
        const view = await renderPanel(h);
        const c = view.container;
        const root = byTestId(c, 'chat-panel') as HTMLElement;

        await run(() => h.init(makeInit()));
        await run(() => h.open());
        expect(root.style.getPropertyValue('--pne-primary')).toBe('#0f766e');

        await run(() =>
            h.controller.handleHostMessage({
                type: 'draft',
                payload: {
                    config: {
                        theme: {
                            primary: '#ff0000',
                            primaryText: '#ffffff',
                            accent: '#D97706',
                            surface: '#ffffff',
                            text: '#0f172a',
                            radius: 4,
                            shadow: 'none',
                            mode: 'light',
                        },
                        texts: { en: { title: 'Draft title' } },
                        hours: { mode: 'always_offline' },
                    },
                    greetings: [],
                },
            }),
        );

        expect(root.style.getPropertyValue('--pne-primary')).toBe('#ff0000');
        expect(root.style.getPropertyValue('--pne-radius')).toBe('4px');
        expect(text(c.querySelector('header h1'))).toBe('Draft title');
        expect(phase(c)).toBe('offline');

        await run(() =>
            h.controller.handleHostMessage({
                type: 'draft',
                payload: {
                    config: { hours: { mode: 'always_online' } },
                    greetings: [],
                },
            }),
        );
        expect(phase(c)).toBe('prechat');
    });

    it('derives availability from the draft hours mode only', () => {
        expect(
            previewAvailability({ hours: { mode: 'always_offline' } }, null),
        ).toMatchObject({ online: false, openNow: false });
        expect(
            previewAvailability({ hours: { mode: 'always_online' } }, null),
        ).toMatchObject({ online: true, openNow: true });
        expect(
            previewAvailability(
                { hours: { mode: 'always_online' } },
                { hours: { mode: 'always_offline' } },
            ),
        ).toMatchObject({ online: false });
        expect(previewAvailability(null, null)).toMatchObject({ online: true });
    });
});
