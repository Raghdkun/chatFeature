import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createI18n,
    directionFor,
    interpolate,
    localeCandidates,
    localeFromPath,
    localeLabel,
    type Messages,
} from '@/lib/i18n';

const en: Messages = {
    'greet.hello': 'Hello :name',
    'only.en': 'English only',
    plain: 'Plain',
};
const ar: Messages = {
    'greet.hello': 'مرحبًا :name',
};
const ptBr: Messages = { 'greet.hello': 'Olá :name (BR)' };
const pt: Messages = { 'greet.hello': 'Olá :name', 'only.pt': 'Só pt' };

const make = (loaders: Record<string, () => Promise<Messages>> = {}) =>
    createI18n({ fallbackLocale: 'en', bundled: { en }, loaders });

describe('interpolate', () => {
    it('replaces :name placeholders, including numbers', () => {
        expect(
            interpolate('Hi :name, :count new', { name: 'Sam', count: 3 }),
        ).toBe('Hi Sam, 3 new');
    });

    it('supports :Name and :NAME like Laravel', () => {
        expect(interpolate(':name / :Name / :NAME', { name: 'sam' })).toBe(
            'sam / Sam / SAM',
        );
    });

    it('leaves unknown placeholders and plain colons untouched', () => {
        expect(interpolate('Time 12:30 :unknown', { name: 'x' })).toBe(
            'Time 12:30 :unknown',
        );
        expect(interpolate('Note: keep this')).toBe('Note: keep this');
    });

    it('does not replace a placeholder that merely starts like another', () => {
        expect(interpolate(':names', { name: 'x' })).toBe(':names');
        expect(interpolate(':name:', { name: 'x' })).toBe('x:');
    });
});

describe('directionFor', () => {
    it('is rtl for Arabic, Hebrew, Persian and Urdu in any spelling', () => {
        for (const locale of ['ar', 'he', 'fa', 'ur', 'ar-EG', 'ar_SA', 'AR']) {
            expect(directionFor(locale)).toBe('rtl');
        }
    });

    it('is ltr for everything else and for missing locales', () => {
        for (const locale of [
            'en',
            'en-US',
            'de',
            'pt_BR',
            '',
            null,
            undefined,
        ]) {
            expect(directionFor(locale)).toBe('ltr');
        }
    });
});

describe('locale helpers', () => {
    it('lists the full tag first, then the base language', () => {
        expect(localeCandidates('pt_BR')).toEqual(['pt-BR', 'pt']);
        expect(localeCandidates('ar')).toEqual(['ar']);
    });

    it('derives the locale code from a lang file path', () => {
        expect(localeFromPath('/lang/ar.json')).toBe('ar');
        expect(localeFromPath('/lang/pt-BR.json')).toBe('pt-BR');
    });

    it('names a locale in its own language, falling back to the code', () => {
        expect(localeLabel('en')).toContain('English');
        expect(localeLabel('en')).toContain('(en)');
        expect(localeLabel('not a locale!')).toBe('not a locale!');
    });
});

describe('translation lookup', () => {
    it('translates from the requested locale once it is loaded', async () => {
        const i18n = make({ ar: async () => ar });

        await i18n.load('ar');

        expect(i18n.translate('ar', 'greet.hello', { name: 'سارة' })).toBe(
            'مرحبًا سارة',
        );
    });

    it('falls back to English for keys the locale lacks', async () => {
        const i18n = make({ ar: async () => ar });

        await i18n.load('ar');

        expect(i18n.translate('ar', 'only.en')).toBe('English only');
    });

    it('falls back to the key itself (still interpolated) when nothing has it', () => {
        const i18n = make();

        expect(i18n.translate('en', 'missing.key')).toBe('missing.key');
        expect(i18n.translate('en', 'Welcome :name', { name: 'Sam' })).toBe(
            'Welcome Sam',
        );
    });

    it('serves English before the locale file has arrived', () => {
        const i18n = make({ ar: async () => ar });

        expect(i18n.translate('ar', 'greet.hello', { name: 'Sam' })).toBe(
            'Hello Sam',
        );
    });

    it('prefers the regional file, then the base language, then English', async () => {
        const i18n = make({ 'pt-BR': async () => ptBr, pt: async () => pt });

        await i18n.load('pt-BR');

        expect(i18n.translate('pt-BR', 'greet.hello', { name: 'A' })).toBe(
            'Olá A (BR)',
        );
        expect(i18n.translate('pt-BR', 'only.pt')).toBe('Só pt');
        expect(i18n.translate('pt-BR', 'only.en')).toBe('English only');
    });

    it('does not mistake prototype members for keys', () => {
        const i18n = make();

        expect(i18n.translate('en', 'constructor')).toBe('constructor');
        expect(i18n.has('en', 'toString')).toBe(false);
    });

    it('tells whether a key exists in the locale or in English', async () => {
        const i18n = make({ ar: async () => ar });

        await i18n.load('ar');

        expect(i18n.has('ar', 'greet.hello')).toBe(true);
        expect(i18n.has('ar', 'only.en')).toBe(true);
        expect(i18n.has('ar', 'nope')).toBe(false);
    });
});

describe('lazy loading', () => {
    it('loads a locale file only once, even for concurrent callers', async () => {
        const loader = vi.fn(async () => ar);
        const i18n = make({ ar: loader });

        await Promise.all([i18n.load('ar'), i18n.load('ar')]);
        await i18n.load('ar');

        expect(loader).toHaveBeenCalledTimes(1);
    });

    it('never loads English or unknown locales', async () => {
        const loader = vi.fn(async () => ar);
        const i18n = make({ ar: loader });

        await i18n.load('en');
        await i18n.load('xx');

        expect(loader).not.toHaveBeenCalled();
    });

    it('notifies subscribers when a locale arrives and hands out a fresh translator', async () => {
        const i18n = make({ ar: async () => ar });
        const listener = vi.fn();
        const before = i18n.translatorFor('ar');

        i18n.subscribe(listener);
        expect(i18n.translatorFor('ar')).toBe(before);

        await i18n.load('ar');

        expect(listener).toHaveBeenCalledTimes(1);
        expect(i18n.translatorFor('ar')).not.toBe(before);
        expect(i18n.translatorFor('ar').t('greet.hello', { name: 'x' })).toBe(
            'مرحبًا x',
        );
        expect(i18n.translatorFor('ar').direction).toBe('rtl');
    });

    it('stops notifying after unsubscribe', async () => {
        const i18n = make({ ar: async () => ar });
        const listener = vi.fn();

        i18n.subscribe(listener)();
        await i18n.load('ar');

        expect(listener).not.toHaveBeenCalled();
    });

    it('survives a locale file that fails to load and keeps falling back', async () => {
        const i18n = make({
            ar: async () => {
                throw new Error('404');
            },
        });

        await expect(i18n.load('ar')).resolves.toBeUndefined();
        expect(i18n.translate('ar', 'plain')).toBe('Plain');
    });

    it('lists the available locales, sorted', () => {
        const i18n = make({ ar: async () => ar, fa: async () => ar });

        expect(i18n.availableLocales()).toEqual(['ar', 'en', 'fa']);
    });
});
