import { Form } from '@inertiajs/react';
import { Building2, Check, Fingerprint, type LucideIcon } from 'lucide-react';
import InputError from '@/components/input-error';
import { BackButton, SubmitButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Badge } from '@/components/ui/badge';
import { useTrans } from '@/hooks/use-trans';
import { setupRoutes } from '@/lib/setup-routes';
import { cn } from '@/lib/utils';
import type { SetupMode, SetupState } from '@/types/setup';

const OPTIONS: { value: SetupMode; icon: LucideIcon }[] = [
    { value: 'fortify', icon: Fingerprint },
    { value: 'pizzasys', icon: Building2 },
];

export function StepMode({
    setup,
    onBack,
}: {
    setup: SetupState;
    onBack: () => void;
}) {
    const { t } = useTrans();
    // Auth Portal stays selectable-looking but disabled until the backend says it exists.
    const selected: SetupMode =
        setup.mode === 'pizzasys' && setup.pizzasysAvailable
            ? 'pizzasys'
            : 'fortify';

    return (
        <Form {...setupRoutes.mode.form()} className="flex flex-1 flex-col">
            {({ processing, errors }) => (
                <StepFrame
                    step="mode"
                    title={t('setup.mode.title')}
                    description={t('setup.mode.description')}
                    footer={
                        <>
                            <BackButton onClick={onBack} />
                            <SubmitButton
                                label={t('setup.mode.submit')}
                                processing={processing}
                                testId="setup-mode-submit"
                            />
                        </>
                    }
                >
                    <fieldset className="grid gap-3">
                        <legend className="sr-only">
                            {t('setup.mode.legend')}
                        </legend>

                        {OPTIONS.map(({ value, icon: Icon }) => {
                            const disabled =
                                value === 'pizzasys' &&
                                !setup.pizzasysAvailable;
                            const inputId = `setup-mode-${value}`;

                            return (
                                <label
                                    key={value}
                                    htmlFor={inputId}
                                    data-testid={`setup-mode-option-${value}`}
                                    data-disabled={disabled}
                                    className={cn(
                                        'relative flex cursor-pointer items-start gap-4 rounded-lg border bg-card p-4 transition-[border-color,background-color,box-shadow] duration-200 ease-out-quart',
                                        'hover:border-foreground/30',
                                        'has-[:checked]:border-primary has-[:checked]:bg-accent/40 has-[:checked]:ring-2 has-[:checked]:ring-primary/20',
                                        'has-[:focus-visible]:ring-[3px] has-[:focus-visible]:ring-ring/50',
                                        disabled &&
                                            'cursor-not-allowed bg-muted/50 hover:border-border',
                                    )}
                                >
                                    <input
                                        id={inputId}
                                        type="radio"
                                        name="mode"
                                        value={value}
                                        defaultChecked={selected === value}
                                        disabled={disabled}
                                        className="peer sr-only"
                                    />
                                    <span
                                        className={cn(
                                            'flex size-10 shrink-0 items-center justify-center rounded-lg bg-secondary text-secondary-foreground',
                                            disabled && 'opacity-60',
                                        )}
                                        aria-hidden
                                    >
                                        <Icon className="size-5" />
                                    </span>
                                    <span
                                        className={cn(
                                            'grid min-w-0 flex-1 gap-1',
                                            disabled && 'opacity-80',
                                        )}
                                    >
                                        <span className="flex flex-wrap items-center gap-2">
                                            <span className="font-medium">
                                                {t(`setup.mode.${value}.title`)}
                                            </span>
                                            {disabled && (
                                                <Badge
                                                    variant="secondary"
                                                    data-testid={`setup-mode-badge-${value}`}
                                                >
                                                    {t(
                                                        'setup.mode.coming_soon',
                                                    )}
                                                </Badge>
                                            )}
                                        </span>
                                        <span className="text-sm text-muted-foreground">
                                            {t(
                                                `setup.mode.${value}.description`,
                                            )}
                                        </span>
                                    </span>
                                    <span
                                        className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-input text-transparent transition-colors duration-200 ease-out-quart peer-checked:border-primary peer-checked:bg-primary peer-checked:text-primary-foreground"
                                        aria-hidden
                                    >
                                        <Check className="size-3" />
                                    </span>
                                </label>
                            );
                        })}

                        <InputError message={errors.mode} />
                    </fieldset>
                </StepFrame>
            )}
        </Form>
    );
}
