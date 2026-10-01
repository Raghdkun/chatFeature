import { describe, expect, it } from 'vitest';
import {
    DEFAULTS,
    parseBoot,
    parseDataAttrs,
    resolve,
    safeUrl,
    sanitizeBase,
    sanitizeOverrides,
    sanitizeToken,
} from '../src/config';
import type { Ctx } from '../src/config';
import type { Boot, Overrides } from '../src/types';
import { clean, deepMerge, fingerprint } from '../src/util';
import { APP, KEY, makeBoot, makeBootCfg } from './helpers';

const ctx: Ctx = { base: 'https://customer.example/page', appOrigin: APP };
type Dict = Record<string, unknown>;

const boot = (cfg: Dict = {}) => {
    const b = parseBoot(makeBootCfg(cfg), KEY);

    if (b === null) {
        throw new Error('fixture boot rejected');
    }

    return b;
};

/** Dashboard config -> effective config with the given client layers merged in documented order. */
const effective = (
    cfg: Dict,
    ...layers: unknown[]
): ReturnType<typeof resolve> => {
    const merged = layers
        .map((l) => sanitizeOverrides(l, ctx))
        .reduce<Overrides>((a, b) => deepMerge(a, b), {});

    return resolve(boot(cfg), merged, ['en-US']);
};

describe('safeUrl', () => {
    it.each([
        ['https://cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
        ['/img/a.png', 'https://customer.example/img/a.png'],
        ['http://localhost:8205/a.png', 'http://localhost:8205/a.png'],
        ['http://127.0.0.1/a.png', 'http://127.0.0.1/a.png'],
        ['http://chat.test/a.png', 'http://chat.test/a.png'],
        [
            'http://chat.localhost:8000/a.png',
            'http://chat.localhost:8000/a.png',
        ],
        ['http://app.pne.test/a.png', 'http://app.pne.test/a.png'],
        ['//cdn.example.com/a.png', 'https://cdn.example.com/a.png'],
    ])('accepts %s', (input, out) => {
        expect(safeUrl(input, 'https://customer.example/page')).toBe(out);
    });

    it.each([
        'javascript:alert(1)',
        'data:text/html,<script>alert(1)</script>',
        'http://evil.example/a.png',
        'http://test.example/a.png',
        'http://evil.test.example/a.png',
        'http://localhost.evil.example/a.png',
        'ftp://x.example/a',
        'https://user:pass@evil.example/a.png',
        'blob:https://x.example/1',
        '',
        `https://x.example/${'a'.repeat(3000)}`,
    ])('rejects %j', (input) => {
        expect(safeUrl(input, 'https://customer.example/page')).toBeUndefined();
    });

    it.each([42, null, undefined, {}, ['https://x.example']])(
        'rejects non-strings (%j)',
        (v) => {
            expect(safeUrl(v, 'https://customer.example/')).toBeUndefined();
        },
    );
});

describe('sanitizeOverrides: validation', () => {
    it('keeps valid values and drops invalid ones field by field', () => {
        const o = sanitizeOverrides(
            {
                theme: {
                    primary: '#abc',
                    accent: 'red',
                    surface: '#12345678',
                    text: 'url(javascript:alert(1))',
                    radius: 999,
                    offsetX: -50,
                    zIndex: '2147483647',
                    mode: 'dark',
                    shadow: 'huge',
                    position: 'left',
                    fontFamily: 'Georgia, "Times New Roman", serif',
                },
            },
            ctx,
        );

        expect(o.theme).toEqual({
            primary: '#abc',
            surface: '#12345678',
            radius: 28,
            offsetX: 0,
            zIndex: 2147483647,
            mode: 'dark',
            position: 'bottom-left',
            fontFamily: 'Georgia, "Times New Roman", serif',
        });
    });

    it.each([
        ['#12', false],
        ['#1234', false],
        ['#12345', false],
        ['#fff', true],
        ['#ffffff', true],
        ['#ffffffaa', true],
        ['ffffff', false],
        ['#ggg', false],
        ['#fff; background:url(//evil)', false],
        ['#fff"><script>', false],
    ])('colour %j valid=%s', (value, ok) => {
        const o = sanitizeOverrides({ theme: { primary: value } }, ctx);
        expect(o.theme?.primary !== undefined).toBe(ok);
    });

    it.each([
        ['Inter, system-ui, sans-serif', true],
        ["'Open Sans', sans-serif", true],
        ['x; background: url(//evil.example)', false],
        ['x}</style><script>alert(1)</script>', false],
        ['url(//evil)', false],
        ['a'.repeat(300), false],
    ])('fontFamily %j valid=%s', (value, ok) => {
        const o = sanitizeOverrides({ theme: { fontFamily: value } }, ctx);
        expect(o.theme?.fontFamily !== undefined).toBe(ok);
    });

    it.each([
        ['https://fonts.googleapis.com/css2?family=Inter', true],
        ['https://fonts.bunny.net/css?family=inter', true],
        [`${APP}/fonts/brand.css`, true],
        ['https://evil.example/fonts.css', false],
        ['https://fonts.googleapis.com.evil.example/css', false],
        ['http://fonts.googleapis.com/css', false],
        ['/local.css', false],
    ])('fontUrl %j allowed=%s', (value, ok) => {
        const o = sanitizeOverrides({ theme: { fontUrl: value } }, ctx);
        expect(o.theme?.fontUrl !== undefined).toBe(ok);
    });

    it('clamps numbers and rejects NaN, Infinity and non-numeric strings', () => {
        const o = sanitizeOverrides(
            {
                theme: { panelWidth: 99999, panelHeight: 1, offsetY: Infinity },
                greetings: {
                    delaySeconds: 'abc',
                    intervalMinutes: -5,
                    autoHideSeconds: NaN,
                },
            },
            ctx,
        );

        expect(o.theme).toEqual({ panelWidth: 640, panelHeight: 360 });
        expect(o.greetings).toEqual({ intervalMinutes: 0 });
    });

    it('strips control and bidi characters, trims and caps free text', () => {
        const o = sanitizeOverrides(
            {
                launcher: { label: '  Hel\u0000lo\n\u202e there  ' },
                texts: { en: { title: 'x'.repeat(900) } },
            },
            ctx,
        );

        expect(o.launcher?.label).toBe('Hel lo  there');
        expect(o.texts?.en.title).toHaveLength(500);
    });

    it('removes every bidirectional override and isolate, however it is spelled', () => {
        const bidi = '\u202a\u202b\u202c\u202d\u202e\u2066\u2067\u2068\u2069';

        expect(clean(`a${bidi}b`, 50)).toBe('ab');
        expect(clean(`${bidi}`, 50)).toBeUndefined();
        expect(
            sanitizeOverrides({ visitor: { name: `Ann${bidi}` } }, ctx).visitor,
        ).toEqual({ name: 'Ann' });
    });

    it('keeps line breaks only for message bodies', () => {
        expect(clean('a\r\nb\nc\td', 50)).toBe('a b c d');
        expect(clean('  a\r\nb\n\nc\u0000d  ', 50, true)).toBe('a\nb\n\nc d');
        expect(clean('x\ny\nz', 3, true)).toBe('x\ny');

        const b = parseBoot(
            makeBoot({
                greetings: [{ id: 'g', body: 'Hi!\nNeed help?\u202e' }],
            }),
            KEY,
        );
        expect(b?.greetings[0].body).toBe('Hi!\nNeed help?');
    });

    it('accepts https image URLs only', () => {
        const o = sanitizeOverrides(
            {
                launcher: {
                    iconUrl: 'javascript:alert(1)',
                    avatarUrl: 'https://cdn.example.com/a.png',
                },
            },
            ctx,
        );

        expect(o.launcher).toEqual({
            avatarUrl: 'https://cdn.example.com/a.png',
        });
    });

    it('sanitises visitor fields, meta and identity token', () => {
        const o = sanitizeOverrides(
            {
                visitor: {
                    name: ' Ann ',
                    email: 'ann@example.com',
                    phone: 5,
                    meta: {
                        plan: 'pro',
                        seats: 3,
                        ok: true,
                        'bad key!': 'x',
                        nested: { a: 1 },
                        fn: () => 1,
                    },
                },
                identityToken: 'aaa.bbb.ccc',
            },
            ctx,
        );

        expect(o.visitor).toEqual({
            name: 'Ann',
            email: 'ann@example.com',
            meta: { plan: 'pro', seats: 3, ok: true },
        });
        expect(o.identityToken).toBe('aaa.bbb.ccc');
        expect(sanitizeToken('not a jwt')).toBeUndefined();
        expect(sanitizeToken('a.b')).toBeUndefined();
    });

    it("keeps visitor fields inside the server's limits: a field POST /sessions would refuse is dropped, never sent", () => {
        const visitor = (v: Record<string, unknown>) =>
            sanitizeOverrides({ visitor: v }, ctx).visitor;

        expect(visitor({ name: 'n'.repeat(500) })).toEqual({
            name: 'n'.repeat(120),
        });
        expect(
            visitor({ email: 'not an email', phone: 'call me' }),
        ).toBeUndefined();
        expect(
            visitor({ email: `${'a'.repeat(190)}@x.io`, name: 'Ann' }),
        ).toEqual({
            name: 'Ann',
        });
        expect(
            visitor({ email: 'ann@example.com', phone: '+1 (555) 010-9999' }),
        ).toEqual({
            email: 'ann@example.com',
            phone: '+1 (555) 010-9999',
        });
        expect(visitor({ phone: '12' })).toBeUndefined();
        expect(visitor({ phone: '1'.repeat(41) })).toBeUndefined();
    });

    it('filters visitor meta keys before capping them, so valid keys are never crowded out', () => {
        const meta: Record<string, unknown> = {};

        for (let i = 0; i < 40; i++) {
            meta[`bad key ${i}!`] = 'x';
        }

        for (let i = 0; i < 30; i++) {
            meta[`ok${i}`] = i;
        }

        const kept = sanitizeOverrides({ visitor: { meta } }, ctx).visitor
            ?.meta;
        expect(Object.keys(kept ?? {})).toHaveLength(20);
        expect(Object.keys(kept ?? {})[0]).toBe('ok0');
    });

    it('replaces visitor meta as a whole instead of merging it', () => {
        expect(
            deepMerge(
                { visitor: { name: 'A', meta: { plan: 'pro', secret: 'x' } } },
                { visitor: { meta: { plan: 'free' } } },
            ),
        ).toEqual({ visitor: { name: 'A', meta: { plan: 'free' } } });
    });

    it('caps the number of categories', () => {
        const slugs = Array.from({ length: 200 }, (_, i) => `c${i}`);
        expect(
            sanitizeOverrides({ categories: slugs }, ctx).categories,
        ).toHaveLength(50);
        expect(
            sanitizeOverrides({ categories: slugs.join(',') }, ctx).categories,
        ).toHaveLength(50);
        expect(
            sanitizeOverrides(
                { categories: `${'x'.repeat(10_000)},${slugs[0]}` },
                ctx,
            ).categories,
        ).toBeUndefined(); // the string is cut before it is split
    });

    it('accepts exposeMessageContent only as a boolean', () => {
        expect(
            sanitizeOverrides({ exposeMessageContent: true }, ctx)
                .exposeMessageContent,
        ).toBe(true);
        expect(sanitizeOverrides({ exposeMessageContent: 'yes' }, ctx)).toEqual(
            {},
        );
    });

    it('parses category lists from arrays and comma separated strings', () => {
        expect(
            sanitizeOverrides({ categories: ' billing , sales,,<b> ' }, ctx)
                .categories,
        ).toEqual(['billing', 'sales']);
        expect(
            sanitizeOverrides({ categories: ['tech', 3, '../x'] }, ctx)
                .categories,
        ).toEqual(['tech']);
        expect(sanitizeOverrides({ categories: [] }, ctx).categories).toBe(
            undefined,
        );
    });

    it.each([null, undefined, 5, 'x', [], true])(
        'returns an empty object for non-object input (%j)',
        (v) => {
            expect(sanitizeOverrides(v, ctx)).toEqual({});
        },
    );

    it('ignores unknown and policy keys entirely', () => {
        const o = sanitizeOverrides(
            {
                domains: ['evil.example'],
                routing: { waves: [] },
                hours: { mode: 'always_online' },
                session: { idleTimeoutMinutes: 1 },
                theme: { onclick: 'x', primary: '#fff' },
                random: 1,
            },
            ctx,
        );

        expect(o).toEqual({ theme: { primary: '#fff' } });
    });

    it('is immune to prototype pollution payloads', () => {
        const payload = JSON.parse(
            '{"__proto__":{"polluted":true},"theme":{"__proto__":{"polluted":true},"primary":"#fff"},' +
                '"texts":{"__proto__":{"x":"y"},"constructor":{"prototype":{"polluted":"yes"}},"en":{"__proto__":"x","title":"ok"}}}',
        );
        const o = sanitizeOverrides(payload, ctx);

        expect(({} as Dict).polluted).toBeUndefined();
        expect(o.theme).toEqual({ primary: '#fff' });
        expect(o.texts).toEqual({ en: { title: 'ok' } });
        expect(
            deepMerge(
                {},
                JSON.parse('{"__proto__":{"polluted":true}}') as object,
            ),
        ).toBeDefined();
        expect(({} as Dict).polluted).toBeUndefined();
    });
});

describe('restriction rule: overrides restyle or restrict, never expand', () => {
    const disabled = {
        features: {
            attachments: false,
            rating: false,
            preChat: false,
            whatsapp: false,
            offlineForm: false,
            endChatByVisitor: false,
            poweredBy: false,
            sounds: false,
            titleBadge: false,
        },
    };

    it('cannot enable a feature the dashboard disabled', () => {
        const e = effective(
            disabled,
            {},
            {
                features: {
                    attachments: true,
                    rating: true,
                    preChat: true,
                    whatsapp: true,
                    offlineForm: true,
                    endChatByVisitor: true,
                    poweredBy: true,
                },
            },
        );

        expect(e.features).toMatchObject({
            attachments: false,
            rating: false,
            preChat: false,
            whatsapp: false,
            offlineForm: false,
            endChatByVisitor: false,
            poweredBy: false,
        });
    });

    it('can switch enabled features off', () => {
        const e = effective(
            {},
            {},
            {
                features: {
                    attachments: false,
                    rating: false,
                    poweredBy: false,
                },
            },
        );

        expect(e.features.attachments).toBe(false);
        expect(e.features.rating).toBe(false);
        expect(e.features.poweredBy).toBe(false);
        expect(e.features.preChat).toBe(true);
    });

    it('sounds and titleBadge are host-side preferences and may go either way', () => {
        expect(
            effective(disabled, {
                features: { sounds: true, titleBadge: true },
            }).features,
        ).toMatchObject({ sounds: true, titleBadge: true });
        expect(
            effective({}, { features: { sounds: false } }).features.sounds,
        ).toBe(false);
    });

    it('greeting switches may only be turned off, timings are free (clamped)', () => {
        const off = effective(
            {
                greetings: {
                    enabled: false,
                    onPageLoad: false,
                    showAgent: false,
                },
            },
            { greetings: { enabled: true, onPageLoad: true, showAgent: true } },
        );
        expect(off.greetings).toMatchObject({
            enabled: false,
            onPageLoad: false,
            showAgent: false,
        });

        const tuned = effective(
            {},
            {
                greetings: {
                    enabled: false,
                    delaySeconds: 99999,
                    dismissPolicy: 'never',
                    autoHideSeconds: 5,
                },
            },
        );
        expect(tuned.greetings).toMatchObject({
            enabled: false,
            delaySeconds: 3600,
            dismissPolicy: 'never',
            autoHideSeconds: 5,
        });
    });

    it('categories can only be narrowed to a subset of the enabled ones', () => {
        expect(
            effective({}, { categories: ['sales', 'billing'] }).categories.map(
                (c) => c.slug,
            ),
        ).toEqual(['billing', 'sales']);
        // unknown slugs cannot be added
        expect(
            effective(
                {},
                { categories: ['sales', 'admin', 'secret'] },
            ).categories.map((c) => c.slug),
        ).toEqual(['sales']);
        // nothing valid left: the override is ignored rather than hiding every category
        expect(
            effective({}, { categories: ['nope'] }).categories.map(
                (c) => c.slug,
            ),
        ).toEqual(['billing', 'sales', 'tech']);
    });

    it('policy fields in overrides are ignored (domains, routing, hours, session)', () => {
        const e = effective(
            {},
            {
                routing: { queueTimeoutSeconds: 1 },
                hours: { mode: 'always_online' },
                domains: ['x.example'],
                session: { idleTimeoutMinutes: 1 },
            },
        );

        expect(Object.keys(e)).not.toContain('routing');
        expect(JSON.stringify(e)).not.toContain('always_online');
    });

    it('a custom icon without a URL falls back to the chat icon', () => {
        expect(
            effective({}, { launcher: { icon: 'custom' } }).launcher.icon,
        ).toBe('chat');
        expect(
            effective(
                {},
                {
                    launcher: {
                        icon: 'custom',
                        iconUrl: 'https://cdn.example.com/i.svg',
                    },
                },
            ).launcher.icon,
        ).toBe('custom');
    });
});

describe('precedence: dashboard < data-* < init < update', () => {
    const dash = {
        theme: { primary: '#111111', radius: 4, accent: '#222222' },
    };

    it('later layers win key by key', () => {
        const e = effective(
            dash,
            { theme: { primary: '#aaaaaa', radius: 8, accent: '#bbbbbb' } }, // data
            { theme: { primary: '#cccccc', radius: 12 } }, // init
            { theme: { primary: '#dddddd' } }, // runtime update
        );

        expect(e.theme.primary).toBe('#dddddd');
        expect(e.theme.radius).toBe(12);
        expect(e.theme.accent).toBe('#bbbbbb');
    });

    it('untouched keys keep the dashboard value', () => {
        const e = effective(dash, { theme: { radius: 2 } });
        expect(e.theme.primary).toBe('#111111');
        expect(e.theme.radius).toBe(2);
    });

    it('an invalid higher layer value does not clobber a valid lower one', () => {
        const e = effective(
            dash,
            { theme: { primary: '#aaaaaa' } },
            { theme: { primary: 'not-a-colour' } },
        );
        expect(e.theme.primary).toBe('#aaaaaa');
    });

    it('texts merge per locale and per key', () => {
        const e = effective(
            { texts: { en: { title: 'Support', subtitle: 'Hi' } } },
            { texts: { en: { title: 'Help' } } },
        );
        expect(e.text('title', '')).toBe('Help');
        expect(e.text('subtitle', '')).toBe('Hi');
        expect(e.text('missing', 'fallback')).toBe('fallback');
    });
});

describe('locale resolution', () => {
    const r = (cfg: Dict, ov: Overrides, nav: string[]) =>
        resolve(boot(cfg), ov, nav);

    it('uses the browser locale when a texts block exists for it, else the default', () => {
        const cfg = {
            texts: { en: { title: 'Support' }, ar: { title: 'الدعم' } },
        };
        expect(r(cfg, {}, ['ar-SA']).textLocale).toBe('ar');
        expect(r(cfg, {}, ['ar-SA']).locale).toBe('ar-sa');
        expect(r(cfg, {}, ['fr-FR']).textLocale).toBe('en');
        expect(r(cfg, {}, ['fr-FR']).locale).toBe('en'); // no French texts: the default, not the browser's
    });

    it('looks further down the browser language list for one the widget has texts for', () => {
        const cfg = { texts: { en: { title: 'S' }, ar: { title: 'x' } } };
        expect(r(cfg, {}, ['fr-FR', 'ar-EG']).locale).toBe('ar-eg');
        expect(r(cfg, {}, ['fr-FR', 'de']).locale).toBe('en');
    });

    it('direction follows the texts actually shown: right-to-left chrome never wraps English strings', () => {
        // (the fixture ships Arabic texts too: drop them explicitly)
        const english = { texts: { en: { title: 'Support' }, ar: undefined } };
        const e = r(english, {}, ['ar-SA']);
        expect(e.dir).toBe('ltr');
        expect(e.locale).toBe('en');
        expect(e.text('title', '')).toBe('Support');
        // an explicit locale without texts of its own does not flip the direction either
        expect(r(english, { locale: 'ar' }, ['en']).dir).toBe('ltr');
        // with Arabic texts it does
        const both = { texts: { en: { title: 'S' }, ar: { title: 'ا' } } };
        expect(r(both, {}, ['ar-SA']).dir).toBe('rtl');
        expect(r(both, {}, ['en-US']).dir).toBe('ltr');
        // an Arabic default locale with Arabic texts is right-to-left for everyone
        expect(
            r(
                {
                    defaultLocale: 'ar',
                    localeDetect: false,
                    texts: { ar: { title: 'ا' } },
                },
                {},
                ['en'],
            ).dir,
        ).toBe('rtl');
    });

    it('localises the launcher label per locale, with the dashboard label for the default locale and client overrides on top', () => {
        const cfg = {
            launcher: { label: 'Talk to sales' },
            texts: {
                en: { launcherLabel: 'Chat with us' },
                ar: { launcherLabel: 'تحدث معنا' },
            },
        };
        expect(r(cfg, {}, ['en']).launcher.label).toBe('Talk to sales');
        expect(r(cfg, {}, ['ar']).launcher.label).toBe('تحدث معنا');
        expect(
            r(cfg, { launcher: { label: 'Hi' } }, ['ar']).launcher.label,
        ).toBe('Hi');
    });

    it('reads the closeChat / unread / dismiss texts and keeps the English fallbacks', () => {
        const cfg = {
            texts: {
                en: { title: 'S' },
                ar: {
                    closeChat: 'إغلاق',
                    unread: 'غير مقروءة',
                    dismiss: 'إخفاء',
                },
            },
        };
        const ar = r(cfg, { locale: 'ar' }, []);
        expect(ar.text('closeChat', 'Close chat')).toBe('إغلاق');
        expect(ar.text('unread', 'unread messages')).toBe('غير مقروءة');
        expect(ar.text('dismiss', 'Dismiss')).toBe('إخفاء');
        const en = r(cfg, {}, ['en']);
        expect(en.text('closeChat', 'Close chat')).toBe('Close chat');
        expect(en.text('unread', 'unread messages')).toBe('unread messages');
        expect(en.text('dismiss', 'Dismiss')).toBe('Dismiss');
    });

    it('localeDetect=false ignores the browser', () => {
        const cfg = {
            localeDetect: false,
            texts: { ar: { title: 'x' }, en: { title: 'y' } },
        };
        const e = r(cfg, {}, ['ar']);
        expect(e.locale).toBe('en');
        expect(e.text('title', '')).toBe('y');
    });

    it('an explicit locale override wins and drives direction', () => {
        const e = r({}, { locale: 'ar' }, ['en-US']);
        expect(e.locale).toBe('ar');
        expect(e.dir).toBe('rtl');
        expect(r({}, { locale: 'en' }, ['ar']).dir).toBe('ltr');
    });

    it.each([
        ['he', 'rtl'],
        ['fa', 'rtl'],
        ['ur', 'rtl'],
        ['fr', 'ltr'],
        ['zh-CN', 'ltr'],
    ])('%s is %s', (loc, dir) => {
        const texts = { [loc.toLowerCase()]: { title: 'x' } };
        expect(r({ texts }, { locale: loc }, []).dir).toBe(dir);
    });
});

describe('data-* attributes', () => {
    const script = (attrs: Record<string, string>): HTMLScriptElement => {
        const s = document.createElement('script');

        for (const k of Object.keys(attrs)) {
            s.setAttribute(k, attrs[k]);
        }

        return s;
    };

    it('maps every documented attribute to its override path', () => {
        const raw = parseDataAttrs(
            script({
                'data-widget-key': KEY,
                'data-position': 'left',
                'data-offset-x': '12',
                'data-offset-y': '30',
                'data-locale': 'ar',
                'data-theme-mode': 'dark',
                'data-theme-primary': '#112233',
                'data-theme-accent': '#445566',
                'data-theme-radius': '8',
                'data-launcher-style': 'pill',
                'data-launcher-label': 'Talk to us',
                'data-greetings': 'off',
                'data-open-on-load': 'true',
                'data-identity-token': 'a.b.c',
                'data-categories': 'billing,sales',
                'data-z-index': '999',
            }),
        );
        const o = sanitizeOverrides(raw, ctx);

        expect(o).toEqual({
            locale: 'ar',
            theme: {
                position: 'bottom-left',
                offsetX: 12,
                offsetY: 30,
                zIndex: 999,
                mode: 'dark',
                primary: '#112233',
                accent: '#445566',
                radius: 8,
            },
            launcher: { style: 'pill', label: 'Talk to us' },
            greetings: { enabled: false },
            openOnLoad: true,
            identityToken: 'a.b.c',
            categories: ['billing', 'sales'],
        });
    });

    it('rejects hostile attribute values after sanitising', () => {
        const o = sanitizeOverrides(
            parseDataAttrs(
                script({
                    'data-theme-primary': 'red;background:url(x)',
                    'data-launcher-style': '<img src=x onerror=alert(1)>',
                    'data-greetings': 'maybe',
                    'data-open-on-load': '1',
                    'data-offset-x': 'NaN',
                    'data-categories': '<script>',
                }),
            ),
            ctx,
        );

        expect(o).toEqual({});
    });

    it('handles a missing script tag', () => {
        expect(parseDataAttrs(null)).toEqual({});
    });
});

describe('boot config validation', () => {
    it('accepts the documented shape and fills defaults', () => {
        const b = parseBoot(makeBoot(), KEY);

        expect(b).not.toBeNull();
        expect(b?.api).toEqual({
            embed: `${APP}/embed/${KEY}`,
            appOrigin: APP,
        });
        expect(b?.config.theme.primary).toBe(DEFAULTS.theme.primary);
        expect(b?.config.theme.mode).toBe('light');
        expect(b?.categories).toHaveLength(3);
        expect(b?.greetings[0].weight).toBe(1);
    });

    it("hands the panel each category's description, icon and colour (it validates them), and nothing else of the entry", () => {
        const b = parseBoot(
            makeBoot({
                categories: [
                    {
                        slug: 'billing',
                        label: 'Billing',
                        description: 'Invoices',
                        icon: 'credit-card',
                        color: '#7c3aed',
                        secret: 'x',
                    },
                    { slug: 'tech', label: 'Tech', description: 5 },
                ],
            }),
            KEY,
        );
        const panel = b?.panel.categories as Record<string, unknown>[];

        expect(panel[0]).toEqual({
            slug: 'billing',
            label: 'Billing',
            description: 'Invoices',
            icon: 'credit-card',
            color: '#7c3aed',
        });
        expect(panel[1]).toEqual({ slug: 'tech', label: 'Tech' });
    });

    it.each([
        ['wrong key', { key: 'wk_OTHER' }],
        ['no api', { api: null }],
        [
            'appOrigin with a path',
            { api: { embed: `${APP}/embed/x`, appOrigin: `${APP}/x` } },
        ],
        [
            'embed on another origin',
            { api: { embed: 'https://evil.example/embed/x', appOrigin: APP } },
        ],
        [
            'http appOrigin',
            {
                api: {
                    embed: 'http://chat.example.com/e',
                    appOrigin: 'http://chat.example.com',
                },
            },
        ],
        [
            'javascript embed',
            { api: { embed: 'javascript:alert(1)', appOrigin: APP } },
        ],
    ])('rejects %s', (_, over) => {
        expect(parseBoot({ ...makeBoot(), ...over }, KEY)).toBeNull();
    });

    it.each([
        'http://localhost:8205',
        'http://127.0.0.1:8205',
        'http://chat.test',
        'http://chat.localhost:8000',
        'http://app.pne.test',
    ])('allows plain http on the development host %s', (o) => {
        const b = parseBoot(
            makeBoot({ api: { embed: `${o}/embed/${KEY}`, appOrigin: o } }),
            KEY,
        );
        expect(b?.api.appOrigin).toBe(o);
        expect(b?.panel.api).toMatchObject({ appOrigin: o });
    });

    it.each([
        'http://chat.example.com',
        'http://test.example.com',
        'http://localhost.evil.example',
    ])('refuses plain http on the real host %s', (o) => {
        expect(
            parseBoot(
                makeBoot({ api: { embed: `${o}/embed/${KEY}`, appOrigin: o } }),
                KEY,
            ),
        ).toBeNull();
    });

    describe('hostile window.__PNE_CHAT_BOOT__ (writable by any script on the host page)', () => {
        const api = (over: Dict) => ({
            api: {
                base: `${APP}/api/v1/public`,
                embed: `${APP}/embed/${KEY}`,
                appOrigin: APP,
                ...over,
            },
        });

        it('pins the app origin to the origin the loader script was served from', () => {
            expect(parseBoot(makeBoot(), KEY, APP)).not.toBeNull();
            const evil = 'https://evil.example';
            expect(
                parseBoot(
                    makeBoot(
                        api({ embed: `${evil}/embed/${KEY}`, appOrigin: evil }),
                    ),
                    KEY,
                    APP,
                ),
            ).toBeNull();
            // without a known script origin (no script URL) only the structural checks apply
            expect(
                parseBoot(
                    makeBoot(
                        api({ embed: `${evil}/embed/${KEY}`, appOrigin: evil }),
                    ),
                    KEY,
                ),
            ).not.toBeNull();
        });

        it.each([
            ['another path', `${APP}/embed/wk_OTHER`],
            ['a nested path', `${APP}/x/embed/${KEY}`],
            ['a trailing slash', `${APP}/embed/${KEY}/`],
            ['a different route', `${APP}/login`],
            ['a query', `${APP}/embed/${KEY}?next=https://evil.example`],
            ['a mode query', `${APP}/embed/${KEY}?mode=inline`],
            ['a combined query', `${APP}/embed/${KEY}?preview=1&x=1`],
            ['a fragment', `${APP}/embed/${KEY}#x`],
            ['credentials', `https://u:p@chat.example.com/embed/${KEY}`],
        ])('rejects an embed url with %s', (_, embed) => {
            expect(parseBoot(makeBoot(api({ embed })), KEY, APP)).toBeNull();
        });

        it('accepts the builder preview flag', () => {
            const embed = `${APP}/embed/${KEY}?preview=1`;
            expect(
                parseBoot(makeBoot(api({ embed })), KEY, APP)?.api.embed,
            ).toBe(embed);
        });

        it('rebuilds the panel boot from validated fields and never forwards the raw object', () => {
            const raw = makeBoot({
                api: {
                    base: 'https://evil.example/steal',
                    embed: `${APP}/embed/${KEY}`,
                    appOrigin: APP,
                    extra: 'x',
                },
                routing: { waves: [] },
                evil: { __proto__: { polluted: true } },
                locale: 'en',
                availability: { online: true, openNow: true, nextOpenAt: null },
                config: {
                    preChat: {
                        fields: { name: { enabled: true, required: true } },
                        consentText: 'OK?',
                    },
                    hours: { mode: 'always_online' },
                    theme: { primary: 'red; background:url(//evil)' },
                    session: { idleTimeoutMinutes: 1 },
                    domains: ['evil.example'],
                },
            });
            const b = parseBoot(JSON.parse(JSON.stringify(raw)), KEY, APP);
            const panel = b?.panel as Dict;

            expect(Object.keys(panel).sort()).toEqual(
                [
                    'api',
                    'availability',
                    'categories',
                    'config',
                    'configVersion',
                    'generatedAt',
                    'greetings',
                    'key',
                    'locale',
                    'v',
                ].sort(),
            );
            expect(panel.api).toEqual({
                base: `${APP}/api/v1/public`, // a base on another origin is replaced, not forwarded
                embed: `${APP}/embed/${KEY}`,
                appOrigin: APP,
            });
            const config = panel.config as Dict;
            expect(config.preChat).toEqual({
                fields: { name: { enabled: true, required: true } },
                consentText: 'OK?',
            });
            expect(config.hours).toEqual({ mode: 'always_online' });
            expect(config).not.toHaveProperty('session');
            expect(config).not.toHaveProperty('domains');
            expect((config.theme as Dict).primary).toBe(DEFAULTS.theme.primary);
            expect(panel).not.toHaveProperty('routing');
            expect(panel).not.toHaveProperty('evil');
            expect(JSON.stringify(panel)).not.toContain('evil.example');
            expect(panel).not.toBe(raw);
            expect(b).not.toHaveProperty('raw');
        });

        it('keeps a same-origin api.base and survives unserialisable pass-through data', () => {
            const base = `${APP}/api/v2/public`;
            const raw = makeBoot(api({ base }));
            const cyc: Dict = {};
            cyc.self = cyc;
            raw.availability = cyc;
            const b = parseBoot(raw, KEY, APP);

            expect(((b as Boot).panel.api as Dict).base).toBe(base);
            expect(b?.panel.availability).toBeNull();
        });

        it('drops __proto__ keys from pass-through data', () => {
            const raw = makeBoot();
            raw.availability = JSON.parse(
                '{"online":true,"__proto__":{"polluted":true}}',
            );
            const a = parseBoot(raw, KEY, APP)?.panel.availability as Dict;

            expect(a.online).toBe(true);
            expect(Object.keys(a)).toEqual(['online']);
            expect(({} as Dict).polluted).toBeUndefined();
        });
    });

    it('drops malformed greetings and categories instead of failing', () => {
        const b = parseBoot(
            makeBoot({
                greetings: [
                    { id: 'a', body: 'ok', weight: 3, locale: 'ar' },
                    { id: 'b' },
                    { body: 'no id' },
                    'junk',
                    {
                        id: 'c',
                        body: 'bad avatar',
                        agentAvatarUrl: 'javascript:alert(1)',
                        weight: -4,
                    },
                ],
                categories: [{ slug: 'ok', label: 'Ok' }, { slug: '../x' }, 4],
            }),
            KEY,
        );

        expect(b?.greetings.map((g) => g.id)).toEqual(['a', 'c']);
        expect(b?.greetings[0]).toMatchObject({ weight: 3, locale: 'ar' });
        expect(b?.greetings[1]).toMatchObject({
            agentAvatarUrl: null,
            weight: 1,
        });
        expect(b?.categories).toEqual([{ slug: 'ok', label: 'Ok' }]);
    });

    it('sanitises dashboard config too (never trusts raw colours or urls)', () => {
        const base = sanitizeBase(
            {
                theme: {
                    primary: 'expression(alert(1))',
                    fontUrl: 'https://evil.example/f.css',
                },
                launcher: { iconUrl: 'javascript:1' },
            },
            { base: APP, appOrigin: APP },
        );

        expect(base.theme.primary).toBe(DEFAULTS.theme.primary);
        expect(base.theme.fontUrl).toBeNull();
        expect(base.launcher.iconUrl).toBeNull();
    });
});

describe('fingerprint', () => {
    it('is stable, differs for different input and is not the input', () => {
        expect(fingerprint('user-42')).toBe(fingerprint('user-42'));
        expect(fingerprint('user-42')).not.toBe(fingerprint('user-43'));
        expect(fingerprint('user-42')).not.toContain('user');
        expect(fingerprint('')).toBeTruthy();
    });
});
