import { usePage } from '@inertiajs/react';
import { useEffect } from 'react';
import { directionFor, type Direction } from '@/lib/i18n';

export type UseDirectionReturn = {
    direction: Direction;
    isRtl: boolean;
    locale: string;
};

/**
 * Reads the shared `direction` / `locale` props (derived server-side) and keeps
 * `<html lang dir>` in sync across Inertia visits. The Blade root view sets both on the
 * first response, so there is no flash.
 */
export function useDirection(): UseDirectionReturn {
    const { direction, locale } = usePage().props;
    const resolvedLocale = locale || 'en';
    const resolved: Direction = direction ?? directionFor(resolvedLocale);

    useEffect(() => {
        const root = document.documentElement;

        root.dir = resolved;
        root.lang = resolvedLocale;
    }, [resolved, resolvedLocale]);

    return {
        direction: resolved,
        isRtl: resolved === 'rtl',
        locale: resolvedLocale,
    };
}
