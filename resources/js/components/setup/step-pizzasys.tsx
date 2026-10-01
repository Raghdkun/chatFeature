import { router } from '@inertiajs/react';
import { ChevronDown, CircleCheck, PlugZap, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import InputError from '@/components/input-error';
import {
    PortalTestResultPanel,
    IDLE_TEST,
    type TestState,
} from '@/components/setup/portal-test-result';
import {
    PizzasysEnvironmentFields,
    type EnvErrorField,
} from '@/components/setup/pizzasys-environment-fields';
import {
    PizzasysRolesFields,
    type RolesErrorField,
} from '@/components/setup/pizzasys-roles-fields';
import { BackButton, SubmitButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Collapsible,
    CollapsibleContent,
    CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Spinner } from '@/components/ui/spinner';
import { useAuthFormSubmit } from '@/hooks/use-auth-form-submit';
import { useTrans } from '@/hooks/use-trans';
import {
    isEnvironmentFilled,
    PIZZASYS_ENV_KEYS,
    setupFormValuesFrom,
    setupPizzasysPayload,
    validateSetupForm,
    type EnvFormValues,
    type FieldIssues,
    type SavedTokens,
    type SetupFormValues,
} from '@/lib/pizzasys-form';
import { portalClient, type PortalClient } from '@/lib/pizzasys-http';
import { setupRoutes } from '@/lib/setup-routes';
import type { PizzasysEnvKey } from '@/types/pizzasys';
import type { SetupState, SetupStepKey } from '@/types/setup';

type Results = Record<PizzasysEnvKey, TestState>;

const NO_RESULTS: Results = { production: IDLE_TEST, testing: IDLE_TEST };

/** Tokens this screen has saved itself, before the server's props reflect it. */
type SavedHere = Record<PizzasysEnvKey, { service: boolean; nats: boolean }>;

const NOTHING_SAVED_HERE: SavedHere = {
    production: { service: false, nats: false },
    testing: { service: false, nats: false },
};

/** The server's error paths for a field of one environment. */
const envPath = (env: PizzasysEnvKey, field: string) =>
    `environments.${env}.${field}`;

/**
 * Mode 2, first screen: where the Auth Portal lives (Production, optionally Testing), how this app
 * maps portal permissions onto its roles, and which environment is active, with a connection
 * test per environment.
 *
 * "Test connection" checks what the SERVER has saved (`POST /setup/pizzasys/test { env }`), so it
 * saves the form first (the same `POST /setup/pizzasys` the Continue button uses) and keeps this
 * screen in place while it does (`onHold`): the server may already consider the step finished.
 */
export function StepPizzasys({
    setup,
    onBack,
    onHold,
    client = portalClient,
}: {
    setup: SetupState;
    onBack: () => void;
    /** Pin the wizard to this step while a background save is in flight; `null` releases it. */
    onHold: (view: SetupStepKey | null) => void;
    /** Injectable for tests. */
    client?: PortalClient;
}) {
    const { t } = useTrans();
    const saved = setup.pizzasys ?? null;
    const [form, setForm] = useState<SetupFormValues>(() =>
        setupFormValuesFrom(saved),
    );
    const [issues, setIssues] = useState<FieldIssues>({});
    const [results, setResults] = useState<Results>(NO_RESULTS);
    const [testingOpen, setTestingOpen] = useState(() =>
        isEnvironmentFilled(form.environments.testing),
    );
    const [focusTick, setFocusTick] = useState(0);
    const [savedHere, setSavedHere] = useState<SavedHere>(NOTHING_SAVED_HERE);
    // Edited since the last save: the server's "tested" flag no longer describes what is on screen.
    const [edited, setEdited] = useState<Record<PizzasysEnvKey, boolean>>({
        production: false,
        testing: false,
    });
    const formRef = useRef<HTMLFormElement>(null);
    const { errors, processing, submit, clearError } = useAuthFormSubmit();
    const testing = PIZZASYS_ENV_KEYS.some(
        (key) => results[key].status === 'running',
    );
    const busy = processing || testing;
    const hasServiceToken = (env: PizzasysEnvKey) =>
        (saved?.environments[env]?.has_service_token ?? false) ||
        savedHere[env].service;
    const hasNatsToken = (env: PizzasysEnvKey) =>
        (saved?.environments[env]?.has_nats_token ?? false) ||
        savedHere[env].nats;
    const savedTokens: SavedTokens = {
        production: hasServiceToken('production'),
        testing: hasServiceToken('testing'),
    };

    useEffect(() => {
        if (focusTick > 0) {
            formRef.current
                ?.querySelector<HTMLElement>('[aria-invalid="true"]')
                ?.focus();
        }
    }, [focusTick]);

    const errorFor = (path: string): string | undefined => {
        const issue = issues[path];

        return (
            errors[path] ??
            (issue ? t(`setup.pizzasys.error.${issue}`) : undefined)
        );
    };
    const touched = (...paths: string[]) => {
        clearError(...paths);
        setIssues((current) => {
            if (!paths.some((path) => path in current)) {
                return current;
            }

            const next = { ...current };

            for (const path of paths) {
                delete next[path];
            }

            return next;
        });
    };

    const updateEnv = (env: PizzasysEnvKey, patch: Partial<EnvFormValues>) => {
        setForm((current) => {
            const environment = { ...current.environments[env], ...patch };
            const environments = {
                ...current.environments,
                [env]: environment,
            };

            return {
                ...current,
                environments,
                // Testing cannot stay active once nothing is configured for it.
                active_env:
                    current.active_env === 'testing' &&
                    !isEnvironmentFilled(environments.testing)
                        ? 'production'
                        : current.active_env,
            };
        });
        setResults((current) => ({ ...current, [env]: IDLE_TEST }));
        setEdited((current) => ({ ...current, [env]: true }));
        touched(
            ...Object.keys(patch).map((field) => envPath(env, field)),
            'active_env',
        );
    };

    /** The server now holds what was sent: remember the secrets were saved, then empty the inputs. */
    const afterSave = () => {
        setSavedHere((current) => {
            const next = { ...current };

            for (const key of PIZZASYS_ENV_KEYS) {
                const typed = form.environments[key];

                next[key] = {
                    service:
                        current[key].service ||
                        typed.service_token.trim() !== '',
                    nats: current[key].nats || typed.nats_token.trim() !== '',
                };
            }

            return next;
        });
        setEdited({ production: false, testing: false });
        setForm((current) => ({
            ...current,
            environments: {
                production: {
                    ...current.environments.production,
                    service_token: '',
                    nats_token: '',
                },
                testing: {
                    ...current.environments.testing,
                    service_token: '',
                    nats_token: '',
                },
            },
        }));
    };

    const validate = (): boolean => {
        const found = validateSetupForm(form, savedTokens);

        setIssues(found);

        if (Object.keys(found).length === 0) {
            return true;
        }

        if (Object.keys(found).some((path) => path.includes('.testing.'))) {
            setTestingOpen(true);
        }

        setFocusTick((tick) => tick + 1);

        return false;
    };

    const setResult = (env: PizzasysEnvKey, state: TestState) =>
        setResults((current) => ({ ...current, [env]: state }));

    const runTest = async (env: PizzasysEnvKey) => {
        const outcome = await client.testConnection(
            setupRoutes.pizzasysTest.url,
            { env },
        );

        setResult(
            env,
            outcome.status === 'done'
                ? { status: 'done', result: outcome.result }
                : {
                      status: 'error',
                      code: outcome.code,
                      message: outcome.message,
                  },
        );
        // Pull the server's `tested` flags (and the saved-token indicators) back in.
        router.reload({ only: ['setup'] });
    };

    const testConnection = (env: PizzasysEnvKey) => {
        if (busy || !validate()) {
            return;
        }

        setResult(env, { status: 'running' });
        onHold('pizzasys');
        submit('post', setupRoutes.pizzasys.url, setupPizzasysPayload(form), {
            onSuccess: () => {
                afterSave();
                void runTest(env);
            },
            onError: () => setResult(env, IDLE_TEST),
        });
    };

    const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (busy || !validate()) {
            return;
        }

        submit('post', setupRoutes.pizzasys.url, setupPizzasysPayload(form), {
            onSuccess: () => {
                afterSave();
                // The server's step decides where we go next (the verified portal login).
                onHold(null);
            },
        });
    };

    const environmentBody = (env: PizzasysEnvKey) => {
        const state = results[env];
        const verified =
            state.status === 'done'
                ? state.result.ok
                : state.status === 'idle' &&
                  !edited[env] &&
                  saved?.tested[env] === true;

        return (
            <div className="grid gap-5">
                <PizzasysEnvironmentFields
                    idPrefix={`setup-env-${env}`}
                    values={form.environments[env]}
                    hasServiceToken={hasServiceToken(env)}
                    hasNatsToken={hasNatsToken(env)}
                    autoFocus={env === 'production'}
                    disabled={processing}
                    onChange={(patch) => updateEnv(env, patch)}
                    error={(field: EnvErrorField) =>
                        errorFor(envPath(env, field))
                    }
                />

                <div className="grid gap-3 border-t pt-5">
                    <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                        <Button
                            type="button"
                            variant="outline"
                            onClick={() => testConnection(env)}
                            disabled={
                                busy ||
                                (env === 'testing' &&
                                    !isEnvironmentFilled(
                                        form.environments.testing,
                                    ))
                            }
                            data-testid={`setup-env-test-${env}`}
                        >
                            {state.status === 'running' ? (
                                <Spinner />
                            ) : (
                                <PlugZap aria-hidden />
                            )}
                            {state.status === 'running'
                                ? t('setup.pizzasys.test.running_button')
                                : t('setup.pizzasys.test.button')}
                        </Button>
                        {verified && (
                            <span
                                className="inline-flex items-center gap-1.5 text-sm font-medium"
                                data-testid={`setup-env-verified-${env}`}
                            >
                                <CircleCheck
                                    className="size-4 text-primary"
                                    aria-hidden
                                />
                                {t('setup.pizzasys.test.verified')}
                            </span>
                        )}
                    </div>
                    <p className="text-sm text-muted-foreground">
                        {t('setup.pizzasys.test.save_note')}
                    </p>
                    <PortalTestResultPanel
                        testId={`setup-env-result-${env}`}
                        state={state}
                    />
                </div>
            </div>
        );
    };

    const formError =
        errors.environments ??
        errors.production ??
        errors.testing ??
        errors.form;
    const testingConfigured = isEnvironmentFilled(form.environments.testing);

    return (
        <form
            ref={formRef}
            onSubmit={handleSubmit}
            noValidate
            className="flex flex-1 flex-col"
            data-testid="setup-pizzasys-form"
        >
            <StepFrame
                step="pizzasys"
                title={t('setup.pizzasys.title')}
                description={t('setup.pizzasys.description')}
                footer={
                    <>
                        <BackButton onClick={onBack} disabled={busy} />
                        <SubmitButton
                            label={t('setup.pizzasys.submit')}
                            processing={processing && !testing}
                            disabled={busy}
                            testId="setup-pizzasys-submit"
                        />
                    </>
                }
            >
                <div className="grid gap-6">
                    {formError && (
                        <Alert
                            variant="destructive"
                            data-testid="setup-pizzasys-form-error"
                        >
                            <TriangleAlert />
                            <AlertDescription>{formError}</AlertDescription>
                        </Alert>
                    )}

                    <section
                        aria-labelledby="setup-env-production-title"
                        className="rounded-xl border bg-card p-4 sm:p-5"
                        data-testid="setup-env-production"
                    >
                        <header className="mb-4 flex flex-wrap items-center gap-2">
                            <h2
                                id="setup-env-production-title"
                                className="text-base font-semibold"
                            >
                                {t('setup.pizzasys.env.production')}
                            </h2>
                            <Badge variant="secondary">
                                {t('setup.pizzasys.env.required')}
                            </Badge>
                        </header>
                        <p className="-mt-2 mb-4 text-sm text-muted-foreground">
                            {t('setup.pizzasys.env.production_description')}
                        </p>
                        {environmentBody('production')}
                    </section>

                    <Collapsible
                        open={testingOpen}
                        onOpenChange={setTestingOpen}
                        className="rounded-xl border bg-card"
                        data-testid="setup-env-testing"
                    >
                        <h2 className="m-0 text-base font-semibold">
                            <CollapsibleTrigger
                                className="group flex w-full items-center gap-2 rounded-xl p-4 text-start outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:p-5"
                                data-testid="setup-env-testing-toggle"
                            >
                                {t('setup.pizzasys.env.testing')}
                                <Badge
                                    variant="outline"
                                    className="font-normal"
                                >
                                    {t('setup.pizzasys.env.optional')}
                                </Badge>
                                <ChevronDown
                                    className="ms-auto size-4 text-muted-foreground transition-transform duration-200 group-data-[state=open]:rotate-180 motion-reduce:transition-none"
                                    aria-hidden
                                />
                            </CollapsibleTrigger>
                        </h2>
                        <CollapsibleContent className="px-4 pb-4 sm:px-5 sm:pb-5">
                            <p className="mb-4 text-sm text-muted-foreground">
                                {t('setup.pizzasys.env.testing_description')}
                            </p>
                            {environmentBody('testing')}
                        </CollapsibleContent>
                    </Collapsible>

                    <section
                        aria-labelledby="setup-roles-title"
                        className="rounded-xl border bg-card p-4 sm:p-5"
                        data-testid="setup-roles"
                    >
                        <h2
                            id="setup-roles-title"
                            className="text-base font-semibold"
                        >
                            {t('setup.pizzasys.roles.title')}
                        </h2>
                        <p className="mt-1 mb-4 text-sm text-muted-foreground">
                            {t('setup.pizzasys.roles.description')}
                        </p>
                        <PizzasysRolesFields
                            idPrefix="setup-roles"
                            values={form.roles}
                            disabled={processing}
                            onChange={(patch) => {
                                setForm((current) => ({
                                    ...current,
                                    roles: { ...current.roles, ...patch },
                                }));
                                touched(...Object.keys(patch));
                            }}
                            error={(field: RolesErrorField) => errorFor(field)}
                        />
                    </section>

                    <fieldset
                        className="grid gap-3"
                        data-testid="setup-active-env"
                    >
                        <legend className="text-base font-semibold">
                            {t('setup.pizzasys.active.title')}
                        </legend>
                        <p className="text-sm text-muted-foreground">
                            {t('setup.pizzasys.active.description')}
                        </p>
                        <RadioGroup
                            value={form.active_env}
                            onValueChange={(value) => {
                                setForm((current) => ({
                                    ...current,
                                    active_env: value as PizzasysEnvKey,
                                }));
                                touched('active_env');
                            }}
                            className="grid gap-3 sm:grid-cols-2"
                            aria-label={t('setup.pizzasys.active.title')}
                        >
                            {PIZZASYS_ENV_KEYS.map((key) => {
                                const disabled =
                                    processing ||
                                    (key === 'testing' && !testingConfigured);

                                return (
                                    <label
                                        key={key}
                                        htmlFor={`setup-active-env-${key}`}
                                        className="flex cursor-pointer items-start gap-3 rounded-lg border bg-card p-3.5 has-[:disabled]:cursor-not-allowed has-[:disabled]:opacity-60 has-[[data-state=checked]]:border-primary has-[[data-state=checked]]:bg-accent/40"
                                    >
                                        <RadioGroupItem
                                            id={`setup-active-env-${key}`}
                                            data-testid={`setup-active-env-${key}`}
                                            value={key}
                                            disabled={disabled}
                                            className="mt-0.5"
                                        />
                                        <span className="grid gap-0.5 text-sm">
                                            <span className="font-medium">
                                                {t(`setup.pizzasys.env.${key}`)}
                                            </span>
                                            <span className="text-muted-foreground">
                                                {t(
                                                    `setup.pizzasys.active.${key}_hint`,
                                                )}
                                            </span>
                                        </span>
                                    </label>
                                );
                            })}
                        </RadioGroup>
                        <InputError message={errorFor('active_env')} />
                    </fieldset>
                </div>
            </StepFrame>
        </form>
    );
}
