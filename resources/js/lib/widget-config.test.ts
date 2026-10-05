import { describe, expect, it } from 'vite-plus/test';
import { LIMITS } from '@/lib/limits';
import {
    buildPreviewBoot,
    categoryLabel,
    clamp,
    clampToRange,
    configLocales,
    contrastGrade,
    contrastRatio,
    DEFAULT_TEXTS_EN,
    defaultWidgetConfig,
    formatRatio,
    isAllowedFontUrl,
    isHexColor,
    isIsoDate,
    isLocaleCode,
    isSecureUrl,
    isTime,
    normaliseDomainEntry,
    parseBounded,
    parseHexColor,
    readableTextOn,
    resolveText,
    TEXT_KEYS,
    timeToMinutes,
    toClientConfig,
    toColorInputValue,
    weekdayName,
    WEEK_ORDER,
    withConfigDefaults,
    withPreviewFlag,
} from '@/lib/widget-config';
import { makeCategory } from '@/tests/fixtures';

describe('defaults (docs/contracts/widget-config.md)', () => {
    const config = defaultWidgetConfig();

    it('starts from the contract values', () => {
        expect(config.v).toBe(1);
        expect(config.defaultLocale).toBe('en');
        expect(config.localeDetect).toBe(true);
        expect(config.theme).toMatchObject({
            mode: 'auto',
            primary: '#0f766e',
            primaryText: '#ffffff',
            accent: '#D97706',
            surface: '#ffffff',
            text: '#0f172a',
            radius: 16,
            shadow: 'soft',
            launcherSize: 'md',
            panelWidth: 380,
            panelHeight: 620,
            position: 'bottom-right',
            offsetX: 20,
            offsetY: 20,
            zIndex: 2147483000,
        });
        expect(config.launcher).toMatchObject({
            style: 'bubble',
            icon: 'chat',
            label: 'Chat with us',
        });
        expect(config.greetings).toEqual({
            enabled: true,
            onPageLoad: true,
            delaySeconds: 3,
            intervalMinutes: 30,
            autoHideSeconds: 180,
            dismissPolicy: 'session',
            showAgent: true,
        });
        expect(config.preChat.fields).toEqual({
            name: { enabled: true, required: true },
            email: { enabled: true, required: false },
            phone: { enabled: false, required: false },
        });
        expect(config.session.idleTimeoutMinutes).toBe(120);
        expect(config.routing.queueTimeoutSeconds).toBe(90);
        expect(config.features.whatsapp).toBe(false);
    });

    it('ships every text key in English', () => {
        expect(Object.keys(config.texts.en).sort()).toEqual(
            [...TEXT_KEYS].sort(),
        );
        expect(TEXT_KEYS).toHaveLength(20);
        expect(Object.keys(DEFAULT_TEXTS_EN)).toHaveLength(TEXT_KEYS.length);
    });

    it('returns a fresh object each time', () => {
        const a = defaultWidgetConfig();
        const b = defaultWidgetConfig();

        a.theme.primary = '#000000';
        a.texts.en.title = 'Changed';

        expect(b.theme.primary).toBe('#0f766e');
        expect(b.texts.en.title).toBe('Support');
    });

    it('ships a Monday to Friday 09:00-17:00 schedule', () => {
        expect(config.hours.schedule.map((range) => range.day)).toEqual([
            1, 2, 3, 4, 5,
        ]);
        expect(
            config.hours.schedule.every(
                (r) => r.start === '09:00' && r.end === '17:00',
            ),
        ).toBe(true);
    });
});

describe('withConfigDefaults', () => {
    it('fills sections the server left out', () => {
        const merged = withConfigDefaults({
            theme: { primary: '#112233' },
        } as never);

        expect(merged.theme.primary).toBe('#112233');
        expect(merged.theme.radius).toBe(16);
        expect(merged.features.attachments).toBe(true);
    });

    it('replaces arrays instead of merging them', () => {
        const merged = withConfigDefaults({
            hours: { schedule: [{ day: 6, start: '10:00', end: '12:00' }] },
        } as never);

        expect(merged.hours.schedule).toEqual([
            { day: 6, start: '10:00', end: '12:00' },
        ]);
    });

    it('keeps the texts exactly as stored (never mixes English into other locales)', () => {
        const merged = withConfigDefaults({
            texts: { ar: { title: 'الدعم' } },
        } as never);

        expect(merged.texts).toEqual({ ar: { title: 'الدعم' } });
    });

    it('accepts null / undefined', () => {
        expect(withConfigDefaults(null)).toEqual(defaultWidgetConfig());
        expect(withConfigDefaults(undefined)).toEqual(defaultWidgetConfig());
    });
});

describe('numbers', () => {
    it('clamps into range and turns NaN into the minimum', () => {
        expect(clamp(50, 0, 28)).toBe(28);
        expect(clamp(-3, 0, 28)).toBe(0);
        expect(clamp(10, 0, 28)).toBe(10);
        expect(clamp(Number.NaN, 5, 9)).toBe(5);
        expect(clampToRange(3.6, LIMITS.radius)).toBe(4);
        expect(clampToRange(99999, LIMITS.idleTimeoutMinutes)).toBe(10080);
    });

    it('uses the contract ranges', () => {
        expect(LIMITS.idleTimeoutMinutes).toEqual({ min: 5, max: 10080 });
        expect(LIMITS.queueTimeoutSeconds).toEqual({ min: 15, max: 600 });
        expect(LIMITS.radius).toEqual({ min: 0, max: 28 });
        expect(LIMITS.greetingWeight).toEqual({ min: 1, max: 100 });
        expect(LIMITS.greetingBodyLength).toBe(2000);
    });

    it('parses only whole numbers inside the range', () => {
        const range = LIMITS.idleTimeoutMinutes;

        expect(parseBounded('120', range)).toBe(120);
        expect(parseBounded(' 5 ', range)).toBe(5);
        expect(parseBounded('4', range)).toBeNull();
        expect(parseBounded('10081', range)).toBeNull();
        expect(parseBounded('12.5', range)).toBeNull();
        expect(parseBounded('', range)).toBeNull();
        expect(parseBounded('abc', range)).toBeNull();
        expect(parseBounded(30, range)).toBe(30);
    });
});

describe('colors', () => {
    it('accepts 3, 6 and 8 digit hex only', () => {
        for (const ok of ['#fff', '#0F766E', '#0f766e80', ' #abc ']) {
            expect(isHexColor(ok)).toBe(true);
        }

        for (const bad of [
            'fff',
            '#ffff',
            '#12345',
            'rgb(0,0,0)',
            'red',
            '#ggg',
            '',
        ]) {
            expect(isHexColor(bad)).toBe(false);
        }
    });

    it('parses channels and alpha', () => {
        expect(parseHexColor('#fff')).toEqual({ r: 255, g: 255, b: 255, a: 1 });
        expect(parseHexColor('#0f766e')).toEqual({
            r: 15,
            g: 118,
            b: 110,
            a: 1,
        });
        expect(parseHexColor('#00000080')?.a).toBeCloseTo(0.5, 1);
        expect(parseHexColor('nope')).toBeNull();
    });

    it('feeds <input type="color"> a #rrggbb value', () => {
        expect(toColorInputValue('#abc')).toBe('#aabbcc');
        expect(toColorInputValue('#0f766e80')).toBe('#0f766e');
        expect(toColorInputValue('wrong', '#123456')).toBe('#123456');
    });

    it('computes WCAG contrast ratios', () => {
        expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
        expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
        // The classic "lightest grey that passes AA on white".
        expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.54, 2);
        expect(contrastRatio('#ffffff', '#767676')).toBeCloseTo(4.54, 2);
        expect(contrastRatio('nope', '#fff')).toBeNull();
    });

    it('grades contrast and never rounds a failure up', () => {
        expect(contrastGrade(21)).toBe('aaa');
        expect(contrastGrade(7)).toBe('aaa');
        expect(contrastGrade(4.5)).toBe('aa');
        expect(contrastGrade(3.2)).toBe('large');
        expect(contrastGrade(2.99)).toBe('fail');
        expect(formatRatio(4.499)).toBe('4.4:1');
        expect(formatRatio(21)).toBe('21.0:1');
    });

    it('picks readable text for a background', () => {
        expect(readableTextOn('#0f766e')).toBe('#ffffff');
        expect(readableTextOn('#000000')).toBe('#ffffff');
        expect(readableTextOn('#fde68a')).toBe('#0f172a');
        expect(readableTextOn('#ffffff')).toBe('#0f172a');
    });
});

describe('urls', () => {
    it('only allows https or same-origin relative URLs', () => {
        expect(isSecureUrl('https://cdn.example.com/a.png')).toBe(true);
        expect(isSecureUrl('/assets/a.png')).toBe(true);
        expect(isSecureUrl('http://example.com/a.png')).toBe(false);
        expect(isSecureUrl('//evil.example/a.png')).toBe(false);
        expect(isSecureUrl('javascript:alert(1)')).toBe(false);
        expect(isSecureUrl('data:image/png;base64,AAAA')).toBe(false);
        expect(isSecureUrl('not a url')).toBe(false);
    });

    it('limits font stylesheets to the allowed hosts and the own origin', () => {
        const own = 'https://chat.example.test';

        expect(
            isAllowedFontUrl(
                'https://fonts.googleapis.com/css2?family=Inter',
                own,
            ),
        ).toBe(true);
        expect(
            isAllowedFontUrl('https://fonts.bunny.net/css?family=inter', own),
        ).toBe(true);
        expect(
            isAllowedFontUrl('https://chat.example.test/fonts/x.css', own),
        ).toBe(true);
        expect(isAllowedFontUrl('/fonts/x.css', own)).toBe(true);
        expect(isAllowedFontUrl('https://evil.example/x.css', own)).toBe(false);
        expect(isAllowedFontUrl('http://fonts.googleapis.com/css', own)).toBe(
            false,
        );
        expect(isAllowedFontUrl('//fonts.googleapis.com/css', own)).toBe(false);
    });
});

describe('domain entries', () => {
    const ok = (input: string) => {
        const result = normaliseDomainEntry(input);

        return result.ok ? result.value : `error:${result.reason}`;
    };

    it('lower-cases and keeps host, wildcard and port', () => {
        expect(ok('Example.COM')).toBe('example.com');
        expect(ok('  shop.example.com  ')).toBe('shop.example.com');
        expect(ok('*.Example.com')).toBe('*.example.com');
        expect(ok('localhost:5173')).toBe('localhost:5173');
        expect(ok('*.example.com:8443')).toBe('*.example.com:8443');
    });

    it('converts internationalised names to punycode', () => {
        expect(ok('münchen.de')).toBe('xn--mnchen-3ya.de');
    });

    it('drops an https:// prefix (the default) and keeps http:// (a site served without https)', () => {
        expect(ok('https://Example.com')).toBe('example.com');
        expect(ok('https://*.example.com:8443')).toBe('*.example.com:8443');
        expect(ok('http://Legacy.Example.org')).toBe(
            'http://legacy.example.org',
        );
        expect(ok('HTTP://*.example.org:8080')).toBe(
            'http://*.example.org:8080',
        );
        expect(ok('http://example.com/path')).toBe('error:path');
        expect(ok('http://user@example.com')).toBe('error:userinfo');
        expect(ok('http://')).toBe('error:invalid');
    });

    it('rejects other schemes, userinfo, paths and bad wildcards', () => {
        expect(ok('')).toBe('error:empty');
        expect(ok('ftp://example.com')).toBe('error:scheme');
        expect(ok('http://https://example.com')).toBe('error:scheme');
        expect(ok('user:pass@example.com')).toBe('error:userinfo');
        expect(ok('example.com/path')).toBe('error:path');
        expect(ok('example.com?x=1')).toBe('error:path');
        expect(ok('example.com#top')).toBe('error:path');
        expect(ok('shop.*.example.com')).toBe('error:wildcard');
        expect(ok('*example.com')).toBe('error:wildcard');
        expect(ok('*.com')).toBe('error:wildcard');
    });

    it('validates ports and host labels', () => {
        expect(ok('example.com:0')).toBe('error:port');
        expect(ok('example.com:70000')).toBe('error:port');
        expect(ok('example.com:80:90')).toBe('error:port');
        expect(ok('exa mple.com')).toBe('error:invalid');
        expect(ok('-bad.example.com')).toBe('error:invalid');
        expect(ok(':8080')).toBe('error:invalid');
    });
});

describe('times, dates, weekdays', () => {
    it('validates HH:MM', () => {
        expect(isTime('09:00')).toBe(true);
        expect(isTime('23:59')).toBe(true);
        expect(isTime('24:00')).toBe(false);
        expect(isTime('9:00')).toBe(false);
        expect(isTime('09:60')).toBe(false);
        expect(timeToMinutes('17:30')).toBe(1050);
    });

    it('validates calendar dates', () => {
        expect(isIsoDate('2026-12-25')).toBe(true);
        expect(isIsoDate('2028-02-29')).toBe(true);
        expect(isIsoDate('2027-02-29')).toBe(false);
        expect(isIsoDate('2026-13-01')).toBe(false);
        expect(isIsoDate('25/12/2026')).toBe(false);
        expect(isIsoDate('')).toBe(false);
    });

    it('lists Monday first, Sunday last, and names days per locale', () => {
        expect([...WEEK_ORDER]).toEqual([1, 2, 3, 4, 5, 6, 0]);
        expect(weekdayName(0, 'en')).toBe('Sunday');
        expect(weekdayName(1, 'en')).toBe('Monday');
        expect(weekdayName(6, 'en', 'short')).toBe('Sat');
        expect(weekdayName(1, 'de')).toBe('Montag');
        expect(weekdayName(2, 'zz-not-a-locale')).toBeTruthy();
    });
});

describe('locales and texts', () => {
    it('recognises language codes', () => {
        for (const ok of ['en', 'ar', 'pt-BR', 'zh-Hant', 'fil']) {
            expect(isLocaleCode(ok)).toBe(true);
        }

        for (const bad of ['', 'e', 'english', 'en_US', 'EN', 'en-', '12']) {
            expect(isLocaleCode(bad)).toBe(false);
        }
    });

    it('lists the default locale first and the rest alphabetically', () => {
        expect(
            configLocales({
                defaultLocale: 'en',
                texts: { fr: {}, ar: {}, en: {} },
            }),
        ).toEqual(['en', 'ar', 'fr']);
        expect(
            configLocales({ defaultLocale: 'de', texts: { en: {}, ar: {} } }),
        ).toEqual(['de', 'ar', 'en']);
    });

    it('resolves a text like the widget: locale, default locale, built-in English', () => {
        const config = {
            defaultLocale: 'en',
            texts: {
                en: { title: 'Help' },
                ar: { title: 'مساعدة', send: '' },
            },
        };

        expect(resolveText(config, 'ar', 'title')).toBe('مساعدة');
        expect(resolveText(config, 'ar', 'send')).toBe(DEFAULT_TEXTS_EN.send);
        expect(resolveText(config, 'fr', 'title')).toBe('Help');
        expect(resolveText(config, 'fr', 'thanks')).toBe(
            DEFAULT_TEXTS_EN.thanks,
        );
    });

    it('picks the per-locale category name and falls back to the base name', () => {
        const category = makeCategory({
            name: 'Billing',
            name_i18n: { ar: 'الفواتير', 'pt-BR': 'Cobrança' },
        });

        expect(categoryLabel(category, 'ar')).toBe('الفواتير');
        expect(categoryLabel(category, 'pt-BR')).toBe('Cobrança');
        expect(categoryLabel(category, 'pt_BR')).toBe('Cobrança');
        expect(categoryLabel(category, 'fr')).toBe('Billing');
        expect(
            categoryLabel(makeCategory({ name_i18n: { ar: 'x' } }), 'ar-EG'),
        ).toBe('x');
    });
});

describe('boot config for the preview', () => {
    const base = {
        key: 'wk_abc',
        configVersion: 7,
        config: defaultWidgetConfig(),
        greetings: [
            {
                id: 'g1',
                body: 'Hello',
                agent_name: 'Sara',
                agent_avatar_url: null,
                locale: null,
                weight: 2,
                is_active: true,
            },
            {
                id: 'g2',
                body: 'Hidden',
                agent_name: null,
                agent_avatar_url: null,
                locale: 'ar',
                weight: 1,
                is_active: false,
            },
            {
                id: 'g3',
                body: '   ',
                agent_name: null,
                agent_avatar_url: null,
                locale: null,
                weight: 1,
                is_active: true,
            },
        ],
        categories: [{ slug: 'sales', label: 'Sales' }],
        preview: {
            embed_url: 'https://chat.example.test/embed/wk_abc',
            app_origin: 'https://chat.example.test',
        },
        now: new Date('2026-09-30T12:00:00Z'),
    };

    it('builds the resolved boot config of the contract', () => {
        const boot = buildPreviewBoot(base);

        expect(boot).toMatchObject({
            v: 1,
            key: 'wk_abc',
            configVersion: 7,
            generatedAt: '2026-09-30T12:00:00.000Z',
            api: {
                base: 'https://chat.example.test/api/v1/public',
                appOrigin: 'https://chat.example.test',
            },
            categories: [{ slug: 'sales', label: 'Sales' }],
            availability: {
                online: true,
                openNow: true,
                nextOpenAt: null,
                whatsapp: { enabled: false },
            },
        });
    });

    it('always asks the embed iframe for preview mode', () => {
        expect(buildPreviewBoot(base).api.embed).toBe(
            'https://chat.example.test/embed/wk_abc?preview=1',
        );
        expect(
            withPreviewFlag('/embed/wk_abc?mode=inline', 'https://x.test'),
        ).toBe('https://x.test/embed/wk_abc?mode=inline&preview=1');
        expect(
            withPreviewFlag(
                'https://x.test/embed/wk?preview=0',
                'https://x.test',
            ),
        ).toBe('https://x.test/embed/wk?preview=1');
    });

    it('keeps server-only policy out of the client config', () => {
        const boot = buildPreviewBoot(base);

        expect(boot.config).not.toHaveProperty('routing');
        expect(boot.config).not.toHaveProperty('session');
        expect(boot.config.theme.primary).toBe('#0f766e');
        expect(toClientConfig(defaultWidgetConfig())).not.toHaveProperty(
            'routing',
        );
    });

    it('sends only usable greetings, in the loader shape', () => {
        expect(buildPreviewBoot(base).greetings).toEqual([
            {
                id: 'g1',
                body: 'Hello',
                agentName: 'Sara',
                agentAvatarUrl: null,
                locale: null,
                weight: 2,
            },
        ]);
    });

    it('reports WhatsApp as enabled only when the draft turns the feature on', () => {
        const config = defaultWidgetConfig();

        config.features.whatsapp = true;

        expect(
            buildPreviewBoot({ ...base, config }).availability.whatsapp.enabled,
        ).toBe(true);
    });
});
