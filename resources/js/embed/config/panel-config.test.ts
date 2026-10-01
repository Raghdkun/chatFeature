import { describe, expect, it } from 'vite-plus/test';
import {
    buildPanelConfig,
    categoryOnline,
    DEFAULT_THEME,
    isOffline,
    needsPreChat,
    pickLocale,
    sanitizeTheme,
} from '@/embed/config/panel-config';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { loaderBoot } from '@/tests/embed-harness';

const APP = 'https://chat.test';
const base = () => bootConfig() as Record<string, unknown>;

describe('buildPanelConfig', () => {
    it("builds a complete, validated config from the loader's boot", () => {
        const config = buildPanelConfig({
            boot: loaderBoot(),
            navigatorLanguages: ['en-US'],
        });

        expect(config).toMatchObject({
            key: 'wk_testkey0000000000000',
            apiBase: 'https://chat.test/api/v1/public',
            appOrigin: APP,
            locale: 'en-US',
            textLocale: 'en',
            dir: 'ltr',
            theme: { primary: '#0f766e', radius: 16, shadow: 'soft' },
            features: { attachments: true, rating: true, whatsapp: false },
        });
        expect(config.categories.map((c) => c.slug)).toEqual([
            'billing',
            'tech',
        ]);
        expect(config.availability?.online).toBe(true);
    });

    it('survives a nearly empty boot with the documented defaults', () => {
        const config = buildPanelConfig({
            boot: {
                key: 'wk_x',
                api: { appOrigin: APP, base: `${APP}/api/v1/public` },
            },
        });

        expect(config.theme).toEqual(DEFAULT_THEME);
        expect(config.features.rating).toBe(true);
        expect(config.preChat.fields.name).toEqual({
            enabled: true,
            required: true,
        });
        expect(config.availability).toBeNull();
        expect(config.categories).toEqual([]);
        expect(isOffline(config)).toBe(false);
    });

    it('a hostile init cannot point the panel at another origin: the inlined app origin wins and the font origin follows it', () => {
        const boot = loaderBoot({
            api: {
                base: 'https://evil.example/api/v1/public',
                embed: 'https://evil.example/embed/wk',
                appOrigin: 'https://evil.example',
            },
        });
        const config = buildPanelConfig({
            boot: {
                ...boot,
                config: {
                    ...(boot.config as object),
                    theme: {
                        ...(boot.config as { theme: object }).theme,
                        fontUrl: 'https://evil.example/f.css',
                    },
                },
            },
            trustedOrigin: APP,
        });

        expect(config.appOrigin).toBe(APP);
        expect(config.apiBase).toBe(`${APP}/api/v1/public`);
        expect(config.theme.fontUrl).toBeNull();

        // a font on the trusted origin is fine, and a base on the trusted origin is kept
        const own = buildPanelConfig({
            boot: {
                ...boot,
                api: { base: `${APP}/api/v2/public`, appOrigin: 'https://x' },
                config: {
                    ...(boot.config as object),
                    theme: { fontUrl: `${APP}/fonts/f.css` },
                },
            },
            trustedOrigin: APP,
        });

        expect(own.apiBase).toBe(`${APP}/api/v2/public`);
        expect(own.theme.fontUrl).toBe(`${APP}/fonts/f.css`);
    });

    it('without a trusted origin (tests, the builder preview) the boot copy is used as before', () => {
        const config = buildPanelConfig({
            boot: loaderBoot({
                api: {
                    base: 'https://other.test/api',
                    appOrigin: 'https://other.test',
                },
            }),
        });

        expect(config.appOrigin).toBe('https://other.test');
        expect(config.apiBase).toBe('https://other.test/api');
    });

    it('accepts category slugs of up to 64 characters (the server allows 64)', () => {
        const slug = `a${'b'.repeat(63)}`;
        const boot = loaderBoot({
            categories: [
                { slug, label: 'Long' },
                { slug: `${slug}c`, label: 'Too long' },
            ],
        });

        expect(
            buildPanelConfig({ boot }).categories.map((c) => c.slug),
        ).toEqual([slug]);
    });

    it('derives the API base from the app origin when the boot has none', () => {
        expect(
            buildPanelConfig({ boot: { key: 'wk_x', api: { appOrigin: APP } } })
                .apiBase,
        ).toBe(`${APP}/api/v1/public`);
    });

    it('prefers the fresh public config for categories (description, icon, colour) and availability', () => {
        const fresh = base();
        const config = buildPanelConfig({ boot: loaderBoot(), fresh });

        expect(config.categories[0]).toMatchObject({
            description: 'Invoices and payments',
            icon: 'credit-card',
            color: '#7c3aed',
        });

        const offline = buildPanelConfig({
            boot: loaderBoot(),
            fresh: {
                ...fresh,
                availability: {
                    online: false,
                    openNow: true,
                    nextOpenAt: null,
                    categories: [],
                    whatsapp: { enabled: false },
                },
            },
        });

        expect(isOffline(offline)).toBe(true);
    });

    it("applies the host's category subset, keeping the server order, and ignores an empty subset", () => {
        expect(
            buildPanelConfig({
                boot: loaderBoot(),
                fresh: base(),
                overrides: { categories: ['tech'] },
            }).categories.map((c) => c.slug),
        ).toEqual(['tech']);
        expect(
            buildPanelConfig({
                boot: loaderBoot(),
                fresh: base(),
                overrides: { categories: ['tech', 'billing'] },
            }).categories.map((c) => c.slug),
        ).toEqual(['billing', 'tech']);
        expect(
            buildPanelConfig({
                boot: loaderBoot(),
                overrides: { categories: ['nope'] },
            }).categories,
        ).toHaveLength(2);
    });

    it('applies restricted overrides: texts, theme, sounds/titleBadge either way, other features only off', () => {
        const config = buildPanelConfig({
            boot: loaderBoot(),
            overrides: {
                texts: { en: { title: 'Acme' } },
                theme: { primary: '#112233', radius: 4 },
                features: {
                    sounds: false,
                    titleBadge: true,
                    attachments: false,
                    whatsapp: true,
                    preChat: true,
                },
            },
        });

        expect(config.texts.en.title).toBe('Acme');
        expect(config.texts.en.send).toBe('Send');
        expect(config.theme).toMatchObject({
            primary: '#112233',
            radius: 4,
            surface: '#ffffff',
        });
        expect(config.features).toMatchObject({
            sounds: false,
            titleBadge: true,
            attachments: false,
            whatsapp: false,
            preChat: true,
        });
    });

    it('rejects unsafe or malformed theme values instead of passing them to the DOM', () => {
        const theme = sanitizeTheme(
            {
                mode: 'rainbow',
                primary: 'red; background:url(javascript:alert(1))',
                primaryText: '#fff',
                accent: 'url(x)',
                fontFamily: 'Inter; } body { display:none',
                fontUrl: 'https://evil.test/font.css',
                radius: 9999,
                shadow: 'huge',
                panelWidth: 1,
                panelHeight: 99999,
            },
            APP,
        );

        expect(theme).toMatchObject({
            mode: 'auto',
            primary: DEFAULT_THEME.primary,
            primaryText: '#fff',
            accent: DEFAULT_THEME.accent,
            fontFamily: DEFAULT_THEME.fontFamily,
            fontUrl: null,
            radius: 28,
            shadow: 'soft',
            panelWidth: 280,
            panelHeight: 900,
        });
    });

    it('only allows web-font stylesheets from https on the known font hosts or this app', () => {
        const url = (value: string) =>
            sanitizeTheme({ fontUrl: value }, APP).fontUrl;

        expect(url('https://fonts.googleapis.com/css2?family=Inter')).toBe(
            'https://fonts.googleapis.com/css2?family=Inter',
        );
        expect(url('https://fonts.bunny.net/css?family=inter')).toContain(
            'fonts.bunny.net',
        );
        expect(url('/fonts/brand.css')).toBe(`${APP}/fonts/brand.css`);
        expect(url('http://fonts.googleapis.com/css')).toBeNull();
        expect(url('https://fonts.googleapis.com.evil.test/css')).toBeNull();
        expect(url('https://user:pw@fonts.googleapis.com/css')).toBeNull();
        expect(url('javascript:alert(1)')).toBeNull();
        expect(url('')).toBeNull();
    });

    it('whatsapp is offered only when the widget feature AND availability agree', () => {
        const on = (features: boolean, availability: boolean) =>
            buildPanelConfig({
                boot: loaderBoot({
                    config: {
                        ...(base().config as object),
                        features: {
                            ...(base().config as { features: object }).features,
                            whatsapp: features,
                        },
                    },
                    availability: {
                        online: true,
                        openNow: true,
                        nextOpenAt: null,
                        categories: [],
                        whatsapp: { enabled: availability },
                    },
                }),
            }).features.whatsapp;

        expect(on(true, true)).toBe(true);
        expect(on(true, false)).toBe(false);
        expect(on(false, true)).toBe(false);
    });

    it('applies a builder draft over the published config', () => {
        const config = buildPanelConfig({
            boot: loaderBoot(),
            draft: {
                theme: { ...DEFAULT_THEME, primary: '#ab12cd' },
                texts: { en: { title: 'Draft title' } },
                features: {
                    ...(base().config as { features: object }).features,
                    rating: false,
                },
                routing: { queueTimeoutSeconds: 90 },
            },
        });

        expect(config.theme.primary).toBe('#ab12cd');
        expect(config.texts.en.title).toBe('Draft title');
        expect(config.features.rating).toBe(false);
    });

    it('reads pre-chat rules: required needs enabled, consent text counts as a reason to show the form', () => {
        const boot = (preChat: unknown, preChatFeature = true) =>
            buildPanelConfig({
                boot: loaderBoot({
                    config: {
                        ...(base().config as object),
                        features: {
                            ...(base().config as { features: object }).features,
                            preChat: preChatFeature,
                        },
                        preChat,
                    },
                }),
            });
        const none = {
            fields: {
                name: { enabled: false, required: true },
                email: { enabled: false, required: false },
                phone: { enabled: false, required: false },
            },
            consentText: null,
        };

        expect(boot(none).preChat.fields.name).toEqual({
            enabled: false,
            required: false,
        });
        expect(needsPreChat(boot(none))).toBe(false);
        expect(needsPreChat(boot({ ...none, consentText: 'I agree' }))).toBe(
            true,
        );
        expect(needsPreChat(boot(none, false))).toBe(false);
        expect(
            needsPreChat(boot({ ...none, consentText: 'I agree' }, false)),
        ).toBe(false);
        expect(
            needsPreChat(
                boot({
                    ...none,
                    fields: {
                        ...none.fields,
                        phone: { enabled: true, required: true },
                    },
                }),
            ),
        ).toBe(true);
    });

    it('answers per-topic availability, defaulting to online when unknown', () => {
        const config = buildPanelConfig({
            boot: loaderBoot({
                availability: {
                    online: true,
                    openNow: true,
                    nextOpenAt: null,
                    categories: [{ slug: 'billing', online: false }],
                    whatsapp: { enabled: false },
                },
            }),
        });

        expect(categoryOnline(config, 'billing')).toBe(false);
        expect(categoryOnline(config, 'tech')).toBe(true);
    });
});

describe('locale', () => {
    const texts = {
        en: { title: 'Support' },
        ar: { title: 'الدعم' },
        'pt-BR': { title: 'Suporte' },
    };

    it('uses the explicit override, then the browser language the widget has texts for, then the default', () => {
        const pick = (input: Partial<Parameters<typeof pickLocale>[0]>) =>
            pickLocale({
                texts,
                defaultLocale: 'en',
                detect: true,
                navigatorLanguages: [],
                ...input,
            });

        expect(pick({ override: 'ar' })).toEqual({
            locale: 'ar',
            textLocale: 'ar',
        });
        expect(pick({ navigatorLanguages: ['fr-FR', 'ar-SA'] })).toEqual({
            locale: 'ar-SA',
            textLocale: 'ar',
        });
        expect(pick({ navigatorLanguages: ['pt-PT'] })).toEqual({
            locale: 'pt-PT',
            textLocale: 'pt-BR',
        });
        expect(pick({ navigatorLanguages: ['de-DE'] })).toEqual({
            locale: 'en',
            textLocale: 'en',
        });
        expect(pick({ navigatorLanguages: ['ar'], detect: false })).toEqual({
            locale: 'en',
            textLocale: 'en',
        });
        expect(pick({ override: 'de' })).toEqual({
            locale: 'de',
            textLocale: 'en',
        });
    });

    it('sets the direction from the texts actually shown', () => {
        const rtl = buildPanelConfig({
            boot: loaderBoot({
                config: {
                    ...(base().config as object),
                    texts: { en: { title: 'Support' }, ar: { title: 'الدعم' } },
                },
            }),
            overrides: { locale: 'ar' },
        });

        expect(rtl).toMatchObject({ textLocale: 'ar', dir: 'rtl' });

        // a locale override without texts for it keeps the English chrome and direction
        expect(
            buildPanelConfig({
                boot: loaderBoot(),
                overrides: { locale: 'ar' },
            }),
        ).toMatchObject({ textLocale: 'en', dir: 'ltr' });
    });
});
