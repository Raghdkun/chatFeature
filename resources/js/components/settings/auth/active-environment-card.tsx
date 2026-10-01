import { ArrowLeftRight, ShieldAlert } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import PasswordInput from '@/components/password-input';
import { describedBy, Field } from '@/components/setup/field';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
} from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useTrans } from '@/hooks/use-trans';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import {
    canSubmitSwitch,
    environmentOf,
    otherEnvironment,
    switchTarget,
} from '@/lib/auth-settings';
import { hostOf } from '@/lib/pizzasys-form';
import {
    portalClient,
    type PortalClient,
    type RequestFailure,
} from '@/lib/pizzasys-http';
import type { AuthSettingsData } from '@/types/pizzasys';

/** Hard navigation: every session is gone, so the next page must be a fresh load. */
const hardNavigate = (url: string) => window.location.assign(url);

type Problem =
    | { status: 'rejected'; message?: string }
    | Pick<RequestFailure, 'status' | 'code' | 'message' | 'fieldErrors'>;

/**
 * Which environment people sign in against, and the guarded way to change it. A switch signs
 * everyone out (including the admin doing it), so the dialog spells that out and asks for the
 * email and password of an administrator on the TARGET environment: a bad flip cannot lock
 * everyone out, because the flip is refused unless that login works
 * (`POST /settings/auth/active-environment`).
 */
export function ActiveEnvironmentCard({
    settings,
    client = portalClient,
    navigate = hardNavigate,
}: {
    settings: Pick<AuthSettingsData, 'active_env' | 'environments'>;
    /** Injectable for tests. */
    client?: PortalClient;
    navigate?: (url: string) => void;
}) {
    const { t } = useTrans();
    const current = environmentOf(settings, settings.active_env);
    const target = switchTarget(settings);
    const [open, setOpen] = useState(false);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [acknowledged, setAcknowledged] = useState(false);
    const [busy, setBusy] = useState(false);
    const [switched, setSwitched] = useState(false);
    const [problem, setProblem] = useState<Problem | null>(null);
    const passwordRef = useRef<HTMLInputElement>(null);
    const [focusPassword, setFocusPassword] = useState(0);

    useEffect(() => {
        if (focusPassword > 0) {
            passwordRef.current?.focus();
        }
    }, [focusPassword]);

    const reset = () => {
        setEmail('');
        setPassword('');
        setAcknowledged(false);
        setProblem(null);
    };

    const onOpenChange = (next: boolean) => {
        // Closing mid-request would hide the outcome of a switch that may still succeed.
        if (busy || switched) {
            return;
        }

        setOpen(next);

        if (!next) {
            reset();
        }
    };

    const submit = async (event: FormEvent<HTMLFormElement>) => {
        event.preventDefault();

        if (
            !target ||
            busy ||
            !canSubmitSwitch({ email, password, acknowledged })
        ) {
            return;
        }

        setBusy(true);
        setProblem(null);

        const outcome = await client.switchEnvironment(
            authSettingsRoutes.activeEnvironment,
            {
                env: target.key,
                email: email.trim(),
                password,
                confirm: true,
            },
        );

        setBusy(false);
        setPassword('');

        if (outcome.status === 'ok') {
            setSwitched(true);
            navigate(outcome.redirect);

            return;
        }

        setProblem(outcome);
        setFocusPassword((tick) => tick + 1);
    };

    const problemText = (found: Problem): string =>
        found.status === 'rejected'
            ? (found.message ?? t('settings.auth.switch.error.rejected'))
            : found.code === 'validation' && found.message
              ? found.message
              : t(`settings.auth.switch.error.${found.code}`);

    const otherKey = otherEnvironment(settings.active_env);
    const targetName = t(`setup.pizzasys.env.${otherKey}`);
    const currentName = t(`setup.pizzasys.env.${settings.active_env}`);
    const fieldError = (field: 'email' | 'password'): string | undefined =>
        problem && 'fieldErrors' in problem
            ? problem.fieldErrors?.[field]
            : undefined;

    return (
        <Card
            role="region"
            aria-labelledby="settings-auth-switch-title"
            data-testid="settings-auth-switch"
            data-active={settings.active_env}
        >
            <CardHeader>
                <CardTitle
                    id="settings-auth-switch-title"
                    role="heading"
                    aria-level={2}
                >
                    {t('settings.auth.switch.title')}
                </CardTitle>
                <CardDescription>
                    {t('settings.auth.switch.description')}
                </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
                    <span className="text-muted-foreground">
                        {t('settings.auth.switch.current')}
                    </span>
                    <Badge data-testid="settings-auth-switch-current">
                        {currentName}
                    </Badge>
                    {current?.base_url && (
                        <span className="[overflow-wrap:anywhere] text-muted-foreground">
                            {hostOf(current.base_url) ?? current.base_url}
                        </span>
                    )}
                </div>

                <div className="flex flex-wrap items-center gap-3">
                    <Button
                        type="button"
                        variant="outline"
                        disabled={!target}
                        onClick={() => setOpen(true)}
                        data-testid="settings-auth-switch-open"
                    >
                        <ArrowLeftRight aria-hidden />
                        {t('settings.auth.switch.button', {
                            environment: targetName,
                        })}
                    </Button>
                    {!target && (
                        <p
                            className="text-sm text-muted-foreground"
                            data-testid="settings-auth-switch-unavailable"
                        >
                            {t('settings.auth.switch.unavailable')}
                        </p>
                    )}
                </div>
            </CardContent>

            <Dialog open={open} onOpenChange={onOpenChange}>
                <DialogContent
                    className="max-h-[calc(100dvh-2rem)] overflow-y-auto"
                    data-testid="settings-auth-switch-dialog"
                    onInteractOutside={(event) => {
                        if (busy || switched) {
                            event.preventDefault();
                        }
                    }}
                >
                    <DialogHeader>
                        <DialogTitle>
                            {t('settings.auth.switch.dialog.title', {
                                environment: targetName,
                            })}
                        </DialogTitle>
                        <DialogDescription>
                            {t('settings.auth.switch.dialog.description', {
                                host: hostOf(target?.base_url) ?? targetName,
                            })}
                        </DialogDescription>
                    </DialogHeader>

                    <form
                        onSubmit={(event) => void submit(event)}
                        noValidate
                        className="grid gap-4"
                        data-testid="settings-auth-switch-form"
                    >
                        <Alert
                            variant="destructive"
                            className="border-destructive/40 bg-destructive/5 *:data-[slot=alert-description]:text-foreground/80"
                        >
                            <ShieldAlert />
                            <AlertTitle>
                                {t('settings.auth.switch.dialog.warning_title')}
                            </AlertTitle>
                            <AlertDescription>
                                <ul className="ms-4 list-disc space-y-1">
                                    <li>
                                        {t(
                                            'settings.auth.switch.dialog.consequence_signout',
                                            { environment: targetName },
                                        )}
                                    </li>
                                    <li>
                                        {t(
                                            'settings.auth.switch.dialog.consequence_nats',
                                        )}
                                    </li>
                                    <li>
                                        {t(
                                            'settings.auth.switch.dialog.consequence_audit',
                                        )}
                                    </li>
                                </ul>
                            </AlertDescription>
                        </Alert>

                        <p className="text-sm text-muted-foreground">
                            {t('settings.auth.switch.dialog.credentials', {
                                environment: targetName,
                            })}
                        </p>

                        {problem && (
                            <p
                                role="alert"
                                className="text-sm font-medium [overflow-wrap:anywhere] text-destructive-foreground"
                                data-testid="settings-auth-switch-problem"
                            >
                                {problemText(problem)}
                            </p>
                        )}

                        <Field
                            id="settings-auth-switch-email"
                            label={t('settings.auth.switch.dialog.email')}
                            error={fieldError('email')}
                        >
                            <Input
                                id="settings-auth-switch-email"
                                data-testid="settings-auth-switch-email"
                                dir="ltr"
                                type="email"
                                autoFocus
                                autoComplete="username"
                                placeholder="email@example.com"
                                value={email}
                                disabled={busy || switched}
                                onChange={(event) =>
                                    setEmail(event.target.value)
                                }
                                aria-invalid={
                                    fieldError('email') ? true : undefined
                                }
                                aria-describedby={describedBy(
                                    'settings-auth-switch-email',
                                    { error: fieldError('email') },
                                )}
                            />
                        </Field>

                        <Field
                            id="settings-auth-switch-password"
                            label={t('settings.auth.switch.dialog.password')}
                            error={fieldError('password')}
                        >
                            <PasswordInput
                                id="settings-auth-switch-password"
                                data-testid="settings-auth-switch-password"
                                ref={passwordRef}
                                autoComplete="current-password"
                                value={password}
                                disabled={busy || switched}
                                onChange={(event) =>
                                    setPassword(event.target.value)
                                }
                                aria-invalid={
                                    fieldError('password') ? true : undefined
                                }
                                aria-describedby={describedBy(
                                    'settings-auth-switch-password',
                                    { error: fieldError('password') },
                                )}
                            />
                        </Field>

                        <div className="flex items-start gap-3">
                            <Checkbox
                                id="settings-auth-switch-ack"
                                data-testid="settings-auth-switch-ack"
                                checked={acknowledged}
                                disabled={busy || switched}
                                onCheckedChange={(checked) =>
                                    setAcknowledged(checked === true)
                                }
                                className="mt-0.5"
                            />
                            <Label
                                htmlFor="settings-auth-switch-ack"
                                className="leading-snug"
                            >
                                {t('settings.auth.switch.dialog.acknowledge')}
                            </Label>
                        </div>

                        <p
                            role="status"
                            aria-live="polite"
                            className="min-h-5 text-sm text-muted-foreground"
                            data-testid="settings-auth-switch-status"
                        >
                            {switched
                                ? t('settings.auth.switch.dialog.success')
                                : busy
                                  ? t('settings.auth.switch.dialog.checking')
                                  : ''}
                        </p>

                        <DialogFooter>
                            <Button
                                type="button"
                                variant="outline"
                                onClick={() => onOpenChange(false)}
                                disabled={busy || switched}
                                data-testid="settings-auth-switch-cancel"
                            >
                                {t('settings.auth.switch.dialog.cancel')}
                            </Button>
                            <Button
                                type="submit"
                                variant="destructive"
                                disabled={
                                    busy ||
                                    switched ||
                                    !canSubmitSwitch({
                                        email,
                                        password,
                                        acknowledged,
                                    })
                                }
                                data-testid="settings-auth-switch-submit"
                            >
                                {busy && <Spinner />}
                                {t('settings.auth.switch.dialog.submit', {
                                    environment: targetName,
                                })}
                            </Button>
                        </DialogFooter>
                    </form>
                </DialogContent>
            </Dialog>
        </Card>
    );
}
