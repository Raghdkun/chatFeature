import { FEATURE_NAMES } from './types';
import type {
    BaseConfig,
    Boot,
    Dict,
    Effective,
    Greeting,
    Overrides,
    Texts,
    Visitor,
} from './types';
import { clamp, clean, isRecord, opt, own } from './util';

/**
 * Config defaults, validation and the precedence/restriction rules of docs/contracts/widget-config.md.
 *
 * Every value that reaches the DOM goes through a spec below: colours are hex, URLs are https (or http on local
 * development hosts), numbers are clamped, free text is stripped of control characters and length-capped. Client
 * input is only ever *read by whitelisted key*, never iterated, so a hostile object cannot add keys.
 */

/* ---------------------------------------------------------------- specs */

export interface Ctx {
    /** Base used to resolve relative URLs (app origin for dashboard config, host page for client input). */
    base?: string;
    /** Origin of the chat app (allowed font host). */
    appOrigin?: string;
}

/** A spec returns the sanitised value, or `undefined` to drop the field. */
type Spec = (v: unknown, c: Ctx) => unknown;

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const LOCALE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2}$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const FONT = /^[\w\s,'"\-.]{1,200}$/;
const JWT = /^[\w-]+\.[\w-]+\.[\w-]*$/;
const MAX_CATEGORIES = 50;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.bunny.net'];
// Plain http is only ever accepted for local development: loopback plus the reserved `.test` / `.localhost` TLDs.
const DEV_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\]|.+\.(?:test|localhost))$/;

/** `https:` only (plus `http:` on local development hosts), no credentials, resolved against `base`. */
export function safeUrl(v: unknown, base?: string): string | undefined {
    if (typeof v !== 'string' || v.length > 2048 || v.trim() === '') {
        return undefined;
    }

    try {
        const u = new URL(v.trim(), base);

        if (
            (u.protocol !== 'https:' &&
                !(u.protocol === 'http:' && DEV_HOST.test(u.hostname))) ||
            u.username !== '' ||
            u.password !== ''
        ) {
            return undefined;
        }

        return u.href;
    } catch {
        return undefined;
    }
}

export function normalizeLocale(v: unknown): string | undefined {
    return typeof v === 'string' && LOCALE.test(v.trim())
        ? v.trim().replace('_', '-').toLowerCase()
        : undefined;
}

const hex: Spec = (v) =>
    typeof v === 'string' && HEX.test(v.trim()) ? v.trim() : undefined;

const num =
    (min: number, max: number): Spec =>
    (v) => {
        const n =
            typeof v === 'number'
                ? v
                : typeof v === 'string' && v.trim() !== ''
                  ? Number(v)
                  : NaN;

        return Number.isFinite(n) ? Math.round(clamp(n, min, max)) : undefined;
    };

const oneOf =
    (...vals: string[]): Spec =>
    (v) =>
        typeof v === 'string' && vals.includes(v) ? v : undefined;

const bool: Spec = (v) => (typeof v === 'boolean' ? v : undefined);

const str =
    (max: number): Spec =>
    (v) =>
        clean(v, max);

const url: Spec = (v, c) => safeUrl(v, c.base);

const font: Spec = (v) =>
    typeof v === 'string' && FONT.test(v.trim()) ? v.trim() : undefined;

const fontUrl: Spec = (v, c) => {
    const href = safeUrl(v, c.base);

    if (href === undefined) {
        return undefined;
    }

    const u = new URL(href);

    return FONT_HOSTS.includes(u.hostname) ||
        (c.appOrigin !== undefined && u.origin === c.appOrigin)
        ? href
        : undefined;
};

const position: Spec = (v) => {
    const m =
        typeof v === 'string' ? /^(?:bottom-)?(right|left)$/.exec(v) : null;

    return m === null ? undefined : `bottom-${m[1]}`;
};

/** One entry per field: its documented default and the spec that validates client/dashboard input for it. */
type Entry = [unknown, Spec];

const THEME: Record<string, Entry> = {
    mode: ['auto', oneOf('auto', 'light', 'dark')],
    primary: ['#0f766e', hex],
    primaryText: ['#ffffff', hex],
    accent: ['#f59e0b', hex],
    surface: ['#ffffff', hex],
    text: ['#0f172a', hex],
    fontFamily: ['Inter, system-ui, sans-serif', font],
    fontUrl: [null, fontUrl],
    radius: [16, num(0, 28)],
    shadow: ['soft', oneOf('none', 'soft', 'strong')],
    launcherSize: ['md', oneOf('sm', 'md', 'lg')],
    panelWidth: [380, num(280, 640)],
    panelHeight: [620, num(360, 900)],
    position: ['bottom-right', position],
    offsetX: [20, num(0, 200)],
    offsetY: [20, num(0, 200)],
    zIndex: [2147483000, num(0, 2147483647)],
};

const LAUNCHER: Record<string, Entry> = {
    style: ['bubble', oneOf('bubble', 'pill')],
    icon: ['chat', oneOf('chat', 'help', 'sparkle', 'custom')],
    iconUrl: [null, url],
    label: ['Chat with us', str(60)],
    avatarUrl: [null, url],
};

const GREETINGS: Record<string, Entry> = {
    enabled: [true, bool],
    onPageLoad: [true, bool],
    delaySeconds: [3, num(0, 3600)],
    intervalMinutes: [30, num(0, 1440)],
    autoHideSeconds: [180, num(0, 3600)],
    dismissPolicy: ['session', oneOf('session', 'interval', 'never')],
    showAgent: [true, bool],
};

// Everything is on by default except WhatsApp (needs a connected session) and the tab-title badge.
const FEATURES: Record<string, Entry> = Object.fromEntries(
    FEATURE_NAMES.map((n) => [
        n,
        [n !== 'whatsapp' && n !== 'titleBadge', bool],
    ]),
);

const GROUPS = {
    theme: THEME,
    launcher: LAUNCHER,
    greetings: GREETINGS,
    features: FEATURES,
};

/** Config defaults (docs/contracts/widget-config.md), derived from the field table above. */
export const DEFAULTS = {
    defaultLocale: 'en',
    localeDetect: true,
    texts: {},
    ...Object.fromEntries(
        Object.entries(GROUPS).map(([g, fields]) => [
            g,
            Object.fromEntries(
                Object.entries(fields).map(([k, e]) => [k, e[0]]),
            ),
        ]),
    ),
} as BaseConfig;

function pick(raw: unknown, specs: Record<string, Entry>, c: Ctx): Dict {
    const out: Dict = {};

    if (isRecord(raw)) {
        for (const k of Object.keys(specs)) {
            if (own(raw, k)) {
                const v = specs[k][1](raw[k], c);

                if (v !== undefined) {
                    out[k] = v;
                }
            }
        }
    }

    return out;
}

function sanitizeTexts(raw: unknown): Texts {
    const out: Texts = {};

    if (!isRecord(raw)) {
        return out;
    }

    for (const loc of Object.keys(raw)) {
        const l = normalizeLocale(loc);
        const block = raw[loc];

        if (l === undefined || !isRecord(block)) {
            continue;
        }

        const clone: Record<string, string> = {};

        for (const k of Object.keys(block)) {
            const v = /^[A-Za-z][A-Za-z0-9]{0,39}$/.test(k)
                ? clean(block[k], 500)
                : undefined;

            if (v !== undefined) {
                clone[k] = v;
            }
        }

        out[l] = { ...out[l], ...clone };
    }

    return out;
}

function sanitizeVisitor(raw: unknown): Visitor | undefined {
    if (!isRecord(raw)) {
        return undefined;
    }

    const out: Dict = {
        ...opt('name', clean(raw.name, 200)),
        ...opt('email', clean(raw.email, 254)),
        ...opt('phone', clean(raw.phone, 40)),
    };

    if (isRecord(raw.meta)) {
        const meta: Dict = {};
        const keys = Object.keys(raw.meta)
            .filter((k) => /^[A-Za-z0-9_.-]{1,50}$/.test(k))
            .slice(0, 20);

        for (const k of keys) {
            const v = raw.meta[k];
            const x =
                typeof v === 'string'
                    ? clean(v, 500)
                    : typeof v === 'boolean' ||
                        (typeof v === 'number' && Number.isFinite(v))
                      ? v
                      : undefined;

            if (x !== undefined) {
                meta[k] = x;
            }
        }

        Object.assign(
            out,
            opt('meta', Object.keys(meta).length > 0 ? meta : null),
        );
    }

    return Object.keys(out).length > 0 ? (out as Visitor) : undefined;
}

export const sanitizeToken = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 4096 && JWT.test(v.trim())
        ? v.trim()
        : undefined;

export const sanitizeVisitorFields = sanitizeVisitor;

export function sanitizeSlugs(v: unknown): string[] | undefined {
    const list =
        typeof v === 'string'
            ? v.slice(0, 5000).split(',')
            : Array.isArray(v)
              ? v
              : null;

    if (list === null) {
        return undefined;
    }

    const out = list
        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => SLUG.test(s))
        .slice(0, MAX_CATEGORIES);

    return out.length > 0 ? out : undefined;
}

/** Whitelist-sanitises one client override layer (data-*, init settings or runtime update). */
export function sanitizeOverrides(raw: unknown, c: Ctx): Overrides {
    const o: Overrides = {};

    if (!isRecord(raw)) {
        return o;
    }

    const locale = normalizeLocale(raw.locale);
    const defaultLocale = normalizeLocale(raw.defaultLocale);

    if (locale !== undefined) {
        o.locale = locale;
    }

    if (defaultLocale !== undefined) {
        o.defaultLocale = defaultLocale;
    }

    for (const g of Object.keys(GROUPS) as (keyof typeof GROUPS)[]) {
        const picked = pick(raw[g], GROUPS[g], c);

        if (Object.keys(picked).length > 0) {
            (o as Dict)[g] = picked;
        }
    }

    const texts = sanitizeTexts(raw.texts);

    if (Object.keys(texts).length > 0) {
        o.texts = texts;
    }

    const categories = sanitizeSlugs(raw.categories);

    if (categories !== undefined) {
        o.categories = categories;
    }

    const visitor = sanitizeVisitor(raw.visitor);

    if (visitor !== undefined) {
        o.visitor = visitor;
    }

    const token = sanitizeToken(raw.identityToken);

    if (token !== undefined) {
        o.identityToken = token;
    }

    for (const k of ['openOnLoad', 'exposeMessageContent'] as const) {
        if (typeof raw[k] === 'boolean') {
            o[k] = raw[k];
        }
    }

    return o;
}

/** Validates the dashboard config and fills every missing key with the documented default. */
export function sanitizeBase(raw: unknown, c: Ctx): BaseConfig {
    const o = sanitizeOverrides(raw, c);
    const d = DEFAULTS;

    return {
        defaultLocale: o.defaultLocale ?? d.defaultLocale,
        localeDetect:
            !isRecord(raw) || typeof raw.localeDetect !== 'boolean'
                ? d.localeDetect
                : raw.localeDetect,
        theme: { ...d.theme, ...o.theme },
        launcher: { ...d.launcher, ...o.launcher },
        texts: o.texts ?? {},
        features: { ...d.features, ...o.features },
        greetings: { ...d.greetings, ...o.greetings },
    };
}

function sanitizeGreetings(raw: unknown, c: Ctx): Greeting[] {
    if (!Array.isArray(raw)) {
        return [];
    }

    const out: Greeting[] = [];

    for (const g of raw) {
        if (!isRecord(g)) {
            continue;
        }

        const id = clean(g.id, 64);
        const body = clean(g.body, 2000, true);

        if (id === undefined || body === undefined) {
            continue;
        }

        out.push({
            id,
            body,
            agentName: clean(g.agentName, 100) ?? null,
            agentAvatarUrl:
                (url(g.agentAvatarUrl, c) as string | undefined) ?? null,
            locale: normalizeLocale(g.locale) ?? null,
            weight: (num(1, 1000)(g.weight, c) as number | undefined) ?? 1,
        });
    }

    return out;
}

/** Detached JSON copy of pass-through data (`__proto__` keys dropped): the panel never gets the page's objects. */
const copy = (v: unknown): unknown => {
    try {
        return JSON.parse(JSON.stringify(v ?? null), (k, x: unknown) =>
            k === '__proto__' ? undefined : x,
        );
    } catch {
        return null;
    }
};

const copyKeys = (o: Dict, keys: string[]): Dict =>
    Object.fromEntries(
        keys.filter((k) => own(o, k)).map((k) => [k, copy(o[k])]),
    );

/**
 * Validates a resolved boot config (inline `__PNE_CHAT_BOOT__` or the config endpoint). Returns `null` when it
 * is unusable. `window.__PNE_CHAT_BOOT__` is writable by any script on the host page, so the two values the
 * panel iframe and the postMessage origin check hang off are pinned hard: `api.appOrigin` must be a bare origin
 * (and, when we know where the loader script came from, exactly that origin), and `api.embed` must be
 * `<appOrigin>/embed/<key>` with at most the `?preview=1` flag. The panel never sees the object we were given:
 * `panel` is rebuilt from validated fields.
 */
export function parseBoot(
    raw: unknown,
    key: string,
    scriptOrigin?: string,
): Boot | null {
    if (!isRecord(raw) || !isRecord(raw.api) || raw.key !== key) {
        return null;
    }

    const origin = safeUrl(raw.api.appOrigin);
    const embedUrl = safeUrl(raw.api.embed);

    if (origin === undefined || embedUrl === undefined) {
        return null;
    }

    const appOrigin = new URL(origin).origin;
    const e = new URL(embedUrl);

    if (
        appOrigin !== raw.api.appOrigin ||
        e.origin !== appOrigin ||
        e.pathname !== `/embed/${key}` ||
        e.hash !== '' ||
        !['', '?preview=1'].includes(e.search) ||
        (scriptOrigin !== undefined && appOrigin !== scriptOrigin)
    ) {
        return null;
    }

    const c: Ctx = { base: appOrigin, appOrigin };
    const rc = isRecord(raw.config) ? raw.config : {};
    const config = sanitizeBase(rc, c);
    const greetings = sanitizeGreetings(raw.greetings, c);
    const configVersion =
        typeof raw.configVersion === 'number' ? raw.configVersion : 0;
    const categories = (
        Array.isArray(raw.categories) ? raw.categories : []
    ).flatMap((x: unknown) =>
        isRecord(x) && typeof x.slug === 'string' && SLUG.test(x.slug)
            ? [{ slug: x.slug, label: clean(x.label, 100) ?? x.slug }]
            : [],
    );
    const base = safeUrl(raw.api.base);

    return {
        key,
        configVersion,
        api: { embed: embedUrl, appOrigin },
        config,
        greetings,
        categories,
        panel: {
            ...copyKeys(raw, ['generatedAt', 'locale', 'availability']),
            v: 1,
            key,
            configVersion,
            api: {
                base:
                    base !== undefined && new URL(base).origin === appOrigin
                        ? base
                        : `${appOrigin}/api/v1/public`,
                embed: embedUrl,
                appOrigin,
            },
            config: { ...config, v: 1, ...copyKeys(rc, ['preChat', 'hours']) },
            greetings,
            categories,
        },
    };
}

/* ------------------------------------------------------------ data-* map */

const bln = (v: string): boolean | undefined =>
    v === 'true' ? true : v === 'false' ? false : undefined;
const onOff = (v: string): boolean | undefined =>
    v === 'on' ? true : v === 'off' ? false : undefined;

/** data-* attribute (camelCased dataset key) -> dotted override path. Values are validated later by the specs. */
const DATA_MAP: [string, string, ((v: string) => unknown)?][] = [
    ['locale', 'locale'],
    ['position', 'theme.position'],
    ['offsetX', 'theme.offsetX'],
    ['offsetY', 'theme.offsetY'],
    ['zIndex', 'theme.zIndex'],
    ['themeMode', 'theme.mode'],
    ['themePrimary', 'theme.primary'],
    ['themeAccent', 'theme.accent'],
    ['themeRadius', 'theme.radius'],
    ['launcherStyle', 'launcher.style'],
    ['launcherLabel', 'launcher.label'],
    ['greetings', 'greetings.enabled', onOff],
    ['openOnLoad', 'openOnLoad', bln],
    ['identityToken', 'identityToken'],
    ['categories', 'categories'],
];

/** Builds the raw (unsanitised) override object described by the script tag's `data-*` attributes. */
export function parseDataAttrs(script: { dataset: DOMStringMap } | null): Dict {
    const out: Dict = {};

    for (const [attr, path, conv] of DATA_MAP) {
        const raw = script?.dataset[attr];
        const v = raw === undefined || conv === undefined ? raw : conv(raw);

        if (v !== undefined) {
            const keys = path.split('.');
            let node = out;

            for (const seg of keys.slice(0, -1)) {
                node = (node[seg] as Dict | undefined) ?? (node[seg] = {});
            }

            node[keys[keys.length - 1]] = v;
        }
    }

    return out;
}

/* ------------------------------------------------------------ resolving */

const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi|dv|ckb)$/i;
const lang = (l: string): string => l.split('-')[0].toLowerCase();

/** Dashboard < data-* < init < update (overrides arrive pre-merged in that order), restriction rule applied. */
export function resolve(
    boot: Boot,
    ov: Overrides,
    navLangs: readonly string[],
): Effective {
    const b = boot.config;
    const theme = { ...b.theme, ...ov.theme };
    const launcher = { ...b.launcher, ...ov.launcher };

    if (launcher.icon === 'custom' && launcher.iconUrl === null) {
        launcher.icon = 'chat';
    }

    const greetings = { ...b.greetings, ...ov.greetings };

    for (const k of ['enabled', 'onPageLoad', 'showAgent'] as const) {
        greetings[k] = b.greetings[k] && ov.greetings?.[k] !== false;
    }

    const features = { ...b.features };

    for (const n of FEATURE_NAMES) {
        const o = ov.features?.[n];

        // sounds + titleBadge are host-side presentation preferences: either direction. Everything else
        // (poweredBy included) may only be switched off, never on.
        features[n] =
            n === 'sounds' || n === 'titleBadge'
                ? (o ?? b.features[n])
                : b.features[n] && o !== false;
    }

    let categories = boot.categories;

    if (ov.categories !== undefined) {
        const subset = categories.filter((c) =>
            ov.categories?.includes(c.slug),
        );

        if (subset.length > 0) {
            categories = subset;
        }
    }

    const texts: Texts = {};

    for (const src of [b.texts, ov.texts ?? {}]) {
        for (const l of Object.keys(src)) {
            texts[l] = { ...texts[l], ...src[l] };
        }
    }

    const dl = ov.defaultLocale ?? b.defaultLocale;
    const has = (l: string): boolean => own(texts, l);
    // The browser locale counts only when there are texts for it (otherwise the visitor would get, say,
    // right-to-left chrome around English strings); direction always follows the texts actually shown.
    const nav = navLangs
        .map(normalizeLocale)
        .find((l) => l !== undefined && (has(l) || has(lang(l))));
    const locale = ov.locale ?? (b.localeDetect ? nav : undefined) ?? dl;
    const textLocale = [locale, lang(locale), dl, lang(dl)].find(has) ?? 'en';
    const label = texts[textLocale]?.launcherLabel;

    if (ov.launcher?.label === undefined && textLocale !== dl && label) {
        launcher.label = label.slice(0, 60);
    }

    return {
        locale,
        textLocale,
        defaultLocale: dl,
        dir: RTL.test(lang(textLocale)) ? 'rtl' : 'ltr',
        theme,
        launcher,
        features,
        greetings,
        categories,
        openOnLoad: ov.openOnLoad === true,
        text: (key, fallback) =>
            texts[textLocale]?.[key] ?? texts[dl]?.[key] ?? fallback,
    };
}
