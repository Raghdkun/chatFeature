import type { ReactNode } from 'react';
import { useTrans } from '@/hooks/use-trans';
import { cn } from '@/lib/utils';

/** The padded, centred column every list page of this area sits in (same rhythm as the dashboard). */
export function PageShell({
    children,
    className,
    wide,
    testId,
}: {
    children: ReactNode;
    className?: string;
    /** The builder uses the full width for editor + preview. */
    wide?: boolean;
    testId?: string;
}) {
    return (
        <div
            data-testid={testId}
            className={cn(
                'mx-auto flex w-full flex-1 flex-col gap-6 p-4 md:p-6',
                wide ? 'max-w-[110rem]' : 'max-w-6xl',
                className,
            )}
        >
            {children}
        </div>
    );
}

export function PageHeader({
    title,
    description,
    actions,
}: {
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
}) {
    return (
        <header className="flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
            <div className="grid min-w-0 gap-1">
                <h1 className="text-2xl font-semibold tracking-tight text-balance">
                    {title}
                </h1>
                {description && (
                    <p className="max-w-prose text-sm text-muted-foreground">
                        {description}
                    </p>
                )}
            </div>
            {actions && (
                <div className="flex items-center gap-2">{actions}</div>
            )}
        </header>
    );
}

/** `usePlural()('categories.agents_count', 3)` -> picks `<key>.one` / `<key>.other` for the page locale. */
export function usePlural(): (key: string, count: number) => string {
    const { t, has, locale } = useTrans();

    return (key, count) => {
        let category: Intl.LDMLPluralRule = 'other';

        try {
            category = new Intl.PluralRules(locale).select(count);
        } catch {
            category = count === 1 ? 'one' : 'other';
        }

        const specific = `${key}.${category}`;

        return t(has(specific) ? specific : `${key}.other`, { count });
    };
}

/** "5 minutes ago" / "just now" in the page locale; `null` -> `fallback`. */
export function formatRelativeTime(
    iso: string | null,
    locale: string,
    now: Date = new Date(),
): string | null {
    if (!iso) {
        return null;
    }

    const then = new Date(iso).getTime();

    if (Number.isNaN(then)) {
        return null;
    }

    const seconds = Math.round((then - now.getTime()) / 1000);
    const units: [Intl.RelativeTimeFormatUnit, number][] = [
        ['year', 31_536_000],
        ['month', 2_592_000],
        ['day', 86_400],
        ['hour', 3_600],
        ['minute', 60],
    ];

    try {
        const formatter = new Intl.RelativeTimeFormat(locale, {
            numeric: 'auto',
        });

        for (const [unit, size] of units) {
            if (Math.abs(seconds) >= size) {
                return formatter.format(Math.round(seconds / size), unit);
            }
        }

        return formatter.format(0, 'second');
    } catch {
        return new Date(iso).toLocaleString();
    }
}
