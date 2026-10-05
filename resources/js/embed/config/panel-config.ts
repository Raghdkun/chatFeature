/**
 * What the panel renders from: the loader's rebuilt boot config (`init.boot`, docs/contracts/postmessage-protocol.md) with the
 * host's already-restricted `overrides` applied, optionally enriched by a fresh read of the public config endpoint (category
 * descriptions / icons / colours, current availability). The result is a plain, fully validated object: nothing downstream
 * re-checks colours, URLs or enum values.
 *
 * Defaults mirror docs/contracts/widget-config.md; a boot config that lacks a field (an older loader, a hand-built preview)
 * renders with them instead of crashing.
 */
import { isRecord, type Dict } from '@/embed/protocol/messages';

export type Scheme = 'light' | 'dark';
export type ThemeMode = 'auto' | 'light' | 'dark';
export type Direction = 'ltr' | 'rtl';

export type PanelTheme = {
    mode: ThemeMode;
    primary: string;
    primaryText: string;
    accent: string;
    surface: string;
    text: string;
    fontFamily: string;
    fontUrl: string | null;
    radius: number;
    shadow: 'none' | 'soft' | 'strong';
    panelWidth: number;
    panelHeight: number;
};

export const FEATURE_KEYS = [
    'attachments',
    'rating',
    'sounds',
    'preChat',
    'whatsapp',
    'offlineForm',
    'titleBadge',
    'endChatByVisitor',
    'poweredBy',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type PanelFeatures = Record<FeatureKey, boolean>;

export const PRECHAT_FIELDS = ['name', 'email', 'phone'] as const;
export type PreChatFieldName = (typeof PRECHAT_FIELDS)[number];
export type PreChatField = { enabled: boolean; required: boolean };

export type PanelCategory = {
    slug: string;
    label: string;
    description: string | null;
    icon: string | null;
    color: string | null;
};

export type PanelAvailability = {
    online: boolean;
    openNow: boolean;
    nextOpenAt: string | null;
    categories: { slug: string; online: boolean }[];
    whatsapp: { enabled: boolean };
};

export type PanelConfig = {
    key: string;
    apiBase: string;
    appOrigin: string;
    configVersion: number;
    /** The visitor's locale after detection (what dates are formatted in). */
    locale: string;
    /** The locale the widget texts were read from. */
    textLocale: string;
    defaultLocale: string;
    dir: Direction;
    theme: PanelTheme;
    /** Complete widget text blocks by locale (admin-edited; may be empty). */
    texts: Record<string, Record<string, string>>;
    features: PanelFeatures;
    preChat: {
        fields: Record<PreChatFieldName, PreChatField>;
        consentText: string | null;
    };
    /** In display order, already reduced to the host's category subset. */
    categories: PanelCategory[];
    /** `null` when the boot config carries none (treated as "online", the server decides). */
    availability: PanelAvailability | null;
};

export const DEFAULT_THEME: PanelTheme = {
    mode: 'auto',
    primary: '#0f766e',
    primaryText: '#ffffff',
    accent: '#D97706',
    surface: '#ffffff',
    text: '#0f172a',
    fontFamily: 'Inter, system-ui, sans-serif',
    fontUrl: null,
    radius: 16,
    shadow: 'soft',
    panelWidth: 380,
    panelHeight: 620,
};

export const DEFAULT_FEATURES: PanelFeatures = {
    attachments: true,
    rating: true,
    sounds: true,
    preChat: true,
    whatsapp: false,
    offlineForm: true,
    titleBadge: false,
    endChatByVisitor: true,
    poweredBy: true,
};

const DEFAULT_PRECHAT: Record<PreChatFieldName, PreChatField> = {
    name: { enabled: true, required: true },
    email: { enabled: true, required: false },
    phone: { enabled: false, required: false },
};

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FONT_FAMILY = /^[A-Za-z0-9 ,._'"-]{1,200}$/;
const SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const LOCALE = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/;
const RTL = /^(?:ar|he|fa|ur|ps|sd|ug|yi|dv|ckb)$/i;
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.bunny.net'];

const str = (value: unknown): string | undefined =>
    typeof value === 'string' ? value : undefined;

const bool = (value: unknown, fallback: boolean): boolean =>
    typeof value === 'boolean' ? value : fallback;

const clampInt = (
    value: unknown,
    min: number,
    max: number,
    fallback: number,
): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.round(Math.min(max, Math.max(min, value)))
        : fallback;

const color = (value: unknown, fallback: string): string => {
    const text = str(value);

    return text !== undefined && HEX.test(text) ? text : fallback;
};

export function languageOf(locale: string): string {
    return locale.replace('_', '-').split('-')[0].toLowerCase();
}

export function directionOf(locale: string): Direction {
    return RTL.test(languageOf(locale)) ? 'rtl' : 'ltr';
}

export function normalizeLocale(value: unknown): string | undefined {
    const text = str(value)?.trim().replace('_', '-');

    return text !== undefined && text.length <= 12 && LOCALE.test(text)
        ? text
        : undefined;
}

function fontUrl(value: unknown, appOrigin: string): string | null {
    const text = str(value);

    if (text === undefined || text === '') {
        return null;
    }

    try {
        const url = new URL(text, appOrigin);
        const own = url.origin === appOrigin;

        return url.protocol === 'https:' &&
            (own || FONT_HOSTS.includes(url.hostname)) &&
            url.username === '' &&
            url.password === ''
            ? url.href
            : null;
    } catch {
        return null;
    }
}

export function sanitizeTheme(
    raw: unknown,
    appOrigin: string,
    base: PanelTheme = DEFAULT_THEME,
): PanelTheme {
    const t = isRecord(raw) ? raw : {};
    const mode = str(t.mode);
    const shadow = str(t.shadow);
    const family = str(t.fontFamily);

    return {
        mode:
            mode === 'light' || mode === 'dark' || mode === 'auto'
                ? mode
                : base.mode,
        primary: color(t.primary, base.primary),
        primaryText: color(t.primaryText, base.primaryText),
        accent: color(t.accent, base.accent),
        surface: color(t.surface, base.surface),
        text: color(t.text, base.text),
        fontFamily:
            family !== undefined && FONT_FAMILY.test(family)
                ? family
                : base.fontFamily,
        fontUrl: 'fontUrl' in t ? fontUrl(t.fontUrl, appOrigin) : base.fontUrl,
        radius: clampInt(t.radius, 0, 28, base.radius),
        shadow:
            shadow === 'none' || shadow === 'soft' || shadow === 'strong'
                ? shadow
                : base.shadow,
        panelWidth: clampInt(t.panelWidth, 280, 640, base.panelWidth),
        panelHeight: clampInt(t.panelHeight, 360, 900, base.panelHeight),
    };
}

function sanitizeTexts(raw: unknown): Record<string, Record<string, string>> {
    const out: Record<string, Record<string, string>> = {};

    if (!isRecord(raw)) {
        return out;
    }

    for (const [locale, block] of Object.entries(raw)) {
        const code = normalizeLocale(locale);

        if (code === undefined || !isRecord(block)) {
            continue;
        }

        const texts: Record<string, string> = {};

        for (const [key, value] of Object.entries(block)) {
            if (typeof value === 'string' && value !== '') {
                texts[key] = value.slice(0, 500);
            }
        }

        out[code] = texts;
    }

    return out;
}

function mergeTexts(
    base: Record<string, Record<string, string>>,
    extra: Record<string, Record<string, string>>,
): Record<string, Record<string, string>> {
    const out = { ...base };

    for (const [locale, block] of Object.entries(extra)) {
        out[locale] = { ...out[locale], ...block };
    }

    return out;
}

function sanitizeFeatures(raw: unknown): PanelFeatures {
    const f = isRecord(raw) ? raw : {};
    const out = { ...DEFAULT_FEATURES };

    for (const key of FEATURE_KEYS) {
        out[key] = bool(f[key], DEFAULT_FEATURES[key]);
    }

    return out;
}

function sanitizePreChat(raw: unknown): PanelConfig['preChat'] {
    const p = isRecord(raw) ? raw : {};
    const fields = isRecord(p.fields) ? p.fields : {};
    const out = { ...DEFAULT_PRECHAT };

    for (const name of PRECHAT_FIELDS) {
        const field = isRecord(fields[name]) ? fields[name] : {};
        const enabled = bool(field.enabled, DEFAULT_PRECHAT[name].enabled);

        out[name] = {
            enabled,
            required:
                enabled && bool(field.required, DEFAULT_PRECHAT[name].required),
        };
    }

    const consent = str(p.consentText)?.trim();

    return {
        fields: out,
        consentText:
            consent !== undefined && consent !== ''
                ? consent.slice(0, 500)
                : null,
    };
}

export function sanitizeCategory(raw: unknown): PanelCategory | null {
    if (!isRecord(raw)) {
        return null;
    }

    const slug = str(raw.slug);

    if (slug === undefined || !SLUG.test(slug)) {
        return null;
    }

    const description = str(raw.description)?.trim();
    const icon = str(raw.icon);
    const tint = str(raw.color);

    return {
        slug,
        label: (str(raw.label) ?? slug).slice(0, 100),
        description:
            description !== undefined && description !== ''
                ? description.slice(0, 300)
                : null,
        icon:
            icon !== undefined && /^[a-z0-9-]{1,64}$/.test(icon) ? icon : null,
        color: tint !== undefined && HEX.test(tint) ? tint : null,
    };
}

export function sanitizeAvailability(raw: unknown): PanelAvailability | null {
    if (!isRecord(raw) || typeof raw.online !== 'boolean') {
        return null;
    }

    const categories = Array.isArray(raw.categories) ? raw.categories : [];
    const whatsapp = isRecord(raw.whatsapp) ? raw.whatsapp : {};
    const next = str(raw.nextOpenAt);

    return {
        online: raw.online,
        openNow: bool(raw.openNow, true),
        nextOpenAt:
            next !== undefined && !Number.isNaN(Date.parse(next)) ? next : null,
        categories: categories.flatMap((entry: unknown) =>
            isRecord(entry) &&
            typeof entry.slug === 'string' &&
            typeof entry.online === 'boolean'
                ? [{ slug: entry.slug, online: entry.online }]
                : [],
        ),
        whatsapp: { enabled: bool(whatsapp.enabled, false) },
    };
}

function categoriesOf(raw: unknown): PanelCategory[] {
    return (Array.isArray(raw) ? raw : []).flatMap((entry: unknown) => {
        const category = sanitizeCategory(entry);

        return category === null ? [] : [category];
    });
}

/**
 * Detects the visitor's text locale the way the loader does: an explicit override wins, then (when `localeDetect`) the first
 * browser language the widget has a texts block for (exact, then its language, then any variant of that language), else the
 * widget's default locale.
 */
export function pickLocale(input: {
    texts: Record<string, Record<string, string>>;
    defaultLocale: string;
    override?: string;
    detect: boolean;
    navigatorLanguages: readonly string[];
    serverLocale?: string;
}): { locale: string; textLocale: string } {
    const { texts, defaultLocale } = input;
    const has = (code: string): boolean =>
        Object.prototype.hasOwnProperty.call(texts, code);
    const match = (code: string): string | undefined => {
        const lower = code.toLowerCase();
        const keys = Object.keys(texts);

        return (
            keys.find((key) => key.toLowerCase() === lower) ??
            keys.find((key) => languageOf(key) === languageOf(code))
        );
    };

    const detected = input.detect
        ? input.navigatorLanguages
              .map(normalizeLocale)
              .find((code) => code !== undefined && match(code) !== undefined)
        : undefined;
    const locale =
        input.override ?? detected ?? input.serverLocale ?? defaultLocale;
    const textLocale =
        [locale, languageOf(locale), defaultLocale, languageOf(defaultLocale)]
            .map((code) => (has(code) ? code : match(code)))
            .find((code) => code !== undefined) ?? defaultLocale;

    return { locale, textLocale };
}

export type BuildInput = {
    /** `init.boot` from the host (or the self-booted equivalent). */
    boot: Dict;
    /** `init.overrides`: already restricted by the loader. */
    overrides?: Dict;
    /** A fresh read of the public config endpoint; only its categories and availability are used. */
    fresh?: Dict | null;
    navigatorLanguages?: readonly string[];
    /** A builder preview draft (`draft` message): replaces the restyleable parts of the config. */
    draft?: Dict | null;
    /**
     * The origin this page was served from (inlined by the server, not sent by the host). In launcher mode `boot.api.*` arrives
     * over postMessage from a page that may host hostile scripts: when this is set the panel talks only to this origin and
     * ignores a base URL / origin that names another one.
     */
    trustedOrigin?: string;
};

function sameOrigin(url: string | undefined, origin: string): boolean {
    try {
        return url !== undefined && new URL(url).origin === origin;
    } catch {
        return false;
    }
}

/** Reduces `categories` to the host's slug subset, keeping the server's display order. */
function restrictCategories(
    categories: PanelCategory[],
    subset: unknown,
): PanelCategory[] {
    if (!Array.isArray(subset)) {
        return categories;
    }

    const wanted = subset.filter(
        (slug): slug is string => typeof slug === 'string',
    );
    const reduced = categories.filter((c) => wanted.includes(c.slug));

    return reduced.length > 0 ? reduced : categories;
}

export function buildPanelConfig(input: BuildInput): PanelConfig {
    const { boot } = input;
    const overrides = input.overrides ?? {};
    const api = isRecord(boot.api) ? boot.api : {};
    const trusted = input.trustedOrigin;
    const appOrigin = trusted ?? str(api.appOrigin) ?? '';
    const claimedBase = str(api.base);
    const apiBase =
        trusted === undefined
            ? (claimedBase ??
              (appOrigin === '' ? '' : `${appOrigin}/api/v1/public`))
            : sameOrigin(claimedBase, trusted)
              ? (claimedBase as string)
              : `${trusted}/api/v1/public`;
    const rawConfig = isRecord(boot.config) ? boot.config : {};
    const draft = input.draft ?? null;
    const source: Dict = { ...rawConfig, ...draft };

    let theme = sanitizeTheme(source.theme, appOrigin);

    if (isRecord(overrides.theme)) {
        theme = sanitizeTheme(overrides.theme, appOrigin, theme);
    }

    const features = sanitizeFeatures(source.features);

    if (isRecord(overrides.features)) {
        for (const key of FEATURE_KEYS) {
            const value = overrides.features[key];

            if (typeof value === 'boolean') {
                // The loader already enforced "restrict only" except sounds / titleBadge; keep that here for safety.
                features[key] =
                    key === 'sounds' || key === 'titleBadge'
                        ? value
                        : features[key] && value;
            }
        }
    }

    const texts = mergeTexts(
        sanitizeTexts(source.texts),
        sanitizeTexts(overrides.texts),
    );
    const defaultLocale =
        normalizeLocale(overrides.defaultLocale) ??
        normalizeLocale(source.defaultLocale) ??
        'en';
    const { locale, textLocale } = pickLocale({
        texts,
        defaultLocale,
        override: normalizeLocale(overrides.locale),
        detect: bool(source.localeDetect, true),
        navigatorLanguages: input.navigatorLanguages ?? [],
        serverLocale: normalizeLocale(boot.locale),
    });

    const fresh = input.fresh ?? null;
    const freshCategories = categoriesOf(fresh?.categories);
    const bootCategories = categoriesOf(boot.categories);
    const categories = restrictCategories(
        freshCategories.length > 0 ? freshCategories : bootCategories,
        overrides.categories,
    );
    const availability =
        sanitizeAvailability(fresh?.availability) ??
        sanitizeAvailability(boot.availability);

    return {
        key: str(boot.key) ?? '',
        apiBase,
        appOrigin,
        configVersion:
            typeof boot.configVersion === 'number' ? boot.configVersion : 0,
        locale,
        textLocale,
        defaultLocale,
        dir: directionOf(textLocale),
        theme,
        texts,
        features: {
            ...features,
            // WhatsApp is never offered to visitors until P6 turns it on (the resolver forces it to false as well).
            whatsapp:
                features.whatsapp && availability?.whatsapp.enabled === true,
        },
        preChat: sanitizePreChat(source.preChat),
        categories,
        availability,
    };
}

/** Whether `slug` has agents available right now (`true` when availability is unknown). */
export function categoryOnline(config: PanelConfig, slug: string): boolean {
    const entry = config.availability?.categories.find((c) => c.slug === slug);

    return entry === undefined ? true : entry.online;
}

/** The whole widget is closed or has nobody to talk to. `false` when availability is unknown (the server decides). */
export function isOffline(config: PanelConfig): boolean {
    const availability = config.availability;

    return (
        availability !== null && (!availability.openNow || !availability.online)
    );
}

/** Fields the pre-chat form must show; consent counts as a reason to show the form. */
export function needsPreChat(config: PanelConfig): boolean {
    if (!config.features.preChat) {
        return false;
    }

    return (
        PRECHAT_FIELDS.some((name) => config.preChat.fields[name].enabled) ||
        config.preChat.consentText !== null
    );
}
