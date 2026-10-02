import { AlertCircle, BarChart3, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useTrans } from '@/hooks/use-trans';
import { isApiError } from '@/lib/api-client';
import { cn } from '@/lib/utils';

/** The words for a failed report: access, transport and "something else" (the server's own message is not shown: it may be a validation detail). */
export function errorText(error: unknown, t: (key: string) => string): string {
    if (isApiError(error) && error.status === 403) {
        return t('analytics.state.forbidden');
    }

    if (isApiError(error) && error.code === 'network') {
        return t('analytics.state.network');
    }

    return t('analytics.state.error');
}

/** A failed report: what happened and a way to try again. The previous numbers (when there are any) stay on screen above it. */
export function ReportError({
    error,
    onRetry,
    className,
}: {
    error: unknown;
    onRetry: () => void;
    className?: string;
}) {
    const { t } = useTrans();

    return (
        <div
            role="alert"
            data-testid="analytics-error"
            className={cn(
                'flex flex-wrap items-center gap-3 rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm',
                className,
            )}
        >
            <AlertCircle
                className="size-4 shrink-0 text-destructive"
                aria-hidden
            />
            <p className="min-w-0 flex-1">{errorText(error, t)}</p>
            {!(isApiError(error) && error.status === 403) && (
                <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={onRetry}
                >
                    <RefreshCw aria-hidden />
                    {t('analytics.state.retry')}
                </Button>
            )}
        </div>
    );
}

/** A pulsing placeholder with a polite status for assistive technology (the numbers are loading, not missing). */
export function SkeletonBlock({
    className,
    label,
}: {
    className?: string;
    label?: string;
}) {
    const { t } = useTrans();

    return (
        <div
            role="status"
            aria-busy="true"
            aria-label={label ?? t('analytics.state.loading')}
            className={cn('grid gap-2', className)}
            data-testid="analytics-skeleton"
        >
            <Skeleton className="h-4 w-1/3 motion-reduce:animate-none" />
            <Skeleton className="h-full min-h-24 w-full motion-reduce:animate-none" />
        </div>
    );
}

export function EmptyReport({
    title,
    children,
    className,
}: {
    title: string;
    children?: ReactNode;
    className?: string;
}) {
    return (
        <div
            data-testid="analytics-empty"
            className={cn(
                'flex flex-col items-center gap-1 px-4 py-8 text-center',
                className,
            )}
        >
            <BarChart3
                className="mb-1 size-6 text-muted-foreground"
                aria-hidden
            />
            <p className="text-sm font-medium">{title}</p>
            {children && (
                <p className="max-w-prose text-sm text-muted-foreground">
                    {children}
                </p>
            )}
        </div>
    );
}

/** A card with a titled region: every chart and table of the page sits in one, so the page has a clear outline for screen readers. */
export function Panel({
    id,
    title,
    description,
    actions,
    children,
    className,
    busy,
}: {
    id: string;
    title: string;
    description?: ReactNode;
    actions?: ReactNode;
    children: ReactNode;
    className?: string;
    /** A refetch is running: the old content stays, dimmed (no layout jump). */
    busy?: boolean;
}) {
    return (
        <section
            aria-labelledby={`${id}-title`}
            data-testid={id}
            aria-busy={busy ? 'true' : undefined}
            className={cn('min-w-0 rounded-xl border bg-card', className)}
        >
            <header className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2 p-4 pb-0 sm:p-5 sm:pb-0">
                <div className="grid min-w-0 gap-0.5">
                    <h2
                        id={`${id}-title`}
                        className="text-sm font-semibold tracking-tight"
                    >
                        {title}
                    </h2>
                    {description && (
                        <p className="text-xs text-muted-foreground">
                            {description}
                        </p>
                    )}
                </div>
                {actions}
            </header>
            <div
                className={cn(
                    'p-4 transition-opacity motion-reduce:transition-none sm:p-5',
                    busy && 'opacity-60',
                )}
            >
                {children}
            </div>
        </section>
    );
}
