/**
 * Framework-free translation core behind `useTrans()` (hooks/use-trans.ts).
 *
 * - Keys are flat strings ("setup.mode.title"), values are plain strings with `:name`
 *   placeholders (Laravel style: `:name`, `:Name` and `:NAME` pick the replacement's case).
 * - Lookup chain: requested locale (full tag, then base language) -> English -> the key.
 * - Locale files are loaded lazily; English is bundled so the fallback never flashes.
 */

export type Messages = Record<string, string>;
export type Replacements = Record<string, string | number>;
export type Direction = 'ltr' | 'rtl';

export type Translator = {
    locale: string;
    direction: Direction;
    t: (key: string, replacements?: Replacements) => string;
    /** True when the key exists in the locale or in the English fallback. */
    has: (key: string) => boolean;
};

/** Keep in sync with the `$isRtl` list in resources/views/app.blade.php. */
const RTL_LANGUAGES: ReadonlySet<string> = new Set(['ar', 'he', 'fa', 'ur']);

export function baseLanguage(locale: string): string {
    return locale.replace('_', '-').split('-')[0].toLowerCase();
}

export function directionFor(locale: string | null | undefined): Direction {
    return locale && RTL_LANGUAGES.has(baseLanguage(locale)) ? 'rtl' : 'ltr';
}

/** "pt_BR" -> ["pt-BR", "pt"]; "ar" -> ["ar"]. */
export function localeCandidates(locale: string): string[] {
    const tag = locale.replace('_', '-');
    const base = tag.split('-')[0];

    return base === tag ? [tag] : [tag, base];
}

function applyCase(placeholder: string, value: string): string {
    const first = placeholder.charAt(0);

    if (placeholder.length > 1 && placeholder === placeholder.toUpperCase()) {
        return value.toUpperCase();
    }

    return first !== first.toLowerCase()
        ? value.charAt(0).toUpperCase() + value.slice(1)
        : value;
}

/** Replaces `:name` style placeholders; unknown placeholders are left untouched. */
export function interpolate(
    template: string,
    replacements?: Replacements,
): string {
    if (!replacements) {
        return template;
    }

    return template.replace(
        /:([A-Za-z_][A-Za-z0-9_]*)/g,
        (match, name: string) => {
            if (Object.hasOwn(replacements, name)) {
                return String(replacements[name]);
            }

            const lower = name.toLowerCase();

            return Object.hasOwn(replacements, lower)
                ? applyCase(name, String(replacements[lower]))
                : match;
        },
    );
}

/** A locale named in its own language, e.g. "العربية (ar)"; the bare code when unknown. */
export function localeLabel(code: string): string {
    try {
        const name = new Intl.DisplayNames([code], { type: 'language' }).of(
            code,
        );

        return name && name !== code ? `${name} (${code})` : code;
    } catch {
        return code;
    }
}

/** "/lang/ar.json" -> "ar" */
export function localeFromPath(path: string): string {
    return (path.split('/').pop() ?? path).replace(/\.json$/, '');
}

export type I18nOptions = {
    fallbackLocale: string;
    /** Already-loaded messages by locale (English). */
    bundled: Record<string, Messages>;
    /** Lazy loaders by locale. */
    loaders: Record<string, () => Promise<Messages>>;
};

export function createI18n({ fallbackLocale, bundled, loaders }: I18nOptions) {
    const messages = new Map<string, Messages>(Object.entries(bundled));
    const inflight = new Map<string, Promise<void>>();
    const listeners = new Set<() => void>();
    const translators = new Map<
        string,
        { version: number; value: Translator }
    >();
    let version = 0;

    function notify(): void {
        version++;
        listeners.forEach((listener) => listener());
    }

    function loadOne(code: string): Promise<void> {
        const loader = loaders[code];

        if (messages.has(code) || !loader) {
            return Promise.resolve();
        }

        let pending = inflight.get(code);

        if (!pending) {
            pending = loader()
                .then((loaded) => {
                    messages.set(code, loaded);
                    notify();
                })
                .catch(() => {
                    // A missing or broken locale file must never break the UI: we keep
                    // falling back to English and the key.
                })
                .finally(() => {
                    inflight.delete(code);
                });
            inflight.set(code, pending);
        }

        return pending;
    }

    function lookup(locale: string, key: string): string | undefined {
        for (const code of [...localeCandidates(locale), fallbackLocale]) {
            const table = messages.get(code);

            if (table && Object.hasOwn(table, key)) {
                return table[key];
            }
        }

        return undefined;
    }

    function translate(
        locale: string,
        key: string,
        replacements?: Replacements,
    ): string {
        return interpolate(lookup(locale, key) ?? key, replacements);
    }

    /** Cached per locale and per version, so React sees a stable snapshot between loads. */
    function translatorFor(locale: string): Translator {
        const cached = translators.get(locale);

        if (cached && cached.version === version) {
            return cached.value;
        }

        const value: Translator = {
            locale,
            direction: directionFor(locale),
            t: (key, replacements) => translate(locale, key, replacements),
            has: (key) => lookup(locale, key) !== undefined,
        };

        translators.set(locale, { version, value });

        return value;
    }

    return {
        /** Loads the locale's file(s); safe to call repeatedly. */
        load: (locale: string): Promise<void> =>
            Promise.all(localeCandidates(locale).map(loadOne)).then(
                () => undefined,
            ),
        translate,
        translatorFor,
        has: (locale: string, key: string): boolean =>
            lookup(locale, key) !== undefined,
        /** Locales we have a file for (bundled or lazy), sorted. */
        availableLocales: (): string[] =>
            [
                ...new Set([
                    fallbackLocale,
                    ...messages.keys(),
                    ...Object.keys(loaders),
                ]),
            ].sort(),
        subscribe: (listener: () => void): (() => void) => {
            listeners.add(listener);

            return () => {
                listeners.delete(listener);
            };
        },
        getVersion: (): number => version,
    };
}

export type I18n = ReturnType<typeof createI18n>;
