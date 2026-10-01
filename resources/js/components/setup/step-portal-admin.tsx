import { ArrowRight, CircleCheck, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import PasswordInput from '@/components/password-input';
import { describedBy, Field } from '@/components/setup/field';
import { BackButton } from '@/components/setup/step-actions';
import { StepFrame } from '@/components/setup/step-frame';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { useTrans } from '@/hooks/use-trans';
import { hostOf } from '@/lib/pizzasys-form';
import {
    portalClient,
    type PortalAdminOutcome,
    type PortalClient,
} from '@/lib/pizzasys-http';
import { setupRoutes } from '@/lib/setup-routes';
import type { SetupState } from '@/types/setup';

/** What went wrong on the last attempt (never set while a verified admin is shown). */
type Problem = Exclude<PortalAdminOutcome, { status: 'ok' }>;

/**
 * Mode 2, second screen: prove that the portal works end to end by signing in as an administrator
 * (`POST /setup/portal-admin`). Setup cannot finish until this succeeds, so nobody is locked out
 * of a fresh install. The upstream token is discarded server side; only name and email stay.
 */
export function StepPortalAdmin({
    setup,
    onBack,
    onContinue,
    client = portalClient,
}: {
    setup: SetupState;
    onBack: () => void;
    /** Move on to the basics step. */
    onContinue: () => void;
    /** Injectable for tests. */
    client?: PortalClient;
}) {
    const { t } = useTrans();
    const pizzasys = setup.pizzasys ?? null;
    const [verified, setVerified] = useState(pizzasys?.portal_admin ?? null);
    const [changing, setChanging] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [busy, setBusy] = useState(false);
    const [problem, setProblem] = useState<Problem | null>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const continueRef = useRef<HTMLButtonElement>(null);
    const [focusTarget, setFocusTarget] = useState<
        'password' | 'continue' | null
    >(null);

    const showForm = verified === null || changing;
    const activeEnv = pizzasys?.active_env ?? 'production';
    const host = hostOf(pizzasys?.environments[activeEnv]?.base_url);
    const adminPermission = pizzasys?.roles.admin_permission ?? 'chat.admin';

    useEffect(() => {
        if (focusTarget === 'password') {
            passwordRef.current?.focus();
        } else if (focusTarget === 'continue') {
            continueRef.current?.focus();
        }

        setFocusTarget(null);
    }, [focusTarget]);

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (busy) {
            return;
        }

        setBusy(true);
        setProblem(null);

        const outcome = await client.portalAdminLogin(
            setupRoutes.portalAdmin.url,
            { email: email.trim(), password },
        );

        setBusy(false);
        setPassword('');

        if (outcome.status === 'ok') {
            setVerified(outcome.user);
            setChanging(false);
            setFocusTarget('continue');

            return;
        }

        setProblem(outcome);
        setFocusTarget('password');
    };

    const fieldError = (field: 'email' | 'password') =>
        problem?.status === 'error' ? problem.fieldErrors?.[field] : undefined;

    const problemCopy = (found: Problem) => {
        if (found.status === 'rejected') {
            const key = `setup.pizzasys.portal.problem.${found.code}`;

            return {
                title: t(`${key}.title`),
                body: t(`${key}.body`, {
                    permission: adminPermission,
                    host: host ?? '',
                }),
            };
        }

        // Field-level validation messages already sit under the fields.
        return {
            title: t('setup.pizzasys.portal.error.title'),
            body:
                found.code === 'validation' && found.message
                    ? found.message
                    : t(`setup.pizzasys.portal.error.${found.code}`),
        };
    };
    const copy = problem ? problemCopy(problem) : null;

    return (
        <StepFrame
            step="portal-admin"
            title={t('setup.pizzasys.portal.title')}
            description={t('setup.pizzasys.portal.description', {
                permission: adminPermission,
            })}
            footer={
                <>
                    <BackButton onClick={onBack} disabled={busy} />
                    {showForm ? (
                        <Button
                            type="submit"
                            form="setup-portal-form"
                            disabled={busy}
                            data-testid="setup-portal-submit"
                        >
                            {busy && <Spinner />}
                            {busy
                                ? t('setup.pizzasys.portal.verifying')
                                : t('setup.pizzasys.portal.submit')}
                        </Button>
                    ) : (
                        <Button
                            ref={continueRef}
                            type="button"
                            onClick={onContinue}
                            data-testid="setup-portal-continue"
                        >
                            {t('setup.pizzasys.portal.continue')}
                            <ArrowRight
                                className="rtl:rotate-180"
                                aria-hidden
                            />
                        </Button>
                    )}
                </>
            }
        >
            <div className="grid gap-5">
                {verified && !changing && (
                    <div
                        role="status"
                        className="flex gap-3 rounded-lg border bg-accent/40 p-4"
                        data-testid="setup-portal-verified"
                    >
                        <CircleCheck
                            className="mt-0.5 size-5 shrink-0 text-primary"
                            aria-hidden
                        />
                        <div className="grid min-w-0 gap-1 text-sm">
                            <p className="font-medium">
                                {t('setup.pizzasys.portal.verified_title')}
                            </p>
                            <p className="[overflow-wrap:anywhere]">
                                <span
                                    className="font-medium"
                                    data-testid="setup-portal-verified-name"
                                >
                                    {verified.name}
                                </span>{' '}
                                <span
                                    className="text-muted-foreground"
                                    data-testid="setup-portal-verified-email"
                                >
                                    {verified.email}
                                </span>
                            </p>
                            <p className="text-muted-foreground">
                                {t('setup.pizzasys.portal.verified_body')}
                            </p>
                            <div>
                                <Button
                                    type="button"
                                    variant="link"
                                    className="h-auto p-0"
                                    onClick={() => {
                                        setChanging(true);
                                        setProblem(null);
                                    }}
                                    data-testid="setup-portal-change"
                                >
                                    {t('setup.pizzasys.portal.change')}
                                </Button>
                            </div>
                        </div>
                    </div>
                )}

                {showForm && (
                    <form
                        id="setup-portal-form"
                        onSubmit={(event) => void submit(event)}
                        noValidate
                        className="grid gap-5"
                        data-testid="setup-portal-form"
                    >
                        {host && (
                            <p
                                className="text-sm text-muted-foreground"
                                data-testid="setup-portal-target"
                            >
                                {t('setup.pizzasys.portal.target', {
                                    environment: t(
                                        `setup.pizzasys.env.${activeEnv}`,
                                    ),
                                    host,
                                })}
                            </p>
                        )}

                        {copy && problem && (
                            <Alert
                                variant="destructive"
                                className="border-destructive/40 bg-destructive/5 *:data-[slot=alert-description]:text-foreground/80"
                                data-testid="setup-portal-problem"
                                data-code={problem.code}
                            >
                                <ShieldAlert />
                                <AlertTitle>{copy.title}</AlertTitle>
                                <AlertDescription>{copy.body}</AlertDescription>
                            </Alert>
                        )}

                        <Field
                            id="setup-portal-email"
                            label={t('setup.pizzasys.portal.email')}
                            error={fieldError('email')}
                        >
                            <Input
                                id="setup-portal-email"
                                data-testid="setup-portal-email"
                                dir="ltr"
                                type="email"
                                name="email"
                                autoFocus
                                autoComplete="username"
                                placeholder="email@example.com"
                                value={email}
                                onChange={(event) =>
                                    setEmail(event.target.value)
                                }
                                disabled={busy}
                                aria-invalid={
                                    fieldError('email') ? true : undefined
                                }
                                aria-describedby={describedBy(
                                    'setup-portal-email',
                                    { error: fieldError('email') },
                                )}
                            />
                        </Field>

                        <Field
                            id="setup-portal-password"
                            label={t('setup.pizzasys.portal.password')}
                            error={fieldError('password')}
                        >
                            <PasswordInput
                                id="setup-portal-password"
                                data-testid="setup-portal-password"
                                ref={passwordRef}
                                name="password"
                                autoComplete="current-password"
                                value={password}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                disabled={busy}
                                aria-invalid={
                                    fieldError('password') ? true : undefined
                                }
                                aria-describedby={describedBy(
                                    'setup-portal-password',
                                    { error: fieldError('password') },
                                )}
                            />
                        </Field>

                        <p className="text-sm text-muted-foreground">
                            {t('setup.pizzasys.portal.privacy')}
                        </p>
                    </form>
                )}
            </div>
        </StepFrame>
    );
}
