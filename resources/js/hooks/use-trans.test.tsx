import { act } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { useDirection } from '@/hooks/use-direction';
import { i18n, useTrans } from '@/hooks/use-trans';
import { render } from '@/tests/render';

const page = vi.hoisted(() => ({
    props: { locale: 'en', direction: undefined as string | undefined },
}));

vi.mock('@inertiajs/react', () => ({
    usePage: () => ({ props: page.props }),
}));

function Probe({ keyName = 'common.back' }: { keyName?: string }) {
    const { t, direction } = useTrans();

    return (
        <p data-testid="out" data-direction={direction}>
            {t(keyName, { name: 'Sam', app: 'PNE Chat', minutes: 30 })}
        </p>
    );
}

function DirectionProbe() {
    const { direction, isRtl, locale } = useDirection();

    return (
        <p data-testid="dir" data-rtl={String(isRtl)}>
            {direction}:{locale}
        </p>
    );
}

describe('useTrans (against the real lang files)', () => {
    it('renders English for the en locale', async () => {
        page.props = { locale: 'en', direction: undefined };

        const view = await render(<Probe />);

        expect(view.byTestId('out')?.textContent).toBe('Back');
    });

    it('swaps in the Arabic stub once it is lazily loaded, and flags rtl', async () => {
        page.props = { locale: 'ar', direction: undefined };

        const view = await render(<Probe />);

        await act(async () => {
            await i18n.load('ar');
        });

        expect(view.byTestId('out')?.textContent).toBe('رجوع');
        expect(view.byTestId('out')?.dataset.direction).toBe('rtl');
    });

    it('falls back to English for keys the Arabic stub lacks', async () => {
        page.props = { locale: 'ar', direction: undefined };
        await i18n.load('ar');

        const translated = await render(<Probe keyName="common.retry" />);
        const missing = await render(<Probe keyName="setup.token.submit" />);

        expect(translated.byTestId('out')?.textContent).toBe('إعادة المحاولة');
        expect(missing.byTestId('out')?.textContent).toBe('Verify token');
    });

    it('falls back to the key when no locale has it', async () => {
        page.props = { locale: 'en', direction: undefined };

        const view = await render(<Probe keyName="does.not.exist" />);

        expect(view.byTestId('out')?.textContent).toBe('does.not.exist');
    });

    it('applies :name style replacements', async () => {
        page.props = { locale: 'en', direction: undefined };

        const welcome = await render(<Probe keyName="setup.welcome.title" />);
        const hint = await render(
            <Probe keyName="setup.basics.idle_timeout_hint" />,
        );

        expect(welcome.byTestId('out')?.textContent).toBe(
            'Welcome to PNE Chat',
        );
        expect(hint.byTestId('out')?.textContent).toBe(
            'Chats close automatically after 30 minutes without messages. Default: 120.',
        );
    });

    it('treats an unknown locale as English', async () => {
        page.props = { locale: 'xx', direction: undefined };

        const view = await render(<Probe />);

        expect(view.byTestId('out')?.textContent).toBe('Back');
        expect(view.byTestId('out')?.dataset.direction).toBe('ltr');
    });
});

const langFiles = import.meta.glob<Record<string, string>>('/lang/*.json', {
    eager: true,
    import: 'default',
});
const en = langFiles['/lang/en.json'];
const ar = langFiles['/lang/ar.json'];

describe('lang files', () => {
    it('Arabic stub has no key that English lacks', () => {
        expect(Object.keys(ar).filter((key) => !(key in en))).toEqual([]);
    });

    it('keeps :placeholders identical between English and Arabic', () => {
        const placeholders = (text: string) =>
            [...text.matchAll(/:([A-Za-z_]\w*)/g)].map((m) => m[1]).sort();

        for (const [key, value] of Object.entries(ar)) {
            expect(placeholders(value), key).toEqual(placeholders(en[key]));
        }
    });

    it('never uses an em dash in English copy', () => {
        expect(Object.values(en).filter((v) => v.includes('\u2014'))).toEqual(
            [],
        );
    });
});

describe('useDirection', () => {
    it('uses the shared direction prop and keeps <html dir lang> in sync', async () => {
        page.props = { locale: 'ar', direction: 'rtl' };

        const view = await render(<DirectionProbe />);

        expect(view.byTestId('dir')?.textContent).toBe('rtl:ar');
        expect(view.byTestId('dir')?.dataset.rtl).toBe('true');
        expect(document.documentElement.dir).toBe('rtl');
        expect(document.documentElement.lang).toBe('ar');
    });

    it('derives the direction from the locale when the prop is missing', async () => {
        page.props = { locale: 'he', direction: undefined };

        const view = await render(<DirectionProbe />);

        expect(view.byTestId('dir')?.textContent).toBe('rtl:he');
    });

    it('is ltr for English', async () => {
        page.props = { locale: 'en', direction: 'ltr' };

        const view = await render(<DirectionProbe />);

        expect(view.byTestId('dir')?.dataset.rtl).toBe('false');
        expect(document.documentElement.dir).toBe('ltr');
    });
});
