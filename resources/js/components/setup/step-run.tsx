import {
    Circle,
    CircleCheck,
    CircleX,
    LoaderCircle,
    Play,
    RotateCcw,
} from 'lucide-react';
import { useState } from 'react';
import { BackButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { useTrans } from '@/hooks/use-trans';
import {
    derivePhase,
    executeRun,
    initialRunRows,
    type RunStepClient,
} from '@/lib/setup-flow';
import { createRunStepClient } from '@/lib/setup-http';
import { cn } from '@/lib/utils';
import type { SetupRunRow, SetupRunStatus, SetupState } from '@/types/setup';

const defaultClient = createRunStepClient();

function StatusIcon({ status }: { status: SetupRunStatus }) {
    const className = 'mt-0.5 size-4 shrink-0';

    switch (status) {
        case 'running':
            return (
                <LoaderCircle
                    className={cn(
                        className,
                        'animate-spin text-primary motion-reduce:animate-none',
                    )}
                    aria-hidden
                />
            );
        case 'done':
            return (
                <CircleCheck
                    className={cn(className, 'text-primary')}
                    aria-hidden
                />
            );
        case 'failed':
            return (
                <CircleX
                    className={cn(className, 'text-destructive-foreground')}
                    aria-hidden
                />
            );
        default:
            return (
                <Circle
                    className={cn(className, 'text-muted-foreground/60')}
                    aria-hidden
                />
            );
    }
}

export function StepRun({
    setup,
    onBack,
    onCompleted,
    runStep = defaultClient,
}: {
    setup: SetupState;
    onBack: () => void;
    /** Called with the URL to continue to once every step succeeded. */
    onCompleted: (redirect: string) => void;
    /** Injectable for tests; talks to `POST /setup/run/{step}` by default. */
    runStep?: RunStepClient;
}) {
    const { t, has } = useTrans();
    const [rows, setRows] = useState<SetupRunRow[]>(() =>
        initialRunRows(setup.run),
    );
    const [busy, setBusy] = useState(false);
    const phase = derivePhase(rows, busy);
    const anyDone = rows.some((row) => row.status === 'done');
    const doneCount = rows.filter((row) => row.status === 'done').length;
    const mode = setup.mode ?? 'fortify';

    const labelOf = (row: SetupRunRow) =>
        has(`setup.run.steps.${row.key}`)
            ? t(`setup.run.steps.${row.key}`)
            : row.label;
    const failureOf = (row: SetupRunRow) =>
        row.message ??
        t(row.code ? `setup.run.error.${row.code}` : 'setup.run.error.unknown');

    const start = async () => {
        if (busy) {
            return;
        }

        setBusy(true);

        const result = await executeRun({ rows, runStep, onChange: setRows });

        setRows(result.rows);
        setBusy(false);

        if (result.outcome === 'completed' && result.redirect) {
            onCompleted(result.redirect);
        }
    };

    const failedRow = rows.find((row) => row.status === 'failed');
    const runningRow = rows.find((row) => row.status === 'running');
    const announcement = failedRow
        ? t('setup.run.announce.failed', {
              step: labelOf(failedRow),
              message: failureOf(failedRow),
          })
        : runningRow
          ? t('setup.run.announce.running', { step: labelOf(runningRow) })
          : phase === 'completed'
            ? t('setup.run.announce.complete')
            : '';

    const startLabel = busy
        ? t('setup.run.running')
        : phase === 'failed'
          ? t('setup.run.retry')
          : anyDone
            ? t('setup.run.resume')
            : t('setup.run.start');

    return (
        <StepFrame
            step="run"
            title={t('setup.run.title')}
            description={t('setup.run.description')}
            footer={
                <>
                    <BackButton onClick={onBack} disabled={busy} />
                    <Button
                        type="button"
                        onClick={() => void start()}
                        disabled={busy}
                        data-testid={
                            phase === 'failed'
                                ? 'setup-run-retry'
                                : 'setup-run-start'
                        }
                    >
                        {busy ? (
                            <LoaderCircle
                                className="animate-spin motion-reduce:animate-none"
                                aria-hidden
                            />
                        ) : phase === 'failed' ? (
                            <RotateCcw aria-hidden />
                        ) : (
                            <Play aria-hidden />
                        )}
                        {startLabel}
                    </Button>
                </>
            }
        >
            <div className="grid gap-6">
                <section
                    aria-labelledby="setup-run-summary-title"
                    data-testid="setup-run-summary"
                >
                    <h2
                        id="setup-run-summary-title"
                        className="text-sm font-medium"
                    >
                        {t('setup.run.summary.title')}
                    </h2>
                    <dl className="mt-3 grid gap-x-6 gap-y-0.5 text-sm sm:grid-cols-[max-content_1fr] sm:gap-y-2">
                        <dt className="text-muted-foreground">
                            {t('setup.run.summary.mode')}
                        </dt>
                        <dd className="mb-2 font-medium sm:mb-0">
                            {t(`setup.mode.${mode}.title`)}
                        </dd>

                        {mode === 'fortify' && setup.admin && (
                            <>
                                <dt className="text-muted-foreground">
                                    {t('setup.run.summary.admin')}
                                </dt>
                                <dd className="mb-2 [overflow-wrap:anywhere] sm:mb-0">
                                    <span className="font-medium">
                                        {setup.admin.name}
                                    </span>
                                    <span className="block text-muted-foreground sm:ms-2 sm:inline">
                                        {setup.admin.email}
                                    </span>
                                </dd>
                            </>
                        )}

                        {mode === 'pizzasys' && setup.pizzasys && (
                            <>
                                <dt className="text-muted-foreground">
                                    {t('setup.pizzasys.summary.portal')}
                                </dt>
                                <dd
                                    className="mb-2 [overflow-wrap:anywhere] sm:mb-0"
                                    data-testid="setup-run-summary-portal"
                                >
                                    <span className="font-medium">
                                        {t(
                                            `setup.pizzasys.env.${setup.pizzasys.active_env}`,
                                        )}
                                    </span>
                                    <span className="block text-muted-foreground sm:ms-2 sm:inline">
                                        {setup.pizzasys.environments[
                                            setup.pizzasys.active_env
                                        ]?.base_url ?? ''}
                                    </span>
                                </dd>

                                {setup.pizzasys.portal_admin && (
                                    <>
                                        <dt className="text-muted-foreground">
                                            {t('setup.run.summary.admin')}
                                        </dt>
                                        <dd className="mb-2 [overflow-wrap:anywhere] sm:mb-0">
                                            <span className="font-medium">
                                                {
                                                    setup.pizzasys.portal_admin
                                                        .name
                                                }
                                            </span>
                                            <span className="block text-muted-foreground sm:ms-2 sm:inline">
                                                {
                                                    setup.pizzasys.portal_admin
                                                        .email
                                                }
                                            </span>
                                        </dd>
                                    </>
                                )}
                            </>
                        )}

                        <dt className="text-muted-foreground">
                            {t('setup.run.summary.app')}
                        </dt>
                        <dd className="mb-2 [overflow-wrap:anywhere] sm:mb-0">
                            <span className="font-medium">
                                {setup.defaults.app_name}
                            </span>
                            <span className="block text-muted-foreground sm:ms-2 sm:inline">
                                {setup.defaults.app_url}
                            </span>
                        </dd>

                        <dt className="text-muted-foreground">
                            {t('setup.run.summary.timezone')}
                        </dt>
                        <dd className="mb-2 sm:mb-0">
                            {setup.defaults.timezone}
                        </dd>
                    </dl>
                </section>

                <section>
                    <Progress
                        value={
                            rows.length === 0
                                ? 0
                                : (doneCount / rows.length) * 100
                        }
                        aria-label={t('setup.run.progress_label')}
                        className="mb-3 h-1.5"
                    />

                    <ol
                        aria-label={t('setup.run.progress_label')}
                        className="grid gap-2"
                        data-testid="setup-run-progress"
                        data-phase={phase}
                    >
                        {rows.map((row) => (
                            <li
                                key={row.key}
                                data-testid={`setup-run-row-${row.key}`}
                                data-status={row.status}
                                className={cn(
                                    'flex items-start gap-3 rounded-lg border bg-card px-3.5 py-3 text-sm transition-colors duration-200 ease-out-quart',
                                    row.status === 'running' &&
                                        'border-primary/40 bg-accent/40',
                                    row.status === 'failed' &&
                                        'border-destructive/50 bg-destructive/5',
                                )}
                            >
                                <StatusIcon status={row.status} />
                                <div className="min-w-0 flex-1">
                                    <p
                                        className={cn(
                                            'font-medium',
                                            row.status === 'pending' &&
                                                'text-muted-foreground',
                                        )}
                                    >
                                        {labelOf(row)}
                                    </p>
                                    {row.status === 'failed' && (
                                        <p
                                            className="mt-1 [overflow-wrap:anywhere] text-destructive-foreground"
                                            data-testid={`setup-run-message-${row.key}`}
                                        >
                                            {failureOf(row)}
                                        </p>
                                    )}
                                </div>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                    {t(`setup.run.status.${row.status}`)}
                                </span>
                            </li>
                        ))}
                    </ol>

                    <p
                        className="sr-only"
                        role="status"
                        aria-live="polite"
                        aria-atomic="true"
                        data-testid="setup-run-live"
                    >
                        {announcement}
                    </p>
                </section>
            </div>
        </StepFrame>
    );
}
