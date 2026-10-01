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

        // every English key is translated; the only extra keys are the plural forms English does not have (zero / two / few / many)
        const extras = Object.keys(AR).filter((key) => !(key in EN));

        expect(Object.keys(EN).filter((key) => !(key in AR))).toEqual([]);

        for (const key of extras) {
            expect(key).toMatch(/\.(zero|two|few|many)$/);
            expect(`${key.replace(/\.[a-z]+$/, '')}.other` in EN, key).toBe(
                true,
            );
        }

        for (const [key, value] of Object.entries(AR)) {
            expect((value ?? '').trim(), key).not.toBe('');
            // placeholders must survive translation (a plural form of a text may spell its number out, so it keeps a subset)
            const placeholders = (text: string) =>
                [...text.matchAll(/:[a-z]+/g)].map((m) => m[0]).sort();
            const source =
                EN[key as MessageKey] ??
                EN[`${key.replace(/\.[a-z]+$/, '')}.other` as MessageKey];

            if (key in EN && !/\.(one|other)$/.test(key)) {
                expect(placeholders(value ?? ''), key).toEqual(
                    placeholders(source),
                );
            } else {
                for (const placeholder of placeholders(value ?? '')) {
                    expect(placeholders(source), key).toContain(placeholder);
                }
            }
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

    it('a text the server completed with the English default does not shadow the built-in translation, an edited one still does', () => {
        const completed = createTranslate({
            texts: {
                // `LocaleResolver::completeTexts` fills every editable key: English where nothing was written
                ar: {
                    ...Object.fromEntries(
                        WIDGET_TEXT_KEYS.map((key) => [key, EN[key]]),
                    ),
                    title: 'مساعدة أكمي',
                },
            },
            textLocale: 'ar',
            defaultLocale: 'ar',
            builtin: AR,
        });

        expect(completed('title')).toBe('مساعدة أكمي');
        expect(completed('send')).toBe(AR.send);
        expect(completed('welcome')).toBe(AR.welcome);

        // no built-in table (a language without one): the English text stays
        const english = createTranslate({
            texts: { fr: { send: EN.send } },
            textLocale: 'fr',
            defaultLocale: 'fr',
            builtin: {},
        });

        expect(english('send')).toBe(EN.send);
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
