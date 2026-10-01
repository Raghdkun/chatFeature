/**
 * State of the widget builder: one reducer, the draft `config` object as the single source of
 * truth, dirty tracking per saved slice and field-error mapping. Pure (no React, no fetch) so the
 * whole editing model is unit tested; the hook (`use-widget-builder.ts`) only wires it to the API.
 *
 * The editor works on five *slices*, each persisted by its own endpoint (docs/contracts/dashboard-pages-p3.md):
 *
 *   settings    PATCH /widgets/{ulid}            (live columns: name, enabled, locale, timeouts, ...)
 *   config      PUT   /widgets/{ulid}/draft      (the draft config; only visitors after Publish)
 *   greetings   PUT   /widgets/{ulid}/greetings
 *   domains     PUT   /widgets/{ulid}/domains
 *   categories  PUT   /widgets/{ulid}/categories
 */
import type { ApiFieldErrors } from '@/lib/api-client';
import { LIMITS } from '@/lib/limits';
import {
    clampToRange,
    defaultWidgetConfig,
    isAllowedFontUrl,
    isFontFamily,
    isHexColor,
    isClosingTime,
    isIsoDate,
    isLocaleCode,
    isSecureUrl,
    isTime,
    minutesToTime,
    normaliseDomainEntry,
    timeToMinutes,
    withConfigDefaults,
    type DomainProblem,
} from '@/lib/widget-config';
import type {
    ConfigSectionKey,
    GreetingData,
    Holiday,
    HoursRange,
    PreChatFieldConfig,
    PreChatFieldKey,
    TextKey,
    WidgetBuilderData,
    WidgetConfigData,
    WidgetData,
} from '@/types/widgets';

/* -------------------------------------------------------------------------- */
/* Types                                                                      */
/* -------------------------------------------------------------------------- */

export type SettingsKey =
    | 'name'
    | 'is_enabled'
    | 'locale'
    | 'idle_timeout_minutes'
    | 'queue_timeout_seconds'
    | 'offline_mode'
    | 'timezone'
    | 'allow_non_browser_clients';

export type BuilderSettings = Pick<WidgetData, SettingsKey>;

/** A greeting in the editor. New ones have `ulid: null`; `clientId` is the stable React/key identity. */
export type GreetingDraft = {
    clientId: string;
    ulid: string | null;
    body: string;
    agent_name: string | null;
    agent_avatar_url: string | null;
    locale: string | null;
    weight: number;
    is_active: boolean;
};

export type BuilderDoc = {
    settings: BuilderSettings;
    config: WidgetConfigData;
    greetings: GreetingDraft[];
    domains: string[];
    categoryUlids: string[];
};

export type SliceName =
    | 'settings'
    | 'config'
    | 'greetings'
    | 'domains'
    | 'categories';

export const SLICES: readonly SliceName[] = [
    'settings',
    'config',
    'greetings',
    'domains',
    'categories',
];

/**
 * Slices that reach visitors the moment they are saved (their own endpoints write live data);
 * only `config` is a draft that waits for Publish.
 */
export const LIVE_SLICES: readonly SliceName[] = [
    'settings',
    'greetings',
    'domains',
    'categories',
];

export type BuilderTab =
    | 'general'
    | 'branding'
    | 'texts'
    | 'features'
    | 'greetings'
    | 'hours'
    | 'domains'
    | 'categories'
    | 'embed';

export const BUILDER_TABS: readonly BuilderTab[] = [
    'general',
    'branding',
    'texts',
    'features',
    'greetings',
    'hours',
    'domains',
    'categories',
    'embed',
];

export type FieldErrors = Record<string, string[]>;

export type BuilderMeta = {
    ulid: string;
    publicKey: string;
    configVersion: number;
    hasUnpublishedChanges: boolean;
    hasIdentitySecret: boolean;
    whatsappConnected: boolean;
    updatedAt: string;
};

export type BuilderState = {
    doc: BuilderDoc;
    /** What the server has for each slice (baseline for dirty tracking). */
    saved: BuilderDoc;
    /** The config visitors currently get (to know whether Publish has anything to do). */
    published: WidgetConfigData;
    errors: FieldErrors;
    meta: BuilderMeta;
};

/* -------------------------------------------------------------------------- */
/* Equality                                                                   */
/* -------------------------------------------------------------------------- */

export function deepEqual(a: unknown, b: unknown): boolean {
    if (Object.is(a, b)) {
        return true;
    }

    if (
        typeof a !== 'object' ||
        typeof b !== 'object' ||
        a === null ||
        b === null
    ) {
        return false;
    }

    if (Array.isArray(a) !== Array.isArray(b)) {
        return false;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
        return (
            a.length === b.length && a.every((item, i) => deepEqual(item, b[i]))
        );
    }

    const left = a as Record<string, unknown>;
    const right = b as Record<string, unknown>;
    const keys = Object.keys(left);

    return (
        keys.length === Object.keys(right).length &&
        keys.every((key) => key in right && deepEqual(left[key], right[key]))
    );
}

/* -------------------------------------------------------------------------- */
/* Construction                                                               */
/* -------------------------------------------------------------------------- */

export function toGreetingDraft(greeting: GreetingData): GreetingDraft {
    return {
        clientId: greeting.ulid,
        ulid: greeting.ulid,
        body: greeting.body,
        agent_name: greeting.agent_name,
        agent_avatar_url: greeting.agent_avatar_url,
        locale: greeting.locale,
        weight: greeting.weight,
        is_active: greeting.is_active,
    };
}

export function settingsOf(widget: WidgetData): BuilderSettings {
    return {
        name: widget.name,
        is_enabled: widget.is_enabled,
        locale: widget.locale,
        idle_timeout_minutes: widget.idle_timeout_minutes,
        queue_timeout_seconds: widget.queue_timeout_seconds,
        offline_mode: widget.offline_mode,
        timezone: widget.timezone,
        allow_non_browser_clients: widget.allow_non_browser_clients,
    };
}

export function metaOf(widget: WidgetData): BuilderMeta {
    return {
        ulid: widget.ulid,
        publicKey: widget.public_key,
        configVersion: widget.config_version,
        hasUnpublishedChanges: widget.has_unpublished_changes,
        hasIdentitySecret: widget.has_identity_secret,
        whatsappConnected: widget.whatsapp_connected,
        updatedAt: widget.updated_at,
    };
}

export function createBuilderState(data: WidgetBuilderData): BuilderState {
    const doc: BuilderDoc = {
        settings: settingsOf(data.widget),
        config: withConfigDefaults(data.draft_config),
        greetings: [...data.greetings]
            .sort((a, b) => a.sort_order - b.sort_order)
            .map(toGreetingDraft),
        domains: [...data.domains],
        categoryUlids: [...data.category_ulids],
    };

    return {
        doc,
        saved: structuredClone(doc),
        published: withConfigDefaults(data.config),
        errors: {},
        meta: metaOf(data.widget),
    };
}

/* -------------------------------------------------------------------------- */
/* Actions                                                                    */
/* -------------------------------------------------------------------------- */

type SettingsAction = {
    [K in SettingsKey]: {
        type: 'settings/set';
        key: K;
        value: BuilderSettings[K];
    };
}[SettingsKey];

type SectionAction = {
    [S in ConfigSectionKey]: {
        type: 'config/section';
        section: S;
        patch: Partial<WidgetConfigData[S]>;
    };
}[ConfigSectionKey];

type GreetingPatch = Partial<Omit<GreetingDraft, 'clientId' | 'ulid'>>;

export type BuilderAction =
    | SettingsAction
    | SectionAction
    | { type: 'config/root'; patch: { localeDetect: boolean } }
    | {
          type: 'prechat/field';
          field: PreChatFieldKey;
          patch: Partial<PreChatFieldConfig>;
      }
    | { type: 'prechat/consent'; text: string | null }
    | { type: 'texts/set'; locale: string; key: TextKey; value: string }
    | { type: 'texts/add-locale'; locale: string }
    | { type: 'texts/remove-locale'; locale: string }
    | { type: 'hours/add-range'; day: number }
    | { type: 'hours/update-range'; index: number; patch: Partial<HoursRange> }
    | { type: 'hours/remove-range'; index: number }
    | { type: 'hours/set-schedule'; schedule: HoursRange[] }
    | { type: 'hours/add-holiday' }
    | { type: 'hours/update-holiday'; index: number; patch: Partial<Holiday> }
    | { type: 'hours/remove-holiday'; index: number }
    | { type: 'greetings/add'; clientId: string }
    | { type: 'greetings/update'; clientId: string; patch: GreetingPatch }
    | { type: 'greetings/remove'; clientId: string }
    | { type: 'greetings/move'; clientId: string; direction: -1 | 1 }
    | { type: 'domains/add'; value: string }
    | { type: 'domains/remove'; value: string }
    | { type: 'categories/toggle'; ulid: string }
    | { type: 'categories/move'; ulid: string; direction: -1 | 1 }
    | {
          type: 'saved';
          slice: SliceName;
          /** What was sent (the slice as of the request). */
          snapshot: BuilderDoc[keyof BuilderDoc];
          /** What the server answered, when it normalised the slice (e.g. domains, greeting ulids). */
          normalised?: BuilderDoc[keyof BuilderDoc];
      }
    | { type: 'published'; widget: WidgetData }
    /** The widget was taken live / offline (its own request, never part of "Save draft"). */
    | { type: 'enabled'; value: boolean }
    | { type: 'meta'; patch: Partial<BuilderMeta> }
    | { type: 'errors/set'; errors: FieldErrors }
    | { type: 'errors/clear'; prefix?: string };

/** Typed constructors: the discriminated unions above need a cast the call sites should not repeat. */
export function settingAction<K extends SettingsKey>(
    key: K,
    value: BuilderSettings[K],
): BuilderAction {
    return { type: 'settings/set', key, value } as BuilderAction;
}

export function sectionAction<S extends ConfigSectionKey>(
    section: S,
    patch: Partial<WidgetConfigData[S]>,
): BuilderAction {
    return { type: 'config/section', section, patch } as BuilderAction;
}

/** First range of a day: the usual office hours. */
const FIRST_RANGE = { start: '09:00', end: '17:00' } as const;

/** Latest bedtime for an automatically proposed range: leaves room for at least one more minute. */
const LAST_AUTO_START = 22 * 60 + 59;

function closingMinutes(range: HoursRange): number {
    return isClosingTime(range.end) ? timeToMinutes(range.end) : 0;
}

/**
 * The range "Add hours" proposes for `day`. A day without hours gets 09:00-17:00; a day that
 * already has hours gets a range after the latest one (never a copy of an existing range, which
 * the server rejects as an overlap). `null` when the day has no room left.
 */
export function nextRangeFor(
    schedule: readonly HoursRange[],
    day: number,
): HoursRange | null {
    const existing = schedule.filter((range) => range.day === day);

    if (existing.length === 0) {
        return { day, ...FIRST_RANGE };
    }

    const lastEnd = Math.max(...existing.map(closingMinutes));

    if (lastEnd > LAST_AUTO_START) {
        return null;
    }

    const start = Math.min(lastEnd + 60, LAST_AUTO_START);

    return {
        day,
        start: minutesToTime(start),
        end: minutesToTime(Math.min(start + 4 * 60, 23 * 60 + 59)),
    };
}

/** Can "Add hours" still propose a valid range for this day? */
export function canAddRange(
    schedule: readonly HoursRange[],
    day: number,
): boolean {
    return nextRangeFor(schedule, day) !== null;
}

function moveItem<T>(items: T[], from: number, direction: -1 | 1): T[] {
    const to = from + direction;

    if (from < 0 || to < 0 || to >= items.length) {
        return items;
    }

    const next = [...items];

    [next[from], next[to]] = [next[to], next[from]];

    return next;
}

function withDoc(state: BuilderState, doc: BuilderDoc): BuilderState {
    return { ...state, doc };
}

function withConfig(
    state: BuilderState,
    update: (config: WidgetConfigData) => WidgetConfigData,
): BuilderState {
    return withDoc(state, { ...state.doc, config: update(state.doc.config) });
}

/**
 * The five operational settings that exist twice: as widget columns (the settings PATCH) and as
 * fields of the config object (`ConfigMirror::PATHS` on the server). The server keeps both copies
 * in step; so does the builder.
 */
export const MIRRORED_SETTINGS = [
    'locale',
    'idle_timeout_minutes',
    'queue_timeout_seconds',
    'offline_mode',
    'timezone',
] as const satisfies readonly SettingsKey[];

export type MirroredSetting = (typeof MIRRORED_SETTINGS)[number];

/** Where the server reports a problem with the mirrored copy of a setting (`ConfigMirror::PATHS`). */
export const MIRROR_ERROR_PATHS: Record<MirroredSetting, string> = {
    locale: 'config.defaultLocale',
    idle_timeout_minutes: 'config.session.idleTimeoutMinutes',
    queue_timeout_seconds: 'config.routing.queueTimeoutSeconds',
    offline_mode: 'config.hours.mode',
    timezone: 'config.hours.timezone',
};

function isMirrored(key: SettingsKey): key is MirroredSetting {
    return (MIRRORED_SETTINGS as readonly string[]).includes(key);
}

/** Writes one setting's value into its mirrored config field (other keys leave the config alone). */
function applyMirror(
    config: WidgetConfigData,
    key: SettingsKey,
    value: unknown,
): WidgetConfigData {
    switch (key) {
        case 'locale':
            return { ...config, defaultLocale: value as string };
        case 'idle_timeout_minutes':
            return {
                ...config,
                session: { idleTimeoutMinutes: value as number },
            };
        case 'queue_timeout_seconds':
            return {
                ...config,
                routing: {
                    ...config.routing,
                    queueTimeoutSeconds: value as number,
                },
            };
        case 'offline_mode':
            return {
                ...config,
                hours: {
                    ...config.hours,
                    mode: value as WidgetConfigData['hours']['mode'],
                },
            };
        case 'timezone':
            return {
                ...config,
                hours: { ...config.hours, timezone: value as string },
            };
        default:
            return config;
    }
}

/** Drop a field error as soon as the field is edited again (prefix match on the dotted path). */
function clearErrorsFor(errors: FieldErrors, prefixes: string[]): FieldErrors {
    if (Object.keys(errors).length === 0) {
        return errors;
    }

    const next: FieldErrors = {};
    let changed = false;

    for (const [path, messages] of Object.entries(errors)) {
        if (
            prefixes.some(
                (prefix) => path === prefix || path.startsWith(`${prefix}.`),
            )
        ) {
            changed = true;

            continue;
        }

        next[path] = messages;
    }

    return changed ? next : errors;
}

/** Which error paths an action invalidates (the field was edited). */
function touchedPaths(action: BuilderAction): string[] {
    switch (action.type) {
        case 'settings/set':
            return isMirrored(action.key)
                ? [`settings.${action.key}`, MIRROR_ERROR_PATHS[action.key]]
                : [`settings.${action.key}`];
        case 'config/section':
            return Object.keys(action.patch).map(
                (key) => `config.${action.section}.${key}`,
            );
        case 'config/root':
            return ['config.localeDetect'];
        case 'prechat/field':
            return [`config.preChat.fields.${action.field}`];
        case 'prechat/consent':
            return ['config.preChat.consentText'];
        case 'texts/set':
        case 'texts/add-locale':
        case 'texts/remove-locale':
            return [`config.texts.${action.locale}`];
        case 'hours/add-range':
        case 'hours/update-range':
        case 'hours/remove-range':
        case 'hours/set-schedule':
            return ['config.hours.schedule'];
        case 'hours/add-holiday':
        case 'hours/update-holiday':
        case 'hours/remove-holiday':
            return ['config.hours.holidays'];
        case 'greetings/add':
        case 'greetings/update':
        case 'greetings/remove':
        case 'greetings/move':
            return ['greetings'];
        case 'domains/add':
        case 'domains/remove':
            return ['domains'];
        case 'categories/toggle':
        case 'categories/move':
            return ['categories'];
        default:
            return [];
    }
}

function reduceDoc(state: BuilderState, action: BuilderAction): BuilderState {
    const { doc } = state;

    switch (action.type) {
        case 'settings/set': {
            const next: BuilderDoc = {
                ...doc,
                settings: { ...doc.settings, [action.key]: action.value },
                config: applyMirror(doc.config, action.key, action.value),
            };

            return withDoc(state, next);
        }

        case 'config/section':
            return withConfig(state, (config) => ({
                ...config,
                [action.section]: {
                    ...config[action.section],
                    ...action.patch,
                },
            }));

        case 'config/root':
            return withConfig(state, (config) => ({
                ...config,
                ...action.patch,
            }));

        case 'prechat/field':
            return withConfig(state, (config) => ({
                ...config,
                preChat: {
                    ...config.preChat,
                    fields: {
                        ...config.preChat.fields,
                        [action.field]: {
                            ...config.preChat.fields[action.field],
                            ...action.patch,
                        },
                    },
                },
            }));

        case 'prechat/consent':
            return withConfig(state, (config) => ({
                ...config,
                preChat: { ...config.preChat, consentText: action.text },
            }));

        case 'texts/set':
            return withConfig(state, (config) => {
                const block = { ...config.texts[action.locale] };

                if (action.value === '') {
                    delete block[action.key];
                } else {
                    block[action.key] = action.value;
                }

                return {
                    ...config,
                    texts: { ...config.texts, [action.locale]: block },
                };
            });

        case 'texts/add-locale':
            if (action.locale in doc.config.texts) {
                return state;
            }

            return withConfig(state, (config) => ({
                ...config,
                texts: { ...config.texts, [action.locale]: {} },
            }));

        case 'texts/remove-locale': {
            if (action.locale === doc.config.defaultLocale) {
                return state;
            }

            return withConfig(state, (config) => {
                const texts = { ...config.texts };

                delete texts[action.locale];

                return { ...config, texts };
            });
        }

        case 'hours/add-range': {
            const range = nextRangeFor(doc.config.hours.schedule, action.day);

            if (range === null) {
                return state;
            }

            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    schedule: [...config.hours.schedule, range],
                },
            }));
        }

        case 'hours/update-range':
            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    schedule: config.hours.schedule.map((range, index) =>
                        index === action.index
                            ? { ...range, ...action.patch }
                            : range,
                    ),
                },
            }));

        case 'hours/remove-range':
            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    schedule: config.hours.schedule.filter(
                        (_, index) => index !== action.index,
                    ),
                },
            }));

        case 'hours/set-schedule':
            return withConfig(state, (config) => ({
                ...config,
                hours: { ...config.hours, schedule: action.schedule },
            }));

        case 'hours/add-holiday':
            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    holidays: [
                        ...config.hours.holidays,
                        { date: '', label: '' },
                    ],
                },
            }));

        case 'hours/update-holiday':
            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    holidays: config.hours.holidays.map((holiday, index) =>
                        index === action.index
                            ? { ...holiday, ...action.patch }
                            : holiday,
                    ),
                },
            }));

        case 'hours/remove-holiday':
            return withConfig(state, (config) => ({
                ...config,
                hours: {
                    ...config.hours,
                    holidays: config.hours.holidays.filter(
                        (_, index) => index !== action.index,
                    ),
                },
            }));

        case 'greetings/add':
            return withDoc(state, {
                ...doc,
                greetings: [
                    ...doc.greetings,
                    {
                        clientId: action.clientId,
                        ulid: null,
                        body: '',
                        agent_name: null,
                        agent_avatar_url: null,
                        locale: null,
                        weight: 1,
                        is_active: true,
                    },
                ],
            });

        case 'greetings/update':
            return withDoc(state, {
                ...doc,
                greetings: doc.greetings.map((greeting) =>
                    greeting.clientId === action.clientId
                        ? { ...greeting, ...action.patch }
                        : greeting,
                ),
            });

        case 'greetings/remove':
            return withDoc(state, {
                ...doc,
                greetings: doc.greetings.filter(
                    (greeting) => greeting.clientId !== action.clientId,
                ),
            });

        case 'greetings/move':
            return withDoc(state, {
                ...doc,
                greetings: moveItem(
                    doc.greetings,
                    doc.greetings.findIndex(
                        (greeting) => greeting.clientId === action.clientId,
                    ),
                    action.direction,
                ),
            });

        case 'domains/add':
            return doc.domains.includes(action.value)
                ? state
                : withDoc(state, {
                      ...doc,
                      domains: [...doc.domains, action.value],
                  });

        case 'domains/remove':
            return withDoc(state, {
                ...doc,
                domains: doc.domains.filter(
                    (domain) => domain !== action.value,
                ),
            });

        case 'categories/toggle':
            return withDoc(state, {
                ...doc,
                categoryUlids: doc.categoryUlids.includes(action.ulid)
                    ? doc.categoryUlids.filter((ulid) => ulid !== action.ulid)
                    : [...doc.categoryUlids, action.ulid],
            });

        case 'categories/move':
            return withDoc(state, {
                ...doc,
                categoryUlids: moveItem(
                    doc.categoryUlids,
                    doc.categoryUlids.indexOf(action.ulid),
                    action.direction,
                ),
            });

        default:
            return state;
    }
}

function sliceKey(slice: SliceName): keyof BuilderDoc {
    return slice === 'categories' ? 'categoryUlids' : slice;
}

export function builderReducer(
    state: BuilderState,
    action: BuilderAction,
): BuilderState {
    switch (action.type) {
        case 'saved': {
            const key = sliceKey(action.slice);
            const baseline = (action.normalised ?? action.snapshot) as never;
            const stillCurrent = deepEqual(state.doc[key], action.snapshot);
            let saved = { ...state.saved, [key]: structuredClone(baseline) };
            let published = state.published;
            const doc = stillCurrent
                ? { ...state.doc, [key]: structuredClone(baseline) }
                : state.doc;

            if (action.slice === 'settings') {
                // The server writes a changed setting into BOTH the draft and the published config
                // (ConfigMirror): without the same here "Publish" would offer a version bump for nothing.
                const sent = action.snapshot as BuilderSettings;

                for (const setting of MIRRORED_SETTINGS) {
                    if (
                        !deepEqual(state.saved.settings[setting], sent[setting])
                    ) {
                        published = applyMirror(
                            published,
                            setting,
                            sent[setting],
                        );
                        saved = {
                            ...saved,
                            config: applyMirror(
                                saved.config,
                                setting,
                                sent[setting],
                            ),
                        };
                    }
                }
            }

            const next: BuilderState = { ...state, saved, doc, published };

            return action.slice === 'config'
                ? {
                      ...next,
                      meta: {
                          ...next.meta,
                          hasUnpublishedChanges: !deepEqual(
                              saved.config,
                              published,
                          ),
                      },
                  }
                : next;
        }

        case 'published':
            return {
                ...state,
                published: structuredClone(state.saved.config),
                meta: { ...state.meta, ...metaOf(action.widget) },
            };

        case 'enabled':
            return {
                ...state,
                doc: {
                    ...state.doc,
                    settings: {
                        ...state.doc.settings,
                        is_enabled: action.value,
                    },
                },
                saved: {
                    ...state.saved,
                    settings: {
                        ...state.saved.settings,
                        is_enabled: action.value,
                    },
                },
            };

        case 'meta':
            return { ...state, meta: { ...state.meta, ...action.patch } };

        case 'errors/set':
            return { ...state, errors: action.errors };

        case 'errors/clear':
            return {
                ...state,
                errors:
                    action.prefix === undefined
                        ? {}
                        : clearErrorsFor(state.errors, [action.prefix]),
            };
    }

    const next = reduceDoc(state, action);

    if (next === state) {
        return state;
    }

    return {
        ...next,
        errors: clearErrorsFor(next.errors, touchedPaths(action)),
    };
}

/* -------------------------------------------------------------------------- */
/* Derived state                                                              */
/* -------------------------------------------------------------------------- */

export function dirtySlices(state: BuilderState): SliceName[] {
    return SLICES.filter(
        (slice) =>
            !deepEqual(
                state.doc[sliceKey(slice)],
                state.saved[sliceKey(slice)],
            ),
    );
}

export function isDirty(state: BuilderState): boolean {
    return dirtySlices(state).length > 0;
}

/** True when what is saved as draft differs from what visitors get (or the server said so on load). */
export function hasUnpublished(state: BuilderState): boolean {
    return (
        state.meta.hasUnpublishedChanges ||
        !deepEqual(state.saved.config, state.published)
    );
}

export function firstError(
    errors: FieldErrors,
    path: string,
): string | undefined {
    return errors[path]?.[0];
}

/** Every message for any path under `prefix` (e.g. every error of one greeting), without repeats. */
export function errorsUnder(errors: FieldErrors, prefix: string): string[] {
    return [
        ...new Set(
            Object.entries(errors)
                .filter(
                    ([path]) =>
                        path === prefix || path.startsWith(`${prefix}.`),
                )
                .flatMap(([, messages]) => messages),
        ),
    ];
}

/**
 * The error of a setting: from the settings PATCH (`settings.<key>`) or, for the five mirrored
 * ones, from the draft config copy (`config.hours.timezone`, ...).
 */
export function settingError(
    errors: FieldErrors,
    key: SettingsKey,
): string | undefined {
    return (
        firstError(errors, `settings.${key}`) ??
        (isMirrored(key)
            ? firstError(errors, MIRROR_ERROR_PATHS[key])
            : undefined)
    );
}

export function errorCount(errors: FieldErrors): number {
    return Object.keys(errors).length;
}

/* -------------------------------------------------------------------------- */
/* Error mapping                                                              */
/* -------------------------------------------------------------------------- */

/** Namespaces the server's `details` keys so every slice can live in one error map. */
export function mapApiErrors(
    slice: SliceName,
    details: ApiFieldErrors,
): FieldErrors {
    const mapped: FieldErrors = {};

    for (const [field, messages] of Object.entries(details)) {
        let path: string;

        switch (slice) {
            case 'settings':
                path = `settings.${field}`;
                break;
            case 'config':
                path =
                    field.startsWith('config.') || field === 'config'
                        ? field
                        : `config.${field}`;
                break;
            case 'greetings':
                path = field.startsWith('greetings')
                    ? field
                    : `greetings.${field}`;
                break;
            case 'domains':
                path = field.startsWith('domains') ? field : `domains.${field}`;
                break;
            case 'categories':
                path = field.startsWith('category_ulids')
                    ? field.replace('category_ulids', 'categories')
                    : field.startsWith('categories')
                      ? field
                      : `categories.${field}`;
                break;
        }

        mapped[path] = [...(mapped[path] ?? []), ...messages];
    }

    return mapped;
}

export function tabForErrorPath(path: string): BuilderTab {
    if (path.startsWith('greetings')) {
        return 'greetings';
    }

    if (path.startsWith('domains')) {
        return 'domains';
    }

    if (path.startsWith('categories')) {
        return 'categories';
    }

    if (path.startsWith('settings.')) {
        return 'general';
    }

    const [, section] = path.split('.');

    switch (section) {
        case 'theme':
        case 'launcher':
            return 'branding';
        case 'texts':
            return 'texts';
        case 'features':
        case 'preChat':
            return 'features';
        case 'greetings':
            return 'greetings';
        case 'hours':
            return 'hours';
        default:
            return 'general';
    }
}

/** Tabs that currently carry an error, for the red dot in the tab list. */
export function tabsWithErrors(errors: FieldErrors): Set<BuilderTab> {
    return new Set(Object.keys(errors).map(tabForErrorPath));
}

/** The first tab (in display order) that has an error. */
export function firstTabWithError(errors: FieldErrors): BuilderTab | null {
    const tabs = tabsWithErrors(errors);

    return BUILDER_TABS.find((tab) => tabs.has(tab)) ?? null;
}

/* -------------------------------------------------------------------------- */
/* Client-side validation                                                     */
/* -------------------------------------------------------------------------- */

type Translate = (
    key: string,
    replacements?: Record<string, string | number>,
) => string;

function add(errors: FieldErrors, path: string, message: string): void {
    errors[path] = [...(errors[path] ?? []), message];
}

export const DOMAIN_PROBLEM_KEYS: Record<DomainProblem, string> = {
    empty: 'builder.domains.problem.empty',
    scheme: 'builder.domains.problem.scheme',
    path: 'builder.domains.problem.path',
    userinfo: 'builder.domains.problem.userinfo',
    wildcard: 'builder.domains.problem.wildcard',
    port: 'builder.domains.problem.port',
    invalid: 'builder.domains.problem.invalid',
};

/**
 * Weekly hours, with the server's messages' meaning: every time well formed, a range ends after it
 * starts, and ranges of one day never overlap. Errors sit on `.start` / `.end` of the offending range,
 * the same paths the server uses, so a client and a server error land on the same field.
 */
function validateSchedule(
    schedule: HoursRange[],
    errors: FieldErrors,
    t: Translate,
): void {
    const path = 'config.hours.schedule';

    if (schedule.length > LIMITS.maxScheduleRanges) {
        add(
            errors,
            path,
            t('builder.validation.too_many', { max: LIMITS.maxScheduleRanges }),
        );
    }

    const valid: { index: number; start: number; end: number; day: number }[] =
        [];

    schedule.forEach((entry, index) => {
        const base = `${path}.${index}`;

        if (!isTime(entry.start)) {
            add(errors, `${base}.start`, t('builder.validation.time'));
        }

        if (!isClosingTime(entry.end)) {
            add(errors, `${base}.end`, t('builder.validation.time'));
        }

        if (!isTime(entry.start) || !isClosingTime(entry.end)) {
            return;
        }

        const start = timeToMinutes(entry.start);
        const end = timeToMinutes(entry.end);

        if (end <= start) {
            add(errors, `${base}.end`, t('builder.validation.time_order'));

            return;
        }

        valid.push({ index, start, end, day: entry.day });
    });

    // Sorted per day by start: a range that starts before the latest end seen so far overlaps.
    const days = new Set(valid.map((range) => range.day));

    for (const day of days) {
        let lastEnd = -1;

        valid
            .filter((range) => range.day === day)
            .sort((a, b) => a.start - b.start || a.index - b.index)
            .forEach((range) => {
                if (range.start < lastEnd) {
                    add(
                        errors,
                        `${path}.${range.index}.start`,
                        t('builder.validation.time_overlap'),
                    );
                }

                lastEnd = Math.max(lastEnd, range.end);
            });
    }
}

/** Holidays: a real date, not listed twice, and a short enough name (a missing name is fine). */
function validateHolidays(
    holidays: Holiday[],
    errors: FieldErrors,
    t: Translate,
): void {
    const path = 'config.hours.holidays';
    const seen = new Set<string>();

    if (holidays.length > LIMITS.maxHolidays) {
        add(
            errors,
            path,
            t('builder.validation.too_many', { max: LIMITS.maxHolidays }),
        );
    }

    holidays.forEach((holiday, index) => {
        const base = `${path}.${index}`;
        const label = holiday.label ?? '';

        if (!isIsoDate(holiday.date)) {
            add(errors, `${base}.date`, t('builder.validation.date'));
        } else if (seen.has(holiday.date)) {
            add(errors, `${base}.date`, t('builder.validation.date_duplicate'));
        } else {
            seen.add(holiday.date);
        }

        if (label.length > LIMITS.holidayLabelLength) {
            add(
                errors,
                `${base}.label`,
                t('builder.validation.too_long', {
                    max: LIMITS.holidayLabelLength,
                }),
            );
        }
    });
}

/**
 * Cheap checks that mirror the server rules so obvious mistakes never cost a round trip. The
 * server stays the authority (its 422s are mapped through {@link mapApiErrors}).
 */
export function validateBuilderDoc(
    doc: BuilderDoc,
    t: Translate,
    ownOrigin: string,
): FieldErrors {
    const errors: FieldErrors = {};
    const range = (min: number, max: number) =>
        t('builder.validation.range', { min, max });
    const { settings, config } = doc;
    const { theme, launcher } = config;

    const name = settings.name.trim();

    if (name === '') {
        add(errors, 'settings.name', t('builder.validation.required'));
    } else if (name.length > LIMITS.nameLength) {
        add(
            errors,
            'settings.name',
            t('builder.validation.too_long', { max: LIMITS.nameLength }),
        );
    }

    const inRange = (value: number, limits: { min: number; max: number }) =>
        Number.isInteger(value) && value >= limits.min && value <= limits.max;

    if (!inRange(settings.idle_timeout_minutes, LIMITS.idleTimeoutMinutes)) {
        add(
            errors,
            'settings.idle_timeout_minutes',
            range(LIMITS.idleTimeoutMinutes.min, LIMITS.idleTimeoutMinutes.max),
        );
    }

    if (!inRange(settings.queue_timeout_seconds, LIMITS.queueTimeoutSeconds)) {
        add(
            errors,
            'settings.queue_timeout_seconds',
            range(
                LIMITS.queueTimeoutSeconds.min,
                LIMITS.queueTimeoutSeconds.max,
            ),
        );
    }

    if (!isLocaleCode(settings.locale)) {
        add(errors, 'settings.locale', t('builder.validation.locale'));
    }

    if (settings.timezone.trim() === '') {
        add(errors, 'settings.timezone', t('builder.validation.required'));
    }

    for (const key of [
        'primary',
        'primaryText',
        'accent',
        'surface',
        'text',
    ] as const) {
        if (!isHexColor(theme[key])) {
            add(errors, `config.theme.${key}`, t('builder.validation.hex'));
        }
    }

    if (theme.fontFamily.trim() === '') {
        add(
            errors,
            'config.theme.fontFamily',
            t('builder.validation.required'),
        );
    } else if (theme.fontFamily.length > LIMITS.fontFamilyLength) {
        add(
            errors,
            'config.theme.fontFamily',
            t('builder.validation.too_long', { max: LIMITS.fontFamilyLength }),
        );
    } else if (!isFontFamily(theme.fontFamily)) {
        add(
            errors,
            'config.theme.fontFamily',
            t('builder.validation.font_family'),
        );
    }

    if (theme.fontUrl !== null && !isAllowedFontUrl(theme.fontUrl, ownOrigin)) {
        add(errors, 'config.theme.fontUrl', t('builder.validation.font_url'));
    }

    const numericTheme: [keyof typeof theme, { min: number; max: number }][] = [
        ['radius', LIMITS.radius],
        ['panelWidth', LIMITS.panelWidth],
        ['panelHeight', LIMITS.panelHeight],
        ['offsetX', LIMITS.offset],
        ['offsetY', LIMITS.offset],
        ['zIndex', LIMITS.zIndex],
    ];

    for (const [key, limits] of numericTheme) {
        if (!inRange(theme[key] as number, limits)) {
            add(errors, `config.theme.${key}`, range(limits.min, limits.max));
        }
    }

    if (launcher.style === 'pill' && launcher.label.trim() === '') {
        add(errors, 'config.launcher.label', t('builder.validation.required'));
    } else if (launcher.label.length > LIMITS.launcherLabelLength) {
        add(
            errors,
            'config.launcher.label',
            t('builder.validation.too_long', {
                max: LIMITS.launcherLabelLength,
            }),
        );
    }

    if (
        launcher.icon === 'custom' &&
        (launcher.iconUrl === null || !isSecureUrl(launcher.iconUrl))
    ) {
        add(
            errors,
            'config.launcher.iconUrl',
            t('builder.validation.https_url'),
        );
    } else if (launcher.iconUrl !== null && !isSecureUrl(launcher.iconUrl)) {
        add(
            errors,
            'config.launcher.iconUrl',
            t('builder.validation.https_url'),
        );
    }

    if (launcher.avatarUrl !== null && !isSecureUrl(launcher.avatarUrl)) {
        add(
            errors,
            'config.launcher.avatarUrl',
            t('builder.validation.https_url'),
        );
    }

    if (Object.keys(config.texts).length > LIMITS.maxTextLocales) {
        add(
            errors,
            'config.texts',
            t('builder.validation.too_many', { max: LIMITS.maxTextLocales }),
        );
    }

    for (const locale of Object.keys(config.texts)) {
        if (!isLocaleCode(locale)) {
            add(
                errors,
                `config.texts.${locale}`,
                t('builder.validation.locale'),
            );
        }
    }

    if (
        config.preChat.consentText !== null &&
        config.preChat.consentText.length > LIMITS.consentLength
    ) {
        add(
            errors,
            'config.preChat.consentText',
            t('builder.validation.too_long', { max: LIMITS.consentLength }),
        );
    }

    const timing: [
        keyof typeof config.greetings,
        { min: number; max: number },
    ][] = [
        ['delaySeconds', LIMITS.delaySeconds],
        ['intervalMinutes', LIMITS.intervalMinutes],
        ['autoHideSeconds', LIMITS.autoHideSeconds],
    ];

    for (const [key, limits] of timing) {
        if (!inRange(config.greetings[key] as number, limits)) {
            add(
                errors,
                `config.greetings.${key}`,
                range(limits.min, limits.max),
            );
        }
    }

    validateSchedule(config.hours.schedule, errors, t);
    validateHolidays(config.hours.holidays, errors, t);

    if (doc.greetings.length > LIMITS.maxGreetings) {
        add(
            errors,
            'greetings',
            t('builder.validation.too_many', { max: LIMITS.maxGreetings }),
        );
    }

    doc.greetings.forEach((greeting, index) => {
        const path = `greetings.${index}`;

        if (greeting.body.trim() === '') {
            add(errors, `${path}.body`, t('builder.validation.required'));
        } else if (greeting.body.length > LIMITS.greetingBodyLength) {
            add(
                errors,
                `${path}.body`,
                t('builder.validation.too_long', {
                    max: LIMITS.greetingBodyLength,
                }),
            );
        }

        if (
            greeting.agent_name !== null &&
            greeting.agent_name.length > LIMITS.greetingAgentNameLength
        ) {
            add(
                errors,
                `${path}.agent_name`,
                t('builder.validation.too_long', {
                    max: LIMITS.greetingAgentNameLength,
                }),
            );
        }

        if (!inRange(greeting.weight, LIMITS.greetingWeight)) {
            add(
                errors,
                `${path}.weight`,
                range(LIMITS.greetingWeight.min, LIMITS.greetingWeight.max),
            );
        }

        if (
            greeting.agent_avatar_url !== null &&
            !isSecureUrl(greeting.agent_avatar_url)
        ) {
            add(
                errors,
                `${path}.agent_avatar_url`,
                t('builder.validation.https_url'),
            );
        }

        if (greeting.locale !== null && !isLocaleCode(greeting.locale)) {
            add(errors, `${path}.locale`, t('builder.validation.locale'));
        }
    });

    if (doc.domains.length > LIMITS.maxDomains) {
        add(
            errors,
            'domains',
            t('builder.validation.too_many', { max: LIMITS.maxDomains }),
        );
    }

    doc.domains.forEach((domain, index) => {
        const result = normaliseDomainEntry(domain);

        if (!result.ok) {
            add(
                errors,
                `domains.${index}`,
                t(DOMAIN_PROBLEM_KEYS[result.reason]),
            );
        }
    });

    return errors;
}

/* -------------------------------------------------------------------------- */
/* Save payloads                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The body of the settings PATCH: only what changed. `is_enabled` is never part of it; going live or
 * offline is its own confirmed action (`enabled`), not a side effect of saving other settings.
 */
export function settingsPatch(state: BuilderState): Partial<BuilderSettings> {
    const patch: Record<string, unknown> = {};

    for (const key of Object.keys(state.doc.settings) as SettingsKey[]) {
        if (key === 'is_enabled') {
            continue;
        }

        if (!deepEqual(state.doc.settings[key], state.saved.settings[key])) {
            patch[key] = state.doc.settings[key];
        }
    }

    return patch as Partial<BuilderSettings>;
}

/**
 * The draft config as the server will keep it: blank text overrides removed so the widget keeps
 * falling back, and a cleared launcher label back at its default (the server turns an empty string
 * into `null`, and `null` means "use the default").
 */
export function normaliseDraft(config: WidgetConfigData): WidgetConfigData {
    const texts: WidgetConfigData['texts'] = {};

    for (const [locale, block] of Object.entries(config.texts)) {
        texts[locale] = Object.fromEntries(
            Object.entries(block).filter(([, value]) => value !== ''),
        );
    }

    return {
        ...config,
        texts,
        launcher: {
            ...config.launcher,
            label:
                config.launcher.label.trim() === ''
                    ? defaultWidgetConfig().launcher.label
                    : config.launcher.label,
        },
    };
}

/** The body of `PUT /widgets/{ulid}/draft`. */
export function draftPayload(config: WidgetConfigData): {
    config: WidgetConfigData;
} {
    return { config: normaliseDraft(config) };
}

export function greetingsPayload(greetings: GreetingDraft[]) {
    return {
        greetings: greetings.map((greeting, index) => ({
            ...(greeting.ulid ? { ulid: greeting.ulid } : {}),
            body: greeting.body,
            agent_name: blankToNull(greeting.agent_name),
            agent_avatar_url: blankToNull(greeting.agent_avatar_url),
            locale: blankToNull(greeting.locale),
            weight: clampToRange(greeting.weight, LIMITS.greetingWeight),
            is_active: greeting.is_active,
            sort_order: index,
        })),
    };
}

function blankToNull(value: string | null): string | null {
    return value === null || value.trim() === '' ? null : value.trim();
}

/** Greeting list from a server answer (`PUT .../greetings` returns the saved pool), or `null` if it is not one. */
export function greetingsFromResponse(
    response: unknown,
): GreetingDraft[] | null {
    if (!Array.isArray(response)) {
        return null;
    }

    const items = response.filter(
        (item): item is GreetingData =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as GreetingData).ulid === 'string',
    );

    return items.length === response.length
        ? [...items]
              .sort((a, b) => a.sort_order - b.sort_order)
              .map(toGreetingDraft)
        : null;
}

/** Domains from a server answer (`{ domains: [...] }` or a plain list), or `null`. */
export function domainsFromResponse(response: unknown): string[] | null {
    const list = Array.isArray(response)
        ? response
        : typeof response === 'object' && response !== null
          ? (response as { domains?: unknown }).domains
          : null;

    return Array.isArray(list) && list.every((item) => typeof item === 'string')
        ? (list as string[])
        : null;
}
