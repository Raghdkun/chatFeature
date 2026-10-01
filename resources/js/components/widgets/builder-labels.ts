/**
 * The label a builder field carries on screen, looked up from the error path the server reports
 * (`config.hours.holidays.1.date`, `greetings.0.body`, `settings.idle_timeout_minutes`, ...). Used
 * to put "Holiday 2 date" instead of the dotted attribute into the server's validation messages.
 * `undefined` for a path nobody labelled: the caller falls back to a humanised key.
 */
import { localeLabel, type Translator } from '@/lib/i18n';

/** What the lookup needs of the translator: `has` guards the keys built from an unknown path segment. */
export type LabelTranslator = Pick<Translator, 't' | 'has'>;

const SETTINGS: Record<string, string> = {
    name: 'builder.general.name',
    locale: 'builder.general.default_locale',
    timezone: 'builder.general.timezone',
    idle_timeout_minutes: 'builder.general.idle_timeout',
    queue_timeout_seconds: 'builder.general.queue_timeout',
    offline_mode: 'builder.general.offline_mode',
    allow_non_browser_clients: 'builder.general.non_browser',
};

const THEME: Record<string, string> = {
    mode: 'builder.branding.mode',
    primary: 'builder.branding.primary',
    primaryText: 'builder.branding.primary_text',
    accent: 'builder.branding.accent',
    surface: 'builder.branding.surface',
    text: 'builder.branding.text',
    fontFamily: 'builder.branding.font_family',
    fontUrl: 'builder.branding.font_url',
    radius: 'builder.branding.radius',
    shadow: 'builder.branding.shadow',
    launcherSize: 'builder.branding.launcher_size',
    panelWidth: 'builder.branding.panel_width',
    panelHeight: 'builder.branding.panel_height',
    position: 'builder.branding.position',
    offsetX: 'builder.branding.offset_x',
    offsetY: 'builder.branding.offset_y',
    zIndex: 'builder.branding.z_index',
};

const LAUNCHER: Record<string, string> = {
    style: 'builder.branding.launcher_style',
    icon: 'builder.branding.launcher_icon',
    iconUrl: 'builder.branding.icon_url',
    label: 'builder.branding.launcher_label',
    avatarUrl: 'builder.branding.launcher_avatar',
};

const GREETING_BEHAVIOUR: Record<string, string> = {
    enabled: 'builder.greetings.enabled',
    onPageLoad: 'builder.greetings.on_page_load',
    delaySeconds: 'builder.greetings.delay',
    intervalMinutes: 'builder.greetings.interval',
    autoHideSeconds: 'builder.greetings.auto_hide',
    dismissPolicy: 'builder.greetings.dismiss',
    showAgent: 'builder.greetings.show_agent',
};

const GREETING_ITEM: Record<string, string> = {
    body: 'builder.greetings.body',
    agent_name: 'builder.greetings.agent_name',
    agent_avatar_url: 'builder.greetings.agent_avatar',
    locale: 'builder.greetings.locale',
    weight: 'builder.greetings.weight',
};

const index = (segment: string | undefined): number | null =>
    segment !== undefined && /^\d+$/.test(segment) ? Number(segment) + 1 : null;

export function builderFieldLabel(
    path: string,
    { t, has }: LabelTranslator,
): string | undefined {
    const [root, ...rest] = path.split('.');
    const known = (
        key: string,
        replacements?: Record<string, string | number>,
    ) => (has(key) ? t(key, replacements) : undefined);

    if (root === 'settings') {
        const key = SETTINGS[rest[0] ?? ''];

        return key ? t(key) : undefined;
    }

    if (root === 'greetings') {
        const n = index(rest[0]);
        const field = GREETING_ITEM[rest[1] ?? ''];

        return n !== null && field
            ? `${t('builder.greetings.item', { n })}: ${t(field)}`
            : undefined;
    }

    if (root === 'domains') {
        const n = index(rest[0]);

        return n !== null ? t('builder.domains.item', { n }) : undefined;
    }

    if (root === 'categories' || root === 'category_ulids') {
        const n = index(rest[0]);

        return n !== null ? t('builder.categories.item', { n }) : undefined;
    }

    if (root !== 'config') {
        return undefined;
    }

    const [section, a, b, c] = rest;

    switch (section) {
        case 'theme':
            return THEME[a ?? ''] ? t(THEME[a ?? '']) : undefined;
        case 'launcher':
            return LAUNCHER[a ?? ''] ? t(LAUNCHER[a ?? '']) : undefined;
        case 'greetings':
            return GREETING_BEHAVIOUR[a ?? '']
                ? t(GREETING_BEHAVIOUR[a ?? ''])
                : undefined;
        case 'defaultLocale':
            return t('builder.general.default_locale');
        case 'texts': {
            if (a === undefined || b === undefined) {
                return undefined;
            }

            const text = known(`builder.texts.key.${b}`);

            return text === undefined
                ? undefined
                : `${localeLabel(a)}: ${text}`;
        }
        case 'preChat': {
            if (a === 'consentText') {
                return t('builder.prechat.consent');
            }

            const field = b ? known(`builder.prechat.field_${b}`) : undefined;

            return a === 'fields' && field !== undefined && c
                ? t(
                      c === 'required'
                          ? 'builder.prechat.require_field'
                          : 'builder.prechat.enable_field',
                      { field },
                  )
                : undefined;
        }
        case 'features':
            return a ? known(`builder.features.${a}`) : undefined;
        case 'hours': {
            if (a === 'timezone') {
                return t('builder.general.timezone');
            }

            if (a === 'mode') {
                return t('builder.general.offline_mode');
            }

            const n = index(b);

            if (n === null) {
                return undefined;
            }

            if (a === 'holidays') {
                return t(
                    c === 'label'
                        ? 'builder.hours.holiday_label'
                        : 'builder.hours.holiday_date',
                    { n },
                );
            }

            return a === 'schedule'
                ? t(
                      c === 'end'
                          ? 'builder.hours.range_end'
                          : 'builder.hours.range_start',
                      { n },
                  )
                : undefined;
        }
        default:
            return undefined;
    }
}
