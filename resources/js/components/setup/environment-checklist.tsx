import { router } from '@inertiajs/react';
import { CircleCheck, CircleX, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { environmentFailures } from '@/lib/setup-flow';
import { cn } from '@/lib/utils';
import type { SetupState } from '@/types/setup';

/** Result of the server's environment check, with a retry that re-runs it. */
export function EnvironmentChecklist({
    environment,
}: {
    environment: SetupState['environment'];
}) {
    const { t } = useTrans();
    const [retrying, setRetrying] = useState(false);
    const failures = environmentFailures(environment);

    const retry = () => {
        router.reload({
            only: ['setup'],
            onStart: () => setRetrying(true),
            onFinish: () => setRetrying(false),
        });
    };

    const summary = environment.ok
        ? t('setup.env.all_ok')
        : failures === 1
          ? t('setup.env.one_failed')
          : t('setup.env.some_failed', { count: Math.max(failures, 1) });

    return (
        <section
            aria-labelledby="setup-env-title"
            data-testid="setup-environment"
            data-ok={environment.ok}
        >
            <div className="flex items-center justify-between gap-3">
                <h2 id="setup-env-title" className="text-sm font-medium">
                    {t('setup.env.title')}
                </h2>
                <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={retry}
                    disabled={retrying}
                    data-testid="setup-env-retry"
                >
                    <RefreshCw
                        className={cn(
                            retrying &&
                                'animate-spin motion-reduce:animate-none',
                        )}
                        aria-hidden
                    />
                    {t('setup.env.retry')}
                </Button>
            </div>

            <p
                role="status"
                className={cn(
                    'mt-1 text-sm',
                    environment.ok
                        ? 'text-muted-foreground'
                        : 'text-destructive-foreground',
                )}
                data-testid="setup-env-summary"
            >
                {summary}
            </p>

            <ul className="mt-3 divide-y overflow-hidden rounded-lg border bg-card">
                {environment.checks.map((check) => (
                    <li
                        key={check.key}
                        className="flex items-start gap-3 px-3.5 py-2.5 text-sm"
                        data-testid={`setup-env-check-${check.key}`}
                        data-ok={check.ok}
                    >
                        {check.ok ? (
                            <CircleCheck
                                className="mt-0.5 size-4 shrink-0 text-primary"
                                aria-hidden
                            />
                        ) : (
                            <CircleX
                                className="mt-0.5 size-4 shrink-0 text-destructive-foreground"
                                aria-hidden
                            />
                        )}
                        <div className="min-w-0 flex-1">
                            <span className="font-medium">{check.label}</span>
                            <span className="sr-only">
                                {`: ${check.ok ? t('setup.env.passed') : t('setup.env.failed')}`}
                            </span>
                            {check.message && (
                                <p className="mt-0.5 [overflow-wrap:anywhere] text-muted-foreground">
                                    {check.message}
                                </p>
                            )}
                        </div>
                    </li>
                ))}
            </ul>
        </section>
    );
}
