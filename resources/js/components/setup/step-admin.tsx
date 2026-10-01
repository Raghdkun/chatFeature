import { Form } from '@inertiajs/react';
import PasswordInput from '@/components/password-input';
import { describedBy, Field } from '@/components/setup/field';
import { BackButton, SubmitButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import { setupRoutes } from '@/lib/setup-routes';
import type { SetupState } from '@/types/setup';

export function StepAdmin({
    setup,
    onBack,
}: {
    setup: SetupState;
    onBack: () => void;
}) {
    const { t } = useTrans();

    return (
        <Form
            {...setupRoutes.admin.form()}
            resetOnError={['password', 'password_confirmation']}
            className="flex flex-1 flex-col"
        >
            {({ processing, errors }) => (
                <StepFrame
                    step="admin"
                    title={t('setup.admin.title')}
                    description={t('setup.admin.description')}
                    footer={
                        <>
                            <BackButton onClick={onBack} />
                            <SubmitButton
                                label={t('setup.admin.submit')}
                                processing={processing}
                                testId="setup-admin-submit"
                            />
                        </>
                    }
                >
                    <div className="grid gap-5">
                        <Field
                            id="setup-admin-name"
                            label={t('setup.admin.name')}
                            error={errors.name}
                        >
                            <Input
                                id="setup-admin-name"
                                name="name"
                                required
                                autoFocus
                                autoComplete="name"
                                defaultValue={setup.admin?.name}
                                aria-invalid={errors.name ? true : undefined}
                                aria-describedby={describedBy(
                                    'setup-admin-name',
                                    { error: errors.name },
                                )}
                            />
                        </Field>

                        <Field
                            id="setup-admin-email"
                            label={t('setup.admin.email')}
                            error={errors.email}
                        >
                            <Input
                                id="setup-admin-email"
                                type="email"
                                name="email"
                                required
                                autoComplete="email"
                                defaultValue={setup.admin?.email}
                                placeholder="email@example.com"
                                aria-invalid={errors.email ? true : undefined}
                                aria-describedby={describedBy(
                                    'setup-admin-email',
                                    { error: errors.email },
                                )}
                            />
                        </Field>

                        <div className="grid gap-5 sm:grid-cols-2">
                            <Field
                                id="setup-admin-password"
                                label={t('setup.admin.password')}
                                error={errors.password}
                            >
                                <PasswordInput
                                    id="setup-admin-password"
                                    name="password"
                                    required
                                    autoComplete="new-password"
                                    aria-invalid={
                                        errors.password ? true : undefined
                                    }
                                    aria-describedby={describedBy(
                                        'setup-admin-password',
                                        { error: errors.password },
                                    )}
                                />
                            </Field>

                            <Field
                                id="setup-admin-password-confirmation"
                                label={t('setup.admin.password_confirmation')}
                                error={errors.password_confirmation}
                            >
                                <PasswordInput
                                    id="setup-admin-password-confirmation"
                                    name="password_confirmation"
                                    required
                                    autoComplete="new-password"
                                    aria-invalid={
                                        errors.password_confirmation
                                            ? true
                                            : undefined
                                    }
                                    aria-describedby={describedBy(
                                        'setup-admin-password-confirmation',
                                        { error: errors.password_confirmation },
                                    )}
                                />
                            </Field>
                        </div>

                        <p className="text-sm text-muted-foreground">
                            {t('setup.admin.password_hint')}
                        </p>
                    </div>
                </StepFrame>
            )}
        </Form>
    );
}
