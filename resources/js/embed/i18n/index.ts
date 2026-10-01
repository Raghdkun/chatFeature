/**
 * Text lookup for the panel. Order, per key: the widget's admin-edited text for the text locale, then for the widget's default
 * locale, then the built-in table of the text locale's language, then built-in English, then the key itself (never blank).
 *
 * English is bundled; other built-in languages are separate chunks loaded before the first render (`loadBuiltin`).
 */
import {
    EN,
    WIDGET_TEXT_KEYS,
    type MessageKey,
    type Messages,
} from '@/embed/i18n/en';
import { interpolate, type Replacements } from '@/lib/i18n';

export { EN, WIDGET_TEXT_KEYS };
export type { MessageKey, Messages };

const LOADERS: Record<string, () => Promise<Messages>> = {
    ar: () => import('@/embed/i18n/ar').then((module) => module.AR),
};

/** The built-in table for a locale's language (empty for languages without one: English takes over). */
export async function loadBuiltin(locale: string): Promise<Messages> {
    const language = locale.replace('_', '-').split('-')[0].toLowerCase();
    const load = LOADERS[language];

    if (load === undefined) {
        return {};
    }

    try {
        return await load();
    } catch {
        // A chunk that fails to load must not take the chat down: English is always there.
        return {};
    }
}

export type Translate = (key: MessageKey, vars?: Replacements) => string;

export type TranslateInput = {
    texts: Record<string, Record<string, string>>;
    textLocale: string;
    defaultLocale: string;
    builtin?: Messages;
};

const WIDGET_KEYS: ReadonlySet<string> = new Set(WIDGET_TEXT_KEYS);

export function createTranslate(input: TranslateInput): Translate {
    const { texts, textLocale, defaultLocale, builtin = {} } = input;

    return (key, vars) => {
        const written = WIDGET_KEYS.has(key)
            ? (texts[textLocale]?.[key] ?? texts[defaultLocale]?.[key])
            : undefined;
        // The server fills every editable text with the English default when an admin wrote nothing for a locale: a text that still
        // equals that default is "not edited", so a built-in translation of the visitor's language wins over it.
        const edited =
            written !== undefined &&
            builtin[key] !== undefined &&
            written === EN[key]
                ? undefined
                : written;

        return interpolate(edited ?? builtin[key] ?? EN[key] ?? key, vars);
    };
}

/**
 * The plural form of a text: `<base>.<zero|one|two|few|many|other>` for the visitor's locale (as the dashboard's `usePlural`),
 * falling back to `<base>.other`. `:count` is filled in.
 */
export function pluralText(
    t: Translate,
    locale: string,
    base: string,
    count: number,
    vars: Replacements = {},
): string {
    let category: Intl.LDMLPluralRule = 'other';

    try {
        category = new Intl.PluralRules(locale).select(count);
    } catch {
        category = count === 1 ? 'one' : 'other';
    }

    const specific = `${base}.${category}` as MessageKey;
    const text = t(specific, { ...vars, count });

    return text === specific
        ? t(`${base}.other` as MessageKey, { ...vars, count })
        : text;
}
