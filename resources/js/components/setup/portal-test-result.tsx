import {
    CircleCheck,
    CircleX,
    LoaderCircle,
    TriangleAlert,
} from 'lucide-react';
import { useTrans } from '@/hooks/use-trans';
import {
    checkTone,
    hintKeyFor,
    orderedChecks,
    testSummary,
    type CheckTone,
} from '@/lib/pizzasys-checks';
import type { PortalRequestError } from '@/lib/pizzasys-http';
import { cn } from '@/lib/utils';
import type { PortalCheck, PortalTestResult } from '@/types/pizzasys';

/** Where a "Test connection" click stands. */
export type TestState =
    | { status: 'idle' }
    | { status: 'running' }
    | { status: 'done'; result: PortalTestResult }
    | { status: 'error'; code: PortalRequestError; message?: string };

export const IDLE_TEST: TestState = { status: 'idle' };

function ToneIcon({ tone }: { tone: CheckTone }) {
    const className = 'mt-0.5 size-4 shrink-0';

    switch (tone) {
        case 'ok':
            return (
                <CircleCheck
                    className={cn(className, 'text-primary')}
                    aria-hidden
                />
            );
        case 'warning':
            return (
                <TriangleAlert
                    className={cn(
                        className,
                        'text-amber-600 dark:text-amber-400',
                    )}
                    aria-hidden
                />
            );
        default:
            return (
                <CircleX
                    className={cn(className, 'text-destructive-foreground')}
                    aria-hidden
                />
            );
    }
}

/**
 * The outcome of a connection test: one line per check (reachable, service credential, latency,
 * NATS) with what failed and how to fix it. The wrapper is a polite live region so the result is
 * announced when it arrives. `testId` is the container; rows are `<testId>-<check key>`.
 */
export function PortalTestResultPanel({
    testId,
    state,
}: {
    testId: string;
    state: TestState;
}) {
    const { t, has } = useTrans();

    const labelOf = (check: PortalCheck) =>
        has(`setup.pizzasys.check.${check.key}`)
            ? t(`setup.pizzasys.check.${check.key}`)
            : check.label;

    return (
        <div
            role="status"
            aria-live="polite"
            data-testid={testId}
            data-state={state.status}
            data-ok={state.status === 'done' ? state.result.ok : undefined}
        >
            {state.status === 'running' && (
                <p className="flex items-center gap-2 text-sm text-muted-foreground">
                    <LoaderCircle
                        className="size-4 animate-spin motion-reduce:animate-none"
                        aria-hidden
                    />
                    {t('setup.pizzasys.test.running')}
                </p>
            )}

            {state.status === 'error' && (
                <p
                    className="flex items-start gap-2 text-sm [overflow-wrap:anywhere] text-destructive-foreground"
                    data-testid={`${testId}-error`}
                >
                    <CircleX className="mt-0.5 size-4 shrink-0" aria-hidden />
                    <span>
                        {t(`setup.pizzasys.test_error.${state.code}`)}
                        {state.message &&
                        state.code !== 'server' &&
                        state.code !== 'network'
                            ? ` ${state.message}`
                            : ''}
                    </span>
                </p>
            )}

            {state.status === 'done' && (
                <div className="grid gap-2">
                    <p
                        className={cn(
                            'text-sm font-medium',
                            state.result.ok
                                ? 'text-foreground'
                                : 'text-destructive-foreground',
                        )}
                        data-testid={`${testId}-summary`}
                    >
                        {t(
                            `setup.pizzasys.test.summary.${testSummary(state.result)}`,
                        )}
                    </p>
                    <ul className="divide-y overflow-hidden rounded-lg border bg-card">
                        {orderedChecks(state.result).map((check) => {
                            const tone = checkTone(check, state.result);
                            const hintKey = hintKeyFor(check);

                            return (
                                <li
                                    key={check.key}
                                    className="flex items-start gap-3 px-3.5 py-2.5 text-sm"
                                    data-testid={`${testId}-${check.key}`}
                                    data-ok={check.ok}
                                    data-tone={tone}
                                >
                                    <ToneIcon tone={tone} />
                                    <div className="min-w-0 flex-1">
                                        <span className="font-medium">
                                            {labelOf(check)}
                                        </span>
                                        <span className="sr-only">
                                            {`: ${t(`setup.pizzasys.test.tone.${tone}`)}`}
                                        </span>
                                        {check.message && (
                                            <p className="mt-0.5 [overflow-wrap:anywhere] text-muted-foreground">
                                                {check.message}
                                            </p>
                                        )}
                                        {hintKey && (
                                            <p
                                                className="mt-1 text-foreground/80"
                                                data-testid={`${testId}-${check.key}-hint`}
                                            >
                                                {t(hintKey)}
                                            </p>
                                        )}
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                </div>
            )}
        </div>
    );
}
