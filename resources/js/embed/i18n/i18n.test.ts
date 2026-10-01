import { describe, expect, it } from 'vite-plus/test';
import { AR } from '@/embed/i18n/ar';
import { EN, WIDGET_TEXT_KEYS, type MessageKey } from '@/embed/i18n/en';
import { createTranslate, loadBuiltin } from '@/embed/i18n';

describe('panel strings', () => {
    it('has an English default for every widget text key the builder offers, and no stray ones', () => {
        // docs/contracts/widget-config.md: `WidgetTexts::keys()` is exactly these 20
        expect(WIDGET_TEXT_KEYS).toHaveLength(20);

        for (const key of WIDGET_TEXT_KEYS) {
            expect(EN[key], key).toBeTruthy();
        }

        const chrome = (Object.keys(EN) as MessageKey[]).filter(
            (key) => !(WIDGET_TEXT_KEYS as readonly string[]).includes(key),
        );

        expect(chrome.every((key) => key.startsWith('embed.chat.'))).toBe(true);
    });

    it('never leaves an empty string, and the Arabic table matches the English keys exactly', () => {
        for (const value of Object.values(EN)) {
            expect(value.trim()).not.toBe('');
        }

        expect(Object.keys(AR).sort()).toEqual(Object.keys(EN).sort());

        for (const [key, value] of Object.entries(AR)) {
            expect((value ?? '').trim(), key).not.toBe('');
            // placeholders must survive translation
            const placeholders = (text: string) =>
                [...text.matchAll(/:[a-z]+/g)].map((m) => m[0]).sort();

            expect(placeholders(value ?? ''), key).toEqual(
                placeholders(EN[key as MessageKey]),
            );
        }
    });

    it('resolves widget text, then the built-in table, then English, then the key', () => {
        const t = createTranslate({
            texts: {
                en: { title: 'Acme help', send: 'Go' },
                ar: { title: 'مساعدة' },
            },
            textLocale: 'ar',
            defaultLocale: 'en',
            builtin: AR,
        });

        expect(t('title')).toBe('مساعدة');
        // not edited for ar: the default locale's admin text wins over the built-in Arabic
        expect(t('send')).toBe('Go');
        // not a widget key: the built-in table
        expect(t('embed.chat.back')).toBe('رجوع');
        // not in the built-in table: English
        const partial = createTranslate({
            texts: {},
            textLocale: 'ar',
            defaultLocale: 'en',
            builtin: {},
        });

        expect(partial('embed.chat.back')).toBe('Back');
        expect(partial('nope' as MessageKey)).toBe('nope');
    });

    it('interpolates :placeholders', () => {
        const t = createTranslate({
            texts: {},
            textLocale: 'en',
            defaultLocale: 'en',
        });

        expect(t('embed.chat.queued.waiting', { time: '1:05' })).toBe(
            'Waiting 1:05',
        );
        expect(t('embed.chat.active.typing', { name: 'Sam' })).toBe(
            'Sam is typing…',
        );
    });

    it('loads the Arabic table lazily and nothing for other languages', async () => {
        expect((await loadBuiltin('ar-SA')).title).toBe('الدعم');
        expect(await loadBuiltin('fr')).toEqual({});
    });
});
