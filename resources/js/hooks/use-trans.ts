import { usePage } from '@inertiajs/react';
import { useEffect, useSyncExternalStore } from 'react';
import {
    createI18n,
    localeFromPath,
    type Messages,
    type Translator,
} from '@/lib/i18n';

const FALLBACK_LOCALE = 'en';

// English is bundled (it is the fallback and the source language); every other locale in
// /lang is a separate chunk that is fetched the first time that locale is shown.
const bundledFiles = import.meta.glob<Messages>('/lang/en.json', {
    eager: true,
    import: 'default',
});
const lazyFiles = import.meta.glob<Messages>(
    ['/lang/*.json', '!/lang/en.json'],
    {
        import: 'default',
    },
);

export const i18n = createI18n({
    fallbackLocale: FALLBACK_LOCALE,
    bundled: Object.fromEntries(
        Object.entries(bundledFiles).map(([path, messages]) => [
            localeFromPath(path),
            messages,
        ]),
    ),
    loaders: Object.fromEntries(
        Object.entries(lazyFiles).map(([path, load]) => [
            localeFromPath(path),
            load,
        ]),
    ),
});

/**
 * `const { t } = useTrans(); t('setup.mode.title'); t('greeting', { name: 'Sam' })`
 *
 * Reads the shared `locale` prop, lazily loads that locale's file and re-renders once it
 * has arrived. Missing keys fall back to English, then to the key itself.
 */
export function useTrans(): Translator {
    const { locale } = usePage().props;
    const current = locale || FALLBACK_LOCALE;

    const translator = useSyncExternalStore(
        i18n.subscribe,
        () => i18n.translatorFor(current),
        () => i18n.translatorFor(current),
    );

    useEffect(() => {
        void i18n.load(current);
    }, [current]);

    return translator;
}
