import { describe, expect, it } from 'vite-plus/test';
import { fill } from '@/tests/dom';
import { click } from '@/tests/render';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import { createHarness, loaderBoot, makeInit } from '@/tests/embed-harness';
import { renderPanel, run, text, waitFor } from '@/tests/embed-render';
import { loadBuiltin } from '@/embed/i18n';

const byTestId = (root: ParentNode, id: string): HTMLElement | null =>
    root.querySelector<HTMLElement>(`[data-testid="${id}"]`);

const arabicBoot = () => {
    const base = bootConfig().config as { texts: Record<string, object> };

    return loaderBoot({
        config: {
            ...base,
            defaultLocale: 'ar',
            texts: {
                ...base.texts,
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
                },
            },
        },
    });
};

describe('right-to-left', () => {
    it('renders the whole panel in Arabic: dir, lang, widget texts and the built-in chrome', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, builtin: loadBuiltin });
        const view = await renderPanel(h);

        await run(() =>
            h.init(
                makeInit({ boot: arabicBoot(), overrides: { locale: 'ar' } }),
            ),
        );
        await run(() => h.open());

        const root = byTestId(view.container, 'chat-panel') as HTMLElement;

        expect(root.getAttribute('dir')).toBe('rtl');
        expect(root.getAttribute('lang')).toBe('ar');
        expect(document.documentElement.dir).toBe('rtl');
        expect(document.documentElement.lang).toBe('ar');
        expect(text(view.container.querySelector('header h1'))).toBe('الدعم');
        // built-in chrome in Arabic
        expect(text(view.container)).toContain('اسمك');
        expect(text(view.container)).toContain('ابدأ المحادثة');
        expect(
            view.container.querySelector('button[aria-label="إغلاق"]'),
        ).not.toBeNull();

        await fill(view.container.querySelector('input[name="name"]'), 'ليلى');
        await click(view.container.querySelector('button[type="submit"]'));

        // the chevron of a topic card mirrors in right-to-left
        expect(
            byTestId(view.container, 'category-option-billing')?.querySelector(
                'svg.rtl\\:-scale-x-100',
            ),
        ).not.toBeNull();
    });

    it('English chrome stays left-to-right, and a locale without texts keeps the English direction', async () => {
        const h = createHarness({ backend: useBackend() });
        const view = await renderPanel(h);

        await run(() => h.init(makeInit({ overrides: { locale: 'ar' } })));

        expect(
            byTestId(view.container, 'chat-panel')?.getAttribute('dir'),
        ).toBe('ltr');
    });

    it('formats the chat in the visitor locale: Arabic labels for time and day separators', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('مرحبا', { createdAt: new Date().toISOString() });

        const h = createHarness({ backend, builtin: loadBuiltin });
        const view = await renderPanel(h);

        await run(() =>
            h.init(
                makeInit({
                    boot: arabicBoot(),
                    overrides: { locale: 'ar' },
                    visitorSession: stored,
                }),
            ),
        );
        await run(() => h.open());
        await waitFor(
            () =>
                byTestId(view.container, 'message-list')?.textContent?.includes(
                    'مرحبا',
                ) === true,
        );

        expect(text(byTestId(view.container, 'message-list'))).not.toContain(
            'Today',
        );
        expect(
            byTestId(view.container, 'composer-input')?.getAttribute(
                'placeholder',
            ),
        ).toBe('اكتب رسالتك…');
    });
});
