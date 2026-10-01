import { Form, usePage } from '@inertiajs/react';
import { CircleCheck, Lock } from 'lucide-react';
import { describedBy, Field } from '@/components/setup/field';
import { EnvironmentChecklist } from '@/components/setup/environment-checklist';
import { SubmitButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import PasswordInput from '@/components/password-input';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { canLeaveWelcome, tokenGateActive } from '@/lib/setup-flow';
import { setupRoutes } from '@/lib/setup-routes';
import type { SetupState } from '@/types/setup';

export function StepWelcome({
    setup,
    onContinue,
}: {
    setup: SetupState;
    onContinue: () => void;
}) {
    const { name } = usePage().props;
    const { t } = useTrans();
    const gated = tokenGateActive(setup);
    const ready = canLeaveWelcome(setup);

    return (
        <StepFrame
            step="welcome"
            title={t('setup.welcome.title', { app: name })}
            description={t('setup.welcome.description')}
            footer={
                <div className="sm:ms-auto">
                    <Button
                        type="button"
                        onClick={onContinue}
                        disabled={!ready}
                        className="w-full sm:w-auto"
                        data-testid="setup-welcome-continue"
                    >
                        {t('setup.welcome.continue')}
                    </Button>
                </div>
            }
        >
            <div className="grid gap-8">
                {gated && (
                    <section
                        aria-labelledby="setup-token-title"
                        data-testid="setup-token"
                    >
                        <h2
                            id="setup-token-title"
                            className="text-sm font-medium"
                        >
                            {t('setup.token.title')}
                        </h2>
                        <p className="mt-1 text-sm text-muted-foreground">
                            {t('setup.token.description')}
                        </p>
                        <Form
                            {...setupRoutes.token.form()}
                            options={{ preserveScroll: true }}
                            resetOnSuccess
                            className="mt-4 grid gap-4"
                        >
                            {({ processing, errors }) => (
                                <>
                                    <Field
                                        id="setup-token-input"
                                        label={t('setup.token.label')}
                                        hint={t('setup.token.hint')}
                                        error={errors.token}
                                    >
                                        <PasswordInput
                                            id="setup-token-input"
                                            name="token"
                                            required
                                            autoFocus
                                            autoComplete="off"
                                            autoCapitalize="none"
                                            spellCheck={false}
                                            className="font-mono"
                                            aria-invalid={
                                                errors.token ? true : undefined
                                            }
                                            aria-describedby={describedBy(
                                                'setup-token-input',
                                                {
                                                    hint: true,
                                                    error: errors.token,
                                                },
                                            )}
                                        />
                                    </Field>
                                    <div>
                                        <SubmitButton
                                            label={t('setup.token.submit')}
                                            processing={processing}
                                            testId="setup-token-submit"
                                        />
                                    </div>
                                </>
                            )}
                        </Form>
                    </section>
                )}

                {setup.needsToken && setup.tokenVerified && (
                    <p
                        className="flex items-center gap-2 text-sm text-muted-foreground"
                        data-testid="setup-token-verified"
                    >
                        <CircleCheck
                            className="size-4 shrink-0 text-primary"
                            aria-hidden
                        />
                        {t('setup.token.verified')}
                    </p>
                )}

                {gated ? (
                    <p className="flex items-center gap-2 text-sm text-muted-foreground">
                        <Lock className="size-4 shrink-0" aria-hidden />
                        {t('setup.env.locked')}
                    </p>
                ) : (
                    <EnvironmentChecklist environment={setup.environment} />
                )}
            </div>
        </StepFrame>
    );
}
