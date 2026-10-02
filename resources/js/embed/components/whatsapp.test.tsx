import axe from 'axe-core';
import { delay, http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vite-plus/test';
import { click } from '@/tests/render';
import { API, bootConfig } from '@/tests/msw/chat-visitor';
import { server, useBackend } from '@/tests/msw/server';
import { createHarness, makeInit, type Harness } from '@/tests/embed-harness';
import {
    ENV,
    renderPanel,
    run,
    settleFrame,
    text,
    waitFor,
} from '@/tests/embed-render';
import { createDemoBackend } from '@/embed/preview/demo';
import { previewAvailability } from '@/embed/preview/availability';
import type { Dict } from '@/embed/protocol/messages';
import { loadBuiltin } from '@/embed/i18n';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const phase = (root: ParentNode): string | undefined =>
    byTestId(root, 'chat-state')?.dataset.state;

type Boot = ReturnType<typeof bootConfig>;

/** A widget that offers WhatsApp (the feature AND a connected session). */
function whatsappBoot(
    options: {
        categories?: number;
        online?: boolean;
        offered?: boolean;
        offlineForm?: boolean;
        locale?: string;
        texts?: Record<string, unknown>;
    } = {},
): Boot {
    const base = bootConfig();
    const config = base.config as {
        features: Record<string, unknown>;
        texts: Record<string, unknown>;
    };
    const categories = base.categories.slice(0, options.categories ?? 1);
    const offered = options.offered ?? true;
    const online = options.online ?? true;

    return bootConfig({
        config: {
            ...config,
            ...(options.locale ? { defaultLocale: options.locale } : {}),
            texts: { ...config.texts, ...options.texts },
            features: {
                ...config.features,
                whatsapp: offered,
                preChat: false,
                offlineForm: options.offlineForm ?? true,
            },
        },
        categories,
        availability: {
            ...base.availability,
            online,
            openNow: online,
            categories: categories.map((c) => ({ slug: c.slug, online })),
            whatsapp: { enabled: offered },
        },
    });
}

async function panel(boot: Boot = whatsappBoot(), open = true) {
    const backend = useBackend({
        config: boot,
        availability: boot.availability as Record<string, unknown>,
    });
    const h: Harness = createHarness({ backend, builtin: loadBuiltin });
    const view = await renderPanel(h);

    await run(() => h.init(makeInit({ boot })));

    if (open) {
        await run(() => h.open());
    }

    return { h, backend, view, c: view.container, boot };
}

/** To the hand-off screen: one topic, "Continue on WhatsApp". */
async function handOff(boot: Boot = whatsappBoot()) {
    const ctx = await panel(boot);

    await click(byTestId(ctx.c, 'channel-whatsapp'));
    await waitFor(() => phase(ctx.c) === 'whatsapp');

    return ctx;
}

async function violations(container: HTMLElement): Promise<string[]> {
    const results = await axe.run(container, {
        rules: { 'color-contrast': { enabled: false } },
    });

    return results.violations.map(
        (v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`,
    );
}

function fakeClipboard(write: (value: string) => Promise<void>) {
    Object.defineProperty(navigator, 'clipboard', {
        configurable: true,
        value: { writeText: vi.fn(write) },
    });

    return (navigator.clipboard as unknown as { writeText: typeof write })
        .writeText as ReturnType<typeof vi.fn>;
}

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
});

describe('the channel chooser', () => {
    it('replaces the single start button when the widget offers WhatsApp, with "Chat here" focused first', async () => {
        const { c } = await panel();

        await settleFrame();

        expect(phase(c)).toBe('idle');
        expect(byTestId(c, 'channel-chooser')).not.toBeNull();
        expect(byTestId(c, 'idle-start')).toBeNull();
        expect(byTestId(c, 'channel-chooser')?.getAttribute('role')).toBe(
            'group',
        );
        expect(text(byTestId(c, 'channel-chat'))).toContain('Chat here');
        expect(text(byTestId(c, 'channel-whatsapp'))).toContain(
            'Continue on WhatsApp',
        );
        expect(document.activeElement).toBe(byTestId(c, 'channel-chat'));
        // two real buttons in reading order
        expect(
            [
                ...(byTestId(c, 'channel-chooser')?.querySelectorAll(
                    'button',
                ) ?? []),
            ].map((b) => b.dataset.testid),
        ).toEqual(['channel-chat', 'channel-whatsapp']);
    });

    it('is absent (the old start button stays) when the feature is off, or on without a connected session', async () => {
        const off = await panel(whatsappBoot({ offered: false }));

        expect(byTestId(off.c, 'channel-chooser')).toBeNull();
        expect(byTestId(off.c, 'idle-start')).not.toBeNull();
        expect(byTestId(off.c, 'channel-whatsapp')).toBeNull();

        const base = whatsappBoot();
        const noSession = await panel(
            bootConfig({
                ...base,
                availability: {
                    ...base.availability,
                    whatsapp: { enabled: false },
                },
            }),
        );

        expect(byTestId(noSession.c, 'channel-chooser')).toBeNull();
        expect(byTestId(noSession.c, 'idle-start')).not.toBeNull();
    });

    it('"Chat here" is the normal chat start (no hand-off request)', async () => {
        const { c, backend } = await panel();

        await click(byTestId(c, 'channel-chat'));
        await waitFor(() => phase(c) === 'queued');

        expect(backend.callsTo('POST', '/conversations')).toHaveLength(1);
        expect(backend.callsTo('POST', '/whatsapp-handoff')).toHaveLength(0);
    });

    it('disables both options while a request runs', async () => {
        const { c } = await panel();

        server.use(
            http.post(`${API}/widgets/:key/whatsapp-handoff`, async () => {
                await delay(150);

                return HttpResponse.json({
                    data: {
                        code: 'K7M2Q555',
                        waUrl: 'https://wa.me/491701234567?text=K7M2Q555',
                        expiresAt: new Date(
                            Date.now() + 3_600_000,
                        ).toISOString(),
                    },
                });
            }),
        );
        await click(byTestId(c, 'channel-whatsapp'));

        expect(
            (byTestId(c, 'channel-chat') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(
            (byTestId(c, 'channel-whatsapp') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(byTestId(c, 'channel-whatsapp')?.getAttribute('aria-busy')).toBe(
            'true',
        );

        await waitFor(() => phase(c) === 'whatsapp');
    });

    it('is only the WhatsApp alternative on the offline screen, next to the offline form', async () => {
        const { c, backend } = await panel(whatsappBoot({ online: false }));

        expect(phase(c)).toBe('offline');
        expect(byTestId(c, 'offline-form')).not.toBeNull();
        expect(byTestId(c, 'channel-chooser')).not.toBeNull();
        expect(byTestId(c, 'channel-chat')).toBeNull();
        expect(text(byTestId(c, 'channel-chooser'))).toContain(
            'Continue on WhatsApp',
        );

        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => phase(c) === 'whatsapp');

        expect(backend.callsTo('POST', '/whatsapp-handoff')).toHaveLength(1);
        expect(backend.callsTo('POST', '/offline-tickets')).toHaveLength(0);
    });

    it('is on the offline screen without a form too (the form is off)', async () => {
        const { c } = await panel(
            whatsappBoot({ online: false, offlineForm: false }),
        );

        expect(phase(c)).toBe('offline');
        expect(byTestId(c, 'offline-form')).toBeNull();
        expect(byTestId(c, 'channel-whatsapp')).not.toBeNull();
    });
});

describe('the topic picker for a hand-off', () => {
    it('asks for the topic first, shows no online markers, and goes back to the choice', async () => {
        const { c, backend } = await panel(whatsappBoot({ categories: 2 }));

        await click(byTestId(c, 'channel-whatsapp'));

        expect(phase(c)).toBe('category');
        expect(byTestId(c, 'category-option-billing')).not.toBeNull();
        expect(c.querySelector('[data-testid^="category-status"]')).toBeNull();
        expect(text(c)).not.toMatch(/\bOnline\b|\bOffline\b/);
        expect(backend.callsTo('POST', '/whatsapp-handoff')).toHaveLength(0);

        await click(byTestId(c, 'category-back'));
        expect(phase(c)).toBe('idle');
        expect(byTestId(c, 'channel-chooser')).not.toBeNull();

        await click(byTestId(c, 'channel-whatsapp'));
        await click(byTestId(c, 'category-option-tech'));
        await waitFor(() => phase(c) === 'whatsapp');

        expect(backend.callsTo('POST', '/whatsapp-handoff')[0].body).toEqual({
            category: 'tech',
        });
    });
});

describe('the hand-off screen', () => {
    it('shows the code big, the instructions, and the actions in order', async () => {
        const { c, backend } = await handOff();

        expect(text(c.querySelector('h2'))).toBe('Continue on WhatsApp');
        expect(text(byTestId(c, 'whatsapp-code'))).toBe('K7M2 Q001');
        // read out letter by letter, and written left-to-right in any language
        expect(byTestId(c, 'whatsapp-code')?.getAttribute('aria-label')).toBe(
            'Your code: K 7 M 2 Q 0 0 1',
        );
        expect(byTestId(c, 'whatsapp-code')?.getAttribute('dir')).toBe('ltr');
        expect(text(byTestId(c, 'whatsapp-expiry'))).toBe(
            'This code works for another 24 hours.',
        );
        expect(
            [
                ...c.querySelectorAll<HTMLElement>(
                    '[data-testid^="whatsapp-"]',
                ),
            ].map((e) => e.dataset.testid),
        ).toEqual([
            'whatsapp-code',
            'whatsapp-expiry',
            'whatsapp-open',
            'whatsapp-copy',
            'whatsapp-sent',
            'whatsapp-back',
        ]);
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });

    it('opens WhatsApp in a new tab with the server link, safely', async () => {
        const { c } = await handOff();
        const open = byTestId(c, 'whatsapp-open') as HTMLAnchorElement;

        expect(open.tagName).toBe('A');
        expect(open.getAttribute('href')).toMatch(
            /^https:\/\/wa\.me\/491701234567\?text=/,
        );
        expect(open.getAttribute('target')).toBe('_blank');
        expect(open.getAttribute('rel')).toBe('noopener noreferrer');
        expect(open.getAttribute('aria-disabled')).toBeNull();
        expect(text(open)).toBe('Open WhatsApp');
    });

    it('refuses a link that is not WhatsApp: no anchor, a disabled button, the code still shown', async () => {
        const boot = whatsappBoot();
        const ctx = await panel(boot);

        server.use(
            http.post(`${API}/widgets/:key/whatsapp-handoff`, () =>
                HttpResponse.json({
                    data: {
                        code: 'K7M2Q777',
                        waUrl: 'javascript:alert(document.domain)',
                        expiresAt: new Date(
                            Date.now() + 3_600_000,
                        ).toISOString(),
                    },
                }),
            ),
        );
        await click(byTestId(ctx.c, 'channel-whatsapp'));
        await waitFor(() => phase(ctx.c) === 'whatsapp');

        const open = byTestId(ctx.c, 'whatsapp-open');

        expect(open?.tagName).toBe('BUTTON');
        expect(open?.getAttribute('aria-disabled')).toBe('true');
        expect(open?.hasAttribute('href')).toBe(false);
        expect(ctx.c.querySelector('a[href^="javascript"]')).toBeNull();
        expect(text(byTestId(ctx.c, 'whatsapp-code'))).toBe('K7M2 Q777');
    });

    it('copies the plain code, says so, and falls back to selecting it when the clipboard refuses', async () => {
        const { c } = await handOff();
        const write = fakeClipboard(async () => undefined);

        await click(byTestId(c, 'whatsapp-copy'));

        expect(write).toHaveBeenCalledWith('K7M2Q001');
        expect(text(byTestId(c, 'whatsapp-copy'))).toBe('Copied');

        fakeClipboard(async () => {
            throw new Error('denied');
        });

        const second = await handOff();

        // the screen moves focus to its first control on the next frame: let that settle before the visitor "clicks"
        await settleFrame();
        await click(byTestId(second.c, 'whatsapp-copy'));

        expect(text(second.c)).toContain('Select the code');
        const sel = window.getSelection();

        expect([
            sel?.rangeCount,
            sel?.anchorNode?.nodeName,
            sel?.toString(),
            second.c.contains(sel?.anchorNode ?? null),
        ]).toEqual([1, 'P', 'K7M2 Q001', true]);
        // the label never claims success
        expect(text(byTestId(second.c, 'whatsapp-copy'))).toBe('Copy code');
    });

    it('goes back to the choice from the hand-off screen', async () => {
        const { c } = await handOff();

        await click(byTestId(c, 'whatsapp-back'));

        expect(phase(c)).toBe('idle');
        expect(byTestId(c, 'channel-chooser')).not.toBeNull();
    });

    it('"I sent it" ends on a friendly closed screen, and "Start a new chat" goes back to the choice', async () => {
        const { c, h } = await handOff();

        await click(byTestId(c, 'whatsapp-sent'));

        expect(phase(c)).toBe('closed');
        expect(text(c.querySelector('h2'))).toBe("We'll reply on WhatsApp");
        expect(text(c)).toContain('Our reply will arrive in your WhatsApp');
        expect(byTestId(c, 'whatsapp-code')).toBeNull();
        expect(h.hostStates().at(-1)?.status).toBe('closed');

        await click(byTestId(c, 'new-chat'));

        expect(phase(c)).toBe('idle');
        expect(byTestId(c, 'channel-chooser')).not.toBeNull();
    });
});

describe('the code countdown', () => {
    it('counts down, then offers a new code in place of the actions', async () => {
        vi.useFakeTimers({
            toFake: ['Date', 'setInterval', 'clearInterval'],
        });

        const boot = whatsappBoot();
        const ctx = await panel(boot);

        ctx.backend.state.handoffTtlMs = 3 * 60_000;
        await click(byTestId(ctx.c, 'channel-whatsapp'));
        await waitFor(() => phase(ctx.c) === 'whatsapp');

        expect(text(byTestId(ctx.c, 'whatsapp-expiry'))).toBe(
            'This code works for another 3 minutes.',
        );

        await run(() => {
            vi.advanceTimersByTime(2 * 60_000);
        });

        expect(text(byTestId(ctx.c, 'whatsapp-expiry'))).toBe(
            'This code works for another 1 minute.',
        );
        expect(byTestId(ctx.c, 'whatsapp-new-code')).toBeNull();

        await run(() => {
            vi.advanceTimersByTime(2 * 60_000);
        });

        const expiry = byTestId(ctx.c, 'whatsapp-expiry');

        expect(expiry?.dataset.expired).toBe('true');
        expect(expiry?.getAttribute('role')).toBe('status');
        expect(text(expiry)).toBe('This code has expired.');
        expect(byTestId(ctx.c, 'whatsapp-open')).toBeNull();
        expect(byTestId(ctx.c, 'whatsapp-copy')).toBeNull();
        expect(byTestId(ctx.c, 'whatsapp-sent')).toBeNull();
        expect(byTestId(ctx.c, 'whatsapp-code')?.className).toContain(
            'line-through',
        );

        await click(byTestId(ctx.c, 'whatsapp-new-code'));
        await waitFor(
            () => text(byTestId(ctx.c, 'whatsapp-code')) === 'K7M2 Q002',
        );

        expect(ctx.backend.callsTo('POST', '/whatsapp-handoff')).toHaveLength(
            2,
        );
        expect(byTestId(ctx.c, 'whatsapp-new-code')).toBeNull();
        expect(byTestId(ctx.c, 'whatsapp-open')).not.toBeNull();
    });
});

describe('failures', () => {
    it('409: says WhatsApp is not available now and keeps the choice (the visitor can still chat)', async () => {
        const { c, backend } = await panel();

        backend.state.whatsappUnavailable = true;
        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => c.querySelector('[role="alert"]') !== null);

        expect(phase(c)).toBe('idle');
        expect(text(c.querySelector('[role="alert"]'))).toContain(
            "WhatsApp isn't available right now",
        );
        expect(
            (byTestId(c, 'channel-chat') as HTMLButtonElement).disabled,
        ).toBe(false);

        await click(byTestId(c, 'channel-chat'));
        await waitFor(() => phase(c) === 'queued');
    });

    it('429: asks to wait a moment and stays on the choice', async () => {
        const { c, backend } = await panel();

        backend.fail(
            'POST',
            '/whatsapp-handoff',
            429,
            { error: { code: 'rate_limited', message: 'Too many.' } },
            1,
            { 'Retry-After': '7' },
        );
        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => c.querySelector('[role="alert"]') !== null);

        expect(phase(c)).toBe('idle');
        expect(text(c.querySelector('[role="alert"]'))).toMatch(/7 seconds/);
    });

    it('403 (the feature was switched off): a clear message, no hand-off screen', async () => {
        const { c, backend } = await panel();

        backend.fail('POST', '/whatsapp-handoff', 403, {
            error: { code: 'feature_disabled', message: 'Off.' },
        });
        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => c.querySelector('[role="alert"]') !== null);

        expect(phase(c)).toBe('idle');
        expect(byTestId(c, 'whatsapp-code')).toBeNull();
        expect(
            c.querySelector('[role="alert"]')?.textContent?.length,
        ).toBeGreaterThan(10);
    });
});

describe('the builder preview', () => {
    const previewBoot = (whatsapp: boolean): Boot => {
        const base = bootConfig();

        return bootConfig({
            config: {
                ...(base.config as object),
                features: {
                    ...(base.config.features as object),
                    whatsapp,
                    preChat: false,
                },
            },
            categories: base.categories.slice(0, 1),
            availability: {
                ...base.availability,
                whatsapp: { enabled: whatsapp },
            },
        });
    };

    it('shows the chooser on canned data, and its hand-off never opens a link or calls the API', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch');
        const xhrSpy = vi.spyOn(XMLHttpRequest.prototype, 'open');
        const demo = createDemoBackend({ delay: 0.02 });
        const h = createHarness({
            deps: {
                preview: true,
                createApi: () => demo.api,
                socketFactory: demo.socketFactory,
            },
        });
        const view = await renderPanel(h, { ...ENV, preview: true });
        const c = view.container;

        await run(() => h.init(makeInit({ boot: previewBoot(true) })));
        await run(() => h.open());

        expect(byTestId(c, 'channel-chooser')).not.toBeNull();

        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => phase(c) === 'whatsapp', 4000);

        const open = byTestId(c, 'whatsapp-open');

        expect(open?.tagName).toBe('BUTTON');
        expect(open?.getAttribute('aria-disabled')).toBe('true');
        expect(text(byTestId(c, 'whatsapp-code'))).not.toBe('');
        expect(fetchSpy).not.toHaveBeenCalled();
        expect(xhrSpy).not.toHaveBeenCalled();
        demo.dispose();
    });

    it('offers WhatsApp in the preview exactly when the draft turns the feature on', () => {
        const draft = (whatsapp: boolean): Dict => ({
            features: { whatsapp },
            hours: { mode: 'always_online' },
        });

        expect(previewAvailability(null, draft(true)).whatsapp).toEqual({
            enabled: true,
        });
        expect(previewAvailability(null, draft(false)).whatsapp).toEqual({
            enabled: false,
        });
        expect(previewAvailability(null, null).whatsapp).toEqual({
            enabled: false,
        });
    });
});

describe('accessibility (axe) and right-to-left', () => {
    it('the chooser has no violations', async () => {
        const { c } = await panel();

        expect(await violations(c)).toEqual([]);
    });

    it('the offline screen with the WhatsApp alternative has no violations', async () => {
        const { c } = await panel(whatsappBoot({ online: false }));

        expect(await violations(c)).toEqual([]);
    });

    it('the topic picker for a hand-off has no violations', async () => {
        const { c } = await panel(whatsappBoot({ categories: 2 }));

        await click(byTestId(c, 'channel-whatsapp'));

        expect(phase(c)).toBe('category');
        expect(await violations(c)).toEqual([]);
    });

    it('the hand-off screen (and after a failed copy) has no violations', async () => {
        const { c } = await handOff();

        expect(await violations(c)).toEqual([]);

        fakeClipboard(async () => {
            throw new Error('denied');
        });
        await click(byTestId(c, 'whatsapp-copy'));

        expect(text(c)).toContain('Select the code');
        expect(await violations(c)).toEqual([]);
    });

    it('the expired state has no violations', async () => {
        vi.useFakeTimers({
            toFake: ['Date', 'setInterval', 'clearInterval'],
        });

        const { c, backend } = await panel();

        backend.state.handoffTtlMs = 60_000;
        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => phase(c) === 'whatsapp');
        await run(() => {
            vi.advanceTimersByTime(2 * 60_000);
        });

        expect(byTestId(c, 'whatsapp-new-code')).not.toBeNull();
        expect(await violations(c)).toEqual([]);
    });

    it('the closed screen has no violations', async () => {
        const { c } = await handOff();

        await click(byTestId(c, 'whatsapp-sent'));

        expect(phase(c)).toBe('closed');
        expect(await violations(c)).toEqual([]);
    });

    it('renders the chooser and the hand-off screen in Arabic: right-to-left, a left-to-right code, mirrored arrows', async () => {
        const boot = whatsappBoot({
            locale: 'ar',
            texts: {
                ar: {
                    title: 'الدعم',
                    subtitle: 'نرد عادة خلال دقائق',
                    welcome: 'مرحبا! كيف نساعدك؟',
                    categoryPrompt: 'ما الذي تحتاجه؟',
                    send: 'إرسال',
                    placeholder: 'اكتب رسالتك…',
                    attach: 'إرفاق صورة',
                    endChat: 'إنهاء المحادثة',
                    closeChat: 'إغلاق',
                    startNewChat: 'ابدأ محادثة جديدة',
                },
            },
        });
        const backend = useBackend({
            config: boot,
            availability: boot.availability as Record<string, unknown>,
        });
        const h = createHarness({ backend, builtin: loadBuiltin });
        const view = await renderPanel(h);
        const c = view.container;

        await run(() =>
            h.init(makeInit({ boot, overrides: { locale: 'ar' } })),
        );
        await run(() => h.open());

        const root = byTestId(c, 'chat-panel') as HTMLElement;

        expect(root.getAttribute('dir')).toBe('rtl');
        expect(text(byTestId(c, 'channel-chat'))).not.toContain('Chat here');
        expect(text(byTestId(c, 'channel-whatsapp'))).toContain('واتساب');

        await click(byTestId(c, 'channel-whatsapp'));
        await waitFor(() => phase(c) === 'whatsapp');

        expect(text(c.querySelector('h2'))).toContain('واتساب');
        expect(byTestId(c, 'whatsapp-code')?.getAttribute('dir')).toBe('ltr');
        expect(text(byTestId(c, 'whatsapp-code'))).toBe('K7M2 Q001');
        expect(
            byTestId(c, 'whatsapp-open')?.querySelector(
                'svg.rtl\\:-scale-x-100',
            ),
        ).not.toBeNull();
        // digits and units of the countdown come from Intl in Arabic, not English words
        expect(text(byTestId(c, 'whatsapp-expiry'))).not.toMatch(/hours?/);
        expect(await violations(c)).toEqual([]);
    });

    it('lets a 320px screen wrap: the code breaks anywhere, nothing has a fixed width', async () => {
        const { c } = await handOff();
        const code = byTestId(c, 'whatsapp-code') as HTMLElement;

        expect(code.className).toContain('[overflow-wrap:anywhere]');
        expect(c.querySelector('section')?.className).toContain(
            'overflow-y-auto',
        );
        expect(
            [...c.querySelectorAll('section *')].some((e) =>
                /(?:^|\s)w-\[\d+px\]|(?:^|\s)min-w-\[\d+px\]/.test(
                    e.getAttribute('class') ?? '',
                ),
            ),
        ).toBe(false);
    });
});
