import { Check } from 'lucide-react';
import { useTrans } from '@/hooks/use-trans';
import { stepperItems, stepProgress } from '@/lib/setup-flow';
import { cn } from '@/lib/utils';
import type { SetupStepKey, SetupStepSummary } from '@/types/setup';

/**
 * Progress through the wizard. A vertical rail on md+ screens; a "Step 2 of 6" summary with
 * segmented progress on phones. Reads `setup.steps` (server order and statuses) and shows
 * `view` as the current step.
 */
export function SetupStepper({
    steps,
    view,
}: {
    steps: SetupStepSummary[];
    view: SetupStepKey;
}) {
    const { t, has } = useTrans();
    const items = stepperItems(steps, view);
    const progress = stepProgress(items, view);
    const labelFor = (step: SetupStepSummary) =>
        has(`setup.steps.${step.key}`)
            ? t(`setup.steps.${step.key}`)
            : step.label;

    return (
        <>
            <div
                className="border-b bg-muted/40 px-6 py-4 md:hidden"
                data-testid="setup-stepper-compact"
                data-step={view}
            >
                <p className="text-xs text-muted-foreground">
                    {t('setup.stepper.progress', {
                        current: progress.index,
                        total: progress.total,
                    })}
                </p>
                <p className="mt-0.5 text-sm font-medium">
                    {labelFor(items[progress.index - 1] ?? items[0])}
                </p>
                <div className="mt-3 flex gap-1.5" aria-hidden>
                    {items.map((item) => (
                        <span
                            key={item.key}
                            className={cn(
                                'h-1 flex-1 rounded-full bg-border transition-colors duration-300 ease-out-quart',
                                item.status === 'done' && 'bg-primary',
                                item.status === 'current' && 'bg-primary/50',
                            )}
                        />
                    ))}
                </div>
            </div>

            <nav
                aria-label={t('setup.stepper.label')}
                className="hidden border-e bg-muted/40 p-6 md:block"
                data-testid="setup-stepper"
            >
                <ol>
                    {items.map((item, index) => {
                        const isLast = index === items.length - 1;

                        return (
                            <li
                                key={item.key}
                                className="flex gap-3"
                                data-testid={`setup-stepper-item-${item.key}`}
                                data-status={item.status}
                                aria-current={
                                    item.status === 'current'
                                        ? 'step'
                                        : undefined
                                }
                            >
                                <div className="flex flex-col items-center">
                                    <span
                                        className={cn(
                                            'flex size-7 shrink-0 items-center justify-center rounded-full border text-xs font-medium transition-colors duration-200 ease-out-quart',
                                            item.status === 'done' &&
                                                'border-primary bg-primary text-primary-foreground',
                                            item.status === 'current' &&
                                                'border-primary bg-background font-semibold text-primary ring-4 ring-primary/15',
                                            item.status === 'pending' &&
                                                'border-border bg-background text-muted-foreground',
                                        )}
                                        aria-hidden
                                    >
                                        {item.status === 'done' ? (
                                            <Check className="size-3.5" />
                                        ) : (
                                            index + 1
                                        )}
                                    </span>
                                    {!isLast && (
                                        <span
                                            className={cn(
                                                'my-1 w-px flex-1 transition-colors duration-300 ease-out-quart',
                                                item.status === 'done'
                                                    ? 'bg-primary/60'
                                                    : 'bg-border',
                                            )}
                                            aria-hidden
                                        />
                                    )}
                                </div>
                                <div className={cn('pt-1', !isLast && 'pb-6')}>
                                    <span
                                        className={cn(
                                            'text-sm',
                                            item.status === 'current' &&
                                                'font-medium text-foreground',
                                            item.status === 'done' &&
                                                'text-foreground/80',
                                            item.status === 'pending' &&
                                                'text-muted-foreground',
                                        )}
                                    >
                                        {labelFor(item)}
                                    </span>
                                    {item.status === 'done' && (
                                        <span className="sr-only">
                                            {`: ${t('setup.run.status.done')}`}
                                        </span>
                                    )}
                                </div>
                            </li>
                        );
                    })}
                </ol>
            </nav>
        </>
    );
}
