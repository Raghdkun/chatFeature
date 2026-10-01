import { router, usePage } from '@inertiajs/react';
import { PlugZap, Save } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { When } from '@/components/settings/auth/health-card';
import {
    PizzasysEnvironmentFields,
    type EnvErrorField,
} from '@/components/setup/pizzasys-environment-fields';
import {
    IDLE_TEST,
    PortalTestResultPanel,
    type TestState,
} from '@/components/setup/portal-test-result';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardFooter,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Spinner } from '@/components/ui/spinner';
import { useAuthFormSubmit } from '@/hooks/use-auth-form-submit';
import { useTrans } from '@/hooks/use-trans';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import {
    environmentValuesFrom,
    isEnvironmentDirty,
    settingsEnvironmentPayload,
    validateEnvironment,
    type EnvFormValues,
    type FieldIssues,
} from '@/lib/pizzasys-form';
import { portalClient, type PortalClient } from '@/lib/pizzasys-http';
import type { PizzasysEnvironmentData } from '@/types/pizzasys';
import { toast } from 'sonner';

/**
 * One Auth Portal environment (Production or Testing): editable connection details, Save, and a
 * connection test. Secrets are write-only: the token inputs start empty, a stored token is only
 * indicated, and a blank input keeps it (the payload omits it). "Test connection" checks what is
 * SAVED (`POST /settings/auth/environments/{key}/test`), so it is offered once the form is clean.
 */
export function EnvironmentCard({
    env,
    isActive,
    client = portalClient,
}: {
    env: PizzasysEnvironmentData;
    isActive: boolean;
    /** Injectable for tests. */
    client?: PortalClient;
}) {
    const { t } = useTrans();
    const { locale } = usePage().props;
    const [values, setValues] = useState<EnvFormValues>(() =>
        environmentValuesFrom(env),
    );
    const [issues, setIssues] = useState<FieldIssues>({});
    const [result, setResult] = useState<TestState>(IDLE_TEST);
    const [focusTick, setFocusTick] = useState(0);
    const formRef = useRef<HTMLFormElement>(null);
    const { errors, processing, submit, clearError } = useAuthFormSubmit();
    const dirty = isEnvironmentDirty(values, env);
    const running = result.status === 'running';
    const key = env.key;
    const prefix = `settings-auth-env-${key}`;

    useEffect(() => {
        if (focusTick > 0) {
            formRef.current
                ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [focusTick]);

    const errorFor = (field: EnvErrorField): string | undefined => {
        const issue = (issues as Record<string, string>)[field];

        return (
            errors[field] ??
            (issue ? t(`setup.pizzasys.error.${issue}`) : undefined)
        );
    };

    const change = (patch: Partial<EnvFormValues>) => {
        setValues((current) => ({ ...current, ...patch }));
        setResult(IDLE_TEST);
        clearError(...Object.keys(patch));
        setIssues((current) => {
            const next = { ...current };

            for (const field of Object.keys(patch)) {
                delete next[field];
            }

            return next;
        });
    };

    const save = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (processing || !dirty) {
            return;
        }

        const found = validateEnvironment(values, {
            hasSavedToken: env.has_service_token,
        });

        setIssues(found);

        if (Object.keys(found).length > 0) {
            setFocusTick((tick) => tick + 1);

            return;
        }

        submit(
            'put',
            authSettingsRoutes.environment(key),
            settingsEnvironmentPayload(values),
            {
                onSuccess: () => {
                    // The stored secrets changed on the server: the inputs go back to empty.
                    setValues((current) => ({
                        ...current,
                        service_token: '',
                        nats_token: '',
                        clear_nats_token: false,
                    }));
                    setResult(IDLE_TEST);
                    toast.success(
                        t('settings.auth.env.saved', {
                            environment: t(`setup.pizzasys.env.${key}`),
                        }),
                    );
                },
                onError: () => setFocusTick((tick) => tick + 1),
            },
        );
    };

    const test = async () => {
        if (running || dirty || processing) {
            return;
        }

        setResult({ status: 'running' });

        const outcome = await client.testConnection(
            authSettingsRoutes.environmentTest(key),
        );

        setResult(
            outcome.status === 'done'
                ? { status: 'done', result: outcome.result }
                : {
                      status: 'error',
                      code: outcome.code,
                      message: outcome.message,
                  },
        );
        // The server persisted the outcome (`last_check_*`): show it.
        router.reload({ only: ['authSettings'] });
    };

    return (
        <Card
            role="region"
            aria-labelledby={`${prefix}-title`}
            data-testid={prefix}
            data-active={isActive}
        >
            <CardHeader>
                <div className="flex flex-wrap items-center gap-2">
                    <CardTitle
                        id={`${prefix}-title`}
                        role="heading"
                        aria-level={2}
                    >
                        {t(`setup.pizzasys.env.${key}`)}
                    </CardTitle>
                    {isActive && (
                        <Badge data-testid={`${prefix}-active`}>
                            {t('settings.auth.env.active_badge')}
                        </Badge>
                    )}
                    {!env.configured && (
                        <Badge
                            variant="outline"
                            data-testid={`${prefix}-unconfigured`}
                        >
                            {t('settings.auth.env.not_configured')}
                        </Badge>
                    )}
                </div>
                <CardDescription>
                    {isActive
                        ? t('settings.auth.env.active_note')
                        : t(`setup.pizzasys.env.${key}_description`)}
                </CardDescription>
            </CardHeader>

            <form
                ref={formRef}
                onSubmit={save}
                noValidate
                data-testid={`${prefix}-form`}
                className="grid gap-6"
            >
                <CardContent>
                    <PizzasysEnvironmentFields
                        idPrefix={prefix}
                        values={values}
                        hasServiceToken={env.has_service_token}
                        hasNatsToken={env.has_nats_token}
                        showLabel
                        allowClearNatsToken
                        layout="stacked"
                        disabled={processing}
                        onChange={change}
                        error={errorFor}
                    />
                </CardContent>

                <CardFooter className="flex-col items-stretch gap-4">
                    <div className="flex flex-wrap items-center gap-3">
                        <Button
                            type="submit"
                            disabled={!dirty || processing}
                            data-testid={`${prefix}-save`}
                        >
                            {processing ? <Spinner /> : <Save aria-hidden />}
                            {t('settings.auth.env.save')}
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => void test()}
                            disabled={
                                !env.configured ||
                                dirty ||
                                processing ||
                                running
                            }
                            data-testid={`${prefix}-test`}
                        >
                            {running ? <Spinner /> : <PlugZap aria-hidden />}
                            {running
                                ? t('setup.pizzasys.test.running_button')
                                : t('setup.pizzasys.test.button')}
                        </Button>
                    </div>

                    {dirty && env.configured && (
                        <p
                            className="text-sm text-muted-foreground"
                            data-testid={`${prefix}-dirty-hint`}
                        >
                            {t('settings.auth.env.dirty_hint')}
                        </p>
                    )}

                    <PortalTestResultPanel
                        testId={`${prefix}-result`}
                        state={result}
                    />

                    {env.configured && (
                        <p
                            className="text-sm [overflow-wrap:anywhere] text-muted-foreground"
                            data-testid={`${prefix}-last-check`}
                            data-status={env.last_check_status ?? 'none'}
                        >
                            {env.last_check_status === null
                                ? t('settings.auth.env.never_checked')
                                : t(
                                      env.last_check_status === 'ok'
                                          ? 'settings.auth.env.last_check_ok'
                                          : 'settings.auth.env.last_check_failed',
                                  )}{' '}
                            <When
                                iso={env.last_check_at}
                                empty=""
                                locale={locale}
                            />
                            {env.last_check_status === 'failed' &&
                                env.last_check_message && (
                                    <span className="mt-0.5 block">
                                        {env.last_check_message}
                                    </span>
                                )}
                        </p>
                    )}
                </CardFooter>
            </form>
        </Card>
    );
}
