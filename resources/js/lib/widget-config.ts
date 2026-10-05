/**
 * Pure helpers around the widget config of docs/contracts/widget-config.md: defaults, ranges,
 * clamping, colour contrast, host/URL/time validation and the resolved boot config the preview
 * feeds the real loader. No React, no DOM (except `URL`), so everything is unit tested.
 */
import { FONT_FAMILY, LIMITS, LOCALE_CODE, type Range } from '@/lib/limits';
import { IDLE_TIMEOUT } from '@/lib/setup-flow';
import type {
    BootGreeting,
    CategoryData,
    GreetingData,
    ResolvedBootConfig,
    TextKey,
    WidgetConfigData,
    WidgetPreviewData,
} from '@/types/widgets';

/* -------------------------------------------------------------------------- */
/* Defaults and ranges (the limits themselves live in `@/lib/limits`)          */
/* -------------------------------------------------------------------------- */

export const IDLE_TIMEOUT_DEFAULT = IDLE_TIMEOUT.fallback;

/** `launcherSize` -> pixels (contract: sm 48, md 60, lg 72). */
export const LAUNCHER_PIXELS = { sm: 48, md: 60, lg: 72 } as const;

/** Hosts a custom stylesheet may come from (plus the app's own origin). */
export const FONT_URL_HOSTS = ['fonts.googleapis.com', 'fonts.bunny.net'];

export function clamp(value: number, min: number, max: number): number {
    if (Number.isNaN(value)) {
        return min;
    }

    return Math.min(max, Math.max(min, value));
}

export function clampToRange(value: number, range: Range): number {
    return clamp(Math.round(value), range.min, range.max);
}

/** A whole number inside the range, or `null` for anything else (empty, decimals, text, out of range). */
export function parseBounded(
    raw: string | number,
    range: Range,
): number | null {
    const text = String(raw).trim();

    if (!/^-?\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);

    return value >= range.min && value <= range.max ? value : null;
}

/* -------------------------------------------------------------------------- */
/* Texts                                                                      */
/* -------------------------------------------------------------------------- */

export const TEXT_KEYS: readonly TextKey[] = [
    'title',
    'subtitle',
    'welcome',
    'categoryPrompt',
    'connecting',
    'noAgents',
    'offlineTitle',
    'offlineBody',
    'placeholder',
    'send',
    'attach',
    'endChat',
    'ratingTitle',
    'ratingPlaceholder',
    'thanks',
    'startNewChat',
    'poweredBy',
    'closeChat',
    'unread',
    'dismiss',
];

/** Built-in English: the last fallback of the widget itself. */
export const DEFAULT_TEXTS_EN: Record<TextKey, string> = {
    title: 'Support',
    subtitle: 'We usually reply in a few minutes',
    welcome: 'Hi! How can we help you today?',
    categoryPrompt: 'What do you need help with?',
    connecting: 'Connecting you to an agent…',
    noAgents: 'No agent is available right now.',
    offlineTitle: 'Leave us a message',
    offlineBody: "We'll get back to you by email.",
    placeholder: 'Type your message…',
    send: 'Send',
    attach: 'Attach image',
    endChat: 'End chat',
    ratingTitle: 'How was this chat?',
    ratingPlaceholder: 'Add a comment (optional)',
    thanks: 'Thanks for your feedback!',
    startNewChat: 'Start a new chat',
    poweredBy: 'Powered by PNE Chat',
    closeChat: 'Close chat',
    unread: 'unread messages',
    dismiss: 'Dismiss',
};

/** Keys that are long-form (rendered as a textarea). */
export const LONG_TEXT_KEYS: ReadonlySet<TextKey> = new Set([
    'welcome',
    'offlineBody',
]);

/** Locale -> key lookup with the widget's own fallback chain: locale, default locale, built-in English. */
export function resolveText(
    config: Pick<WidgetConfigData, 'texts' | 'defaultLocale'>,
    locale: string,
    key: TextKey,
): string {
    return (
        nonEmpty(config.texts[locale]?.[key]) ??
        nonEmpty(config.texts[config.defaultLocale]?.[key]) ??
        DEFAULT_TEXTS_EN[key]
    );
}

function nonEmpty(value: string | undefined): string | undefined {
    return value !== undefined && value !== '' ? value : undefined;
}

/** Default locale first, then the other locales alphabetically. */
export function configLocales(
    config: Pick<WidgetConfigData, 'texts' | 'defaultLocale'>,
): string[] {
    const others = Object.keys(config.texts)
        .filter((code) => code !== config.defaultLocale)
        .sort();

    return [config.defaultLocale, ...others];
}

/** Exactly what the server accepts for a locale (no trimming: the server does not trim either). */
export function isLocaleCode(code: string): boolean {
    return LOCALE_CODE.test(code);
}

/** The CSS font stack allowed in `theme.fontFamily` (the server rejects `;{}()<>:\\`). */
export function isFontFamily(value: string): boolean {
    return FONT_FAMILY.test(value);
}

/** Common widget locales offered as suggestions when adding a language. */
export const LOCALE_SUGGESTIONS = [
    'ar',
    'de',
    'es',
    'fa',
    'fr',
    'he',
    'it',
    'ja',
    'nl',
    'pl',
    'pt',
    'pt-BR',
    'ru',
    'tr',
    'ur',
    'zh',
];

/* -------------------------------------------------------------------------- */
/* Defaults                                                                   */
/* -------------------------------------------------------------------------- */

export function defaultWidgetConfig(): WidgetConfigData {
    return {
        v: 1,
        defaultLocale: 'en',
        localeDetect: true,
        theme: {
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
        texts: { en: { ...DEFAULT_TEXTS_EN } },
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
        preChat: {
            fields: {
                name: { enabled: true, required: true },
                email: { enabled: true, required: false },
                phone: { enabled: false, required: false },
            },
            consentText: null,
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
        hours: {
            mode: 'auto_hours',
            timezone: 'UTC',
            schedule: [
                { day: 1, start: '09:00', end: '17:00' },
                { day: 2, start: '09:00', end: '17:00' },
                { day: 3, start: '09:00', end: '17:00' },
                { day: 4, start: '09:00', end: '17:00' },
                { day: 5, start: '09:00', end: '17:00' },
            ],
            holidays: [],
        },
        routing: {
            waves: [
                { afterSeconds: 0, statuses: ['online'] },
                { afterSeconds: 20, statuses: ['away'] },
            ],
            wakeOfflineViaPush: false,
            queueTimeoutSeconds: 90,
        },
        session: { idleTimeoutMinutes: IDLE_TIMEOUT_DEFAULT },
    };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Deep merge where `source` wins; arrays and primitives are replaced, never merged. */
function mergeDeep(base: unknown, source: unknown): unknown {
    if (!isPlainObject(base) || !isPlainObject(source)) {
        return source === undefined ? base : source;
    }

    const result: Record<string, unknown> = { ...base };

    for (const [key, value] of Object.entries(source)) {
        result[key] = key in base ? mergeDeep(base[key], value) : value;
    }

    return result;
}

/** Fills whatever the server (or an older draft) left out with the contract defaults. */
export function withConfigDefaults(
    partial: Partial<WidgetConfigData> | null | undefined,
): WidgetConfigData {
    const merged = mergeDeep(
        defaultWidgetConfig(),
        partial ?? {},
    ) as WidgetConfigData;

    // `texts` is keyed by locale: never merge the English defaults into other locales, and make
    // sure the default locale has a block so the editor can show it.
    if (partial?.texts) {
        merged.texts = structuredClone(partial.texts);
    }

    return normaliseHolidays(merged);
}

/**
 * The server stores a blank holiday name as `null`. The editor works with strings only, so a
 * missing label becomes `''` here (and a malformed entry is dropped instead of crashing later).
 */
export function normaliseHolidays(config: WidgetConfigData): WidgetConfigData {
    const holidays: unknown = config.hours?.holidays;

    if (!Array.isArray(holidays)) {
        return config;
    }

    return {
        ...config,
        hours: {
            ...config.hours,
            holidays: holidays
                .filter(
                    (holiday): holiday is { date: unknown; label?: unknown } =>
                        typeof holiday === 'object' && holiday !== null,
                )
                .map((holiday) => ({
                    date: typeof holiday.date === 'string' ? holiday.date : '',
                    label:
                        typeof holiday.label === 'string' ? holiday.label : '',
                })),
        },
    };
}

/* -------------------------------------------------------------------------- */
/* Colour                                                                     */
/* -------------------------------------------------------------------------- */

const HEX = /^#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** 3, 6 or 8 digit hex with a leading `#` (the only colour syntax the config accepts). */
export function isHexColor(value: string): boolean {
    return HEX.test(value.trim());
}

export type Rgb = { r: number; g: number; b: number; a: number };

export function parseHexColor(value: string): Rgb | null {
    const hex = value.trim();

    if (!HEX.test(hex)) {
        return null;
    }

    let digits = hex.slice(1);

    if (digits.length === 3) {
        digits = digits
            .split('')
            .map((digit) => digit + digit)
            .join('');
    }

    return {
        r: parseInt(digits.slice(0, 2), 16),
        g: parseInt(digits.slice(2, 4), 16),
        b: parseInt(digits.slice(4, 6), 16),
        a: digits.length === 8 ? parseInt(digits.slice(6, 8), 16) / 255 : 1,
    };
}

/** `<input type="color">` only understands `#rrggbb`. */
export function toColorInputValue(value: string, fallback = '#000000'): string {
    const rgb = parseHexColor(value);

    if (!rgb) {
        return fallback;
    }

    const part = (channel: number) => channel.toString(16).padStart(2, '0');

    return `#${part(rgb.r)}${part(rgb.g)}${part(rgb.b)}`;
}

function channelLuminance(channel: number): number {
    const srgb = channel / 255;

    return srgb <= 0.03928 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(rgb: Rgb): number {
    return (
        0.2126 * channelLuminance(rgb.r) +
        0.7152 * channelLuminance(rgb.g) +
        0.0722 * channelLuminance(rgb.b)
    );
}

/** WCAG 2.x contrast ratio (1..21), `null` when either colour is not a valid hex. Alpha is ignored. */
export function contrastRatio(a: string, b: string): number | null {
    const first = parseHexColor(a);
    const second = parseHexColor(b);

    if (!first || !second) {
        return null;
    }

    const [light, dark] = [
        relativeLuminance(first),
        relativeLuminance(second),
    ].sort((x, y) => y - x);

    return (light + 0.05) / (dark + 0.05);
}

export type ContrastGrade = 'aaa' | 'aa' | 'large' | 'fail';

/** aaa >= 7, aa >= 4.5, large (large text / UI components only) >= 3, otherwise fail. */
export function contrastGrade(ratio: number): ContrastGrade {
    if (ratio >= 7) {
        return 'aaa';
    }

    if (ratio >= 4.5) {
        return 'aa';
    }

    return ratio >= 3 ? 'large' : 'fail';
}

export function formatRatio(ratio: number): string {
    return `${(Math.floor(ratio * 10) / 10).toFixed(1)}:1`;
}

/** Whichever of near-black / white reads better on `background`. */
export function readableTextOn(background: string): '#ffffff' | '#0f172a' {
    const onWhite = contrastRatio(background, '#ffffff') ?? 1;
    const onDark = contrastRatio(background, '#0f172a') ?? 1;

    return onWhite >= onDark ? '#ffffff' : '#0f172a';
}

/* -------------------------------------------------------------------------- */
/* URLs, hosts, times                                                         */
/* -------------------------------------------------------------------------- */

/** `https:` only (the contract also allows same-origin relative paths; those start with a single `/`). */
export function isSecureUrl(value: string): boolean {
    const text = value.trim();

    if (text.startsWith('/') && !text.startsWith('//')) {
        return true;
    }

    try {
        return new URL(text).protocol === 'https:';
    } catch {
        return false;
    }
}

/** Font stylesheet: https and one of the allowed hosts (or the dashboard's own origin / a relative path). */
export function isAllowedFontUrl(value: string, ownOrigin: string): boolean {
    const text = value.trim();

    if (text.startsWith('/') && !text.startsWith('//')) {
        return true;
    }

    try {
        const url = new URL(text);

        return (
            url.protocol === 'https:' &&
            (FONT_URL_HOSTS.includes(url.hostname) || url.origin === ownOrigin)
        );
    } catch {
        return false;
    }
}

export type DomainProblem =
    | 'empty'
    | 'scheme'
    | 'path'
    | 'userinfo'
    | 'wildcard'
    | 'port'
    | 'invalid';

export type DomainCheck =
    | { ok: true; value: string }
    | { ok: false; reason: DomainProblem };

const LABEL = /^[a-z0-9_]([a-z0-9_-]*[a-z0-9_])?$/i;

/**
 * Mirrors the server rules (contract): lower-case host, punycode, no path / userinfo, `*.` only as the first label,
 * optional port. An `https://` prefix is dropped (https is the default), an `http://` prefix is kept: it is the
 * admin's explicit permission for a site served without https (OriginMatcher). The server stays the authority.
 */
export function normaliseDomainEntry(raw: string): DomainCheck {
    let text = raw.trim().toLowerCase();

    if (text === '') {
        return { ok: false, reason: 'empty' };
    }

    if (text.length > LIMITS.domainEntryLength) {
        return { ok: false, reason: 'invalid' };
    }

    const prefix = /^(https?):\/\//.exec(text);

    if (prefix) {
        text = text.slice(prefix[0].length);
    }

    const plainHttp = prefix?.[1] === 'http';

    if (text.includes('://') || /^[a-z][a-z0-9+.-]*:\/\//.test(text)) {
        return { ok: false, reason: 'scheme' };
    }

    if (text.includes('@')) {
        return { ok: false, reason: 'userinfo' };
    }

    if (/[/?#\\]/.test(text)) {
        return { ok: false, reason: 'path' };
    }

    const wildcard = text.startsWith('*.');
    const rest = wildcard ? text.slice(2) : text;

    if (rest.includes('*')) {
        return { ok: false, reason: 'wildcard' };
    }

    const [hostPart, portPart, ...extra] = rest.split(':');

    if (extra.length > 0 || hostPart === '') {
        return { ok: false, reason: hostPart === '' ? 'invalid' : 'port' };
    }

    if (portPart !== undefined) {
        const port = Number(portPart);

        if (!/^\d{1,5}$/.test(portPart) || port < 1 || port > 65535) {
            return { ok: false, reason: 'port' };
        }
    }

    let host = hostPart;

    try {
        host = new URL(`http://${hostPart}`).hostname;
    } catch {
        return { ok: false, reason: 'invalid' };
    }

    const labels = host.split('.');

    if (host.length > 253 || labels.some((label) => !LABEL.test(label))) {
        return { ok: false, reason: 'invalid' };
    }

    if (wildcard && labels.length < 2) {
        return { ok: false, reason: 'wildcard' };
    }

    const value = `${plainHttp ? 'http://' : ''}${wildcard ? '*.' : ''}${host}${portPart !== undefined ? `:${Number(portPart)}` : ''}`;

    return { ok: true, value };
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isTime(value: string): boolean {
    return TIME.test(value);
}

/** A closing time may also be `24:00` (end of day): the server accepts it, `<input type="time">` cannot show it. */
export function isClosingTime(value: string): boolean {
    return value === '24:00' || TIME.test(value);
}

export function minutesToTime(minutes: number): string {
    const clamped = Math.min(23 * 60 + 59, Math.max(0, Math.round(minutes)));
    const hours = Math.floor(clamped / 60);
    const rest = clamped % 60;

    return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

export function timeToMinutes(value: string): number {
    const [hours, minutes] = value.split(':').map(Number);

    return hours * 60 + minutes;
}

export function isIsoDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(`${value}T00:00:00Z`);

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

/** Monday first, Sunday last (contract: 0 = Sunday .. 6 = Saturday). */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** Localised weekday name for the contract's day number. */
export function weekdayName(
    day: number,
    locale: string,
    width: 'long' | 'short' = 'long',
): string {
    // 2024-01-07 was a Sunday.
    const date = new Date(Date.UTC(2024, 0, 7 + day));

    try {
        return new Intl.DateTimeFormat(locale, {
            weekday: width,
            timeZone: 'UTC',
        }).format(date);
    } catch {
        return new Intl.DateTimeFormat('en', {
            weekday: width,
            timeZone: 'UTC',
        }).format(date);
    }
}

/* -------------------------------------------------------------------------- */
/* Greetings & categories                                                     */
/* -------------------------------------------------------------------------- */

export function toBootGreeting(
    greeting: Pick<
        GreetingData,
        'body' | 'agent_name' | 'agent_avatar_url' | 'locale' | 'weight'
    > & { id: string },
): BootGreeting {
    return {
        id: greeting.id,
        body: greeting.body,
        agentName: greeting.agent_name,
        agentAvatarUrl: greeting.agent_avatar_url,
        locale: greeting.locale,
        weight: greeting.weight,
    };
}

/** Name of a category in `locale` (per-locale override, else the base name). */
export function categoryLabel(category: CategoryData, locale: string): string {
    const base = locale.replace('_', '-');

    return (
        category.name_i18n[base] ??
        category.name_i18n[base.split('-')[0]] ??
        category.name
    );
}

/* -------------------------------------------------------------------------- */
/* Boot config for the preview                                                */
/* -------------------------------------------------------------------------- */

/** The config as the client sees it (policy-only `routing` / `session` stay server-side). */
export function toClientConfig(
    config: WidgetConfigData,
): ResolvedBootConfig['config'] {
    const { routing: _routing, session: _session, ...client } = config;

    return client;
}

/** `?preview=1` is what unlocks `draft` messages in the iframe; make sure it is there. */
export function withPreviewFlag(embedUrl: string, appOrigin: string): string {
    try {
        const url = new URL(embedUrl, appOrigin);

        url.searchParams.set('preview', '1');

        return url.toString();
    } catch {
        return embedUrl;
    }
}

export function buildPreviewBoot(input: {
    key: string;
    configVersion: number;
    config: WidgetConfigData;
    greetings: (Pick<
        GreetingData,
        | 'body'
        | 'agent_name'
        | 'agent_avatar_url'
        | 'locale'
        | 'weight'
        | 'is_active'
    > & { id: string })[];
    categories: { slug: string; label: string }[];
    preview: WidgetPreviewData;
    now?: Date;
}): ResolvedBootConfig {
    const { preview } = input;

    return {
        v: 1,
        key: input.key,
        configVersion: input.configVersion,
        generatedAt: (input.now ?? new Date()).toISOString(),
        api: {
            base: `${preview.app_origin}/api/v1/public`,
            embed: withPreviewFlag(preview.embed_url, preview.app_origin),
            appOrigin: preview.app_origin,
        },
        config: toClientConfig(input.config),
        greetings: input.greetings
            .filter(
                (greeting) => greeting.is_active && greeting.body.trim() !== '',
            )
            .map(toBootGreeting),
        categories: input.categories,
        availability: {
            online: true,
            openNow: true,
            nextOpenAt: null,
            whatsapp: { enabled: input.config.features.whatsapp },
        },
    };
}
