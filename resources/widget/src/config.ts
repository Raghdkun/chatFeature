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
import { clamp, clean, isRecord, own } from './util';

/**
 * Config defaults, validation and the precedence/restriction rules of docs/contracts/widget-config.md.
 *
 * Every value that reaches the DOM goes through a spec below: colours are hex, URLs are https (or loopback
 * http in dev), numbers are clamped, free text is stripped of control characters and length-capped. Client
 * input is only ever *read by whitelisted key*, never iterated, so a hostile object cannot add keys.
 */

export const DEFAULTS: BaseConfig = {
    defaultLocale: 'en',
    localeDetect: true,
    theme: {
        mode: 'auto',
        primary: '#0f766e',
        primaryText: '#ffffff',
        accent: '#f59e0b',
        surface: '#ffffff',
        text: '#0f172a',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontUrl: null,
        radius: 16,
        shadow: 'soft',
        launcherSize: 'md',
        panelWidth: 380,
        panelHeight: 620,
        position: 'bottom-right',
        offsetX: 20,
        offsetY: 20,
        zIndex: 2147483000,
    },
    launcher: {
        style: 'bubble',
        icon: 'chat',
        iconUrl: null,
        label: 'Chat with us',
        avatarUrl: null,
    },
    texts: {},
    features: {
        attachments: true,
        rating: true,
        sounds: true,
        preChat: true,
        whatsapp: false,
        offlineForm: true,
        titleBadge: false,
        endChatByVisitor: true,
        poweredBy: true,
    },
    greetings: {
        enabled: true,
        onPageLoad: true,
        delaySeconds: 3,
        intervalMinutes: 30,
        autoHideSeconds: 180,
        dismissPolicy: 'session',
        showAgent: true,
    },
};

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
const JWT =
    /^[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{1,2048}\.[A-Za-z0-9_-]{0,2048}$/;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.bunny.net'];
const LOOPBACK = /^(?:localhost|127\.0\.0\.1|\[::1\])$/;

/** `https:` only (plus `http:` on loopback for development), no credentials, resolved against `base`. */
export function safeUrl(v: unknown, base?: string): string | undefined {
    if (typeof v !== 'string' || v.length > 2048 || v.trim() === '') {
        return undefined;
    }

    try {
        const u = new URL(v.trim(), base);

        if (
            (u.protocol !== 'https:' &&
                !(u.protocol === 'http:' && LOOPBACK.test(u.hostname))) ||
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
    const map: Dict = {
        'bottom-right': 'bottom-right',
        'bottom-left': 'bottom-left',
        right: 'bottom-right',
        left: 'bottom-left',
    };

    return typeof v === 'string' && own(map, v) ? map[v] : undefined;
};

const THEME: Record<string, Spec> = {
    mode: oneOf('auto', 'light', 'dark'),
    primary: hex,
    primaryText: hex,
    accent: hex,
    surface: hex,
    text: hex,
    fontFamily: font,
    fontUrl,
    radius: num(0, 28),
    shadow: oneOf('none', 'soft', 'strong'),
    launcherSize: oneOf('sm', 'md', 'lg'),
    panelWidth: num(280, 640),
    panelHeight: num(360, 900),
    position,
    offsetX: num(0, 200),
    offsetY: num(0, 200),
    zIndex: num(0, 2147483647),
};

const LAUNCHER: Record<string, Spec> = {
    style: oneOf('bubble', 'pill'),
    icon: oneOf('chat', 'help', 'sparkle', 'custom'),
    iconUrl: url,
    label: str(60),
    avatarUrl: url,
};

const GREETINGS: Record<string, Spec> = {
    enabled: bool,
    onPageLoad: bool,
    delaySeconds: num(0, 3600),
    intervalMinutes: num(0, 1440),
    autoHideSeconds: num(0, 3600),
    dismissPolicy: oneOf('session', 'interval', 'never'),
    showAgent: bool,
};

const FEATURES: Record<string, Spec> = Object.fromEntries(
    FEATURE_NAMES.map((n) => [n, bool]),
);

const GROUPS = {
    theme: THEME,
    launcher: LAUNCHER,
    greetings: GREETINGS,
    features: FEATURES,
} as const;

function pick(raw: unknown, specs: Record<string, Spec>, c: Ctx): Dict {
    const out: Dict = {};

    if (isRecord(raw)) {
        for (const k of Object.keys(specs)) {
            if (own(raw, k)) {
                const v = specs[k](raw[k], c);

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

    const out: Visitor = {};
    const name = clean(raw.name, 200);
    const email = clean(raw.email, 254);
    const phone = clean(raw.phone, 40);

    if (name !== undefined) {
        out.name = name;
    }

    if (email !== undefined) {
        out.email = email;
    }

    if (phone !== undefined) {
        out.phone = phone;
    }

    if (isRecord(raw.meta)) {
        const meta: Record<string, string | number | boolean> = {};

        for (const k of Object.keys(raw.meta).slice(0, 20)) {
            const v = raw.meta[k];

            if (!/^[A-Za-z0-9_.-]{1,50}$/.test(k)) {
                continue;
            }

            if (typeof v === 'string') {
                const s = clean(v, 500);

                if (s !== undefined) {
                    meta[k] = s;
                }
            } else if (
                typeof v === 'boolean' ||
                (typeof v === 'number' && Number.isFinite(v))
            ) {
                meta[k] = v;
            }
        }

        if (Object.keys(meta).length > 0) {
            out.meta = meta;
        }
    }

    return Object.keys(out).length > 0 ? out : undefined;
}

export const sanitizeToken = (v: unknown): string | undefined =>
    typeof v === 'string' && v.length <= 4096 && JWT.test(v.trim())
        ? v.trim()
        : undefined;

export const sanitizeVisitorFields = sanitizeVisitor;

export function sanitizeSlugs(v: unknown): string[] | undefined {
    const list =
        typeof v === 'string' ? v.split(',') : Array.isArray(v) ? v : null;

    if (list === null) {
        return undefined;
    }

    const out = list

        .map((s) => (typeof s === 'string' ? s.trim() : ''))
        .filter((s) => SLUG.test(s));

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

    if (typeof raw.openOnLoad === 'boolean') {
        o.openOnLoad = raw.openOnLoad;
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
        const body = clean(g.body, 2000);

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

/**
 * Validates a resolved boot config (inline `__PNE_CHAT_BOOT__` or the config endpoint). Returns `null` when it
 * is unusable: wrong key, no trustworthy `api.appOrigin`, or an `api.embed` URL that is not on that origin
 * (the panel iframe and the postMessage origin check both hang off these two values).
 */
export function parseBoot(raw: unknown, key: string): Boot | null {
    if (!isRecord(raw) || !isRecord(raw.api) || raw.key !== key) {
        return null;
    }

    const origin = safeUrl(raw.api.appOrigin);
    const embed = safeUrl(raw.api.embed);

    // `appOrigin` must be a bare origin (no path) and the embed URL must live on it.
    if (
        origin === undefined ||
        embed === undefined ||
        new URL(origin).origin !== raw.api.appOrigin ||
        new URL(embed).origin !== raw.api.appOrigin
    ) {
        return null;
    }

    const appOrigin = raw.api.appOrigin;

    let clone: Dict;

    try {
        clone = JSON.parse(JSON.stringify(raw)) as Dict;
    } catch {
        return null;
    }

    const c: Ctx = { base: appOrigin, appOrigin };
    const categories = (
        Array.isArray(raw.categories) ? raw.categories : []
    ).flatMap((x: unknown) =>
        isRecord(x) && typeof x.slug === 'string' && SLUG.test(x.slug)
            ? [{ slug: x.slug, label: clean(x.label, 100) ?? x.slug }]
            : [],
    );

    return {
        key,
        configVersion:
            typeof raw.configVersion === 'number' ? raw.configVersion : 0,
        api: { embed, appOrigin },
        config: sanitizeBase(raw.config, c),
        greetings: sanitizeGreetings(raw.greetings, c),
        categories,
        raw: clone,
    };
}

/* ------------------------------------------------------------ data-* map */

const bln = (v: string): boolean | undefined =>
    v === 'true' ? true : v === 'false' ? false : undefined;
const onOff = (v: string): boolean | undefined =>
    v === 'on' ? true : v === 'off' ? false : undefined;

/** data-* attribute (camelCased dataset key) -> override path. Values are validated later by the specs. */
const DATA_MAP: [string, string[], ((v: string) => unknown)?][] = [
    ['locale', ['locale']],
    ['position', ['theme', 'position']],
    ['offsetX', ['theme', 'offsetX']],
    ['offsetY', ['theme', 'offsetY']],
    ['zIndex', ['theme', 'zIndex']],
    ['themeMode', ['theme', 'mode']],
    ['themePrimary', ['theme', 'primary']],
    ['themeAccent', ['theme', 'accent']],
    ['themeRadius', ['theme', 'radius']],
    ['launcherStyle', ['launcher', 'style']],
    ['launcherLabel', ['launcher', 'label']],
    ['greetings', ['greetings', 'enabled'], onOff],
    ['openOnLoad', ['openOnLoad'], bln],
    ['identityToken', ['identityToken']],
    ['categories', ['categories']],
];

/** Builds the raw (unsanitised) override object described by the script tag's `data-*` attributes. */
export function parseDataAttrs(script: { dataset: DOMStringMap } | null): Dict {
    const out: Dict = {};

    if (script === null) {
        return out;
    }

    for (const [attr, path, conv] of DATA_MAP) {
        const raw = script.dataset[attr];

        if (raw === undefined) {
            continue;
        }

        const v = conv === undefined ? raw : conv(raw);

        if (v === undefined) {
            continue;
        }

        let node = out;

        for (const seg of path.slice(0, -1)) {
            node = (node[seg] as Dict | undefined) ?? (node[seg] = {});
        }

        node[path[path.length - 1]] = v;
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
    const nav = normalizeLocale(navLangs[0]);
    const locale =
        ov.locale ?? (b.localeDetect && nav !== undefined ? nav : dl);
    const textLocale =
        [locale, lang(locale), dl, lang(dl), 'en'].find((l) => own(texts, l)) ??
        dl;

    return {
        locale,
        textLocale,
        dir: RTL.test(lang(locale)) ? 'rtl' : 'ltr',
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
