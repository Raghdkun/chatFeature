import { Form, Head, usePage } from '@inertiajs/react';
import { ExternalLink, ShieldAlert, ShieldCheck, WifiOff } from 'lucide-react';
import type { ReactNode } from 'react';
import InputError from '@/components/input-error';
import PasskeyVerify from '@/components/passkey-verify';
import PasswordInput from '@/components/password-input';
import TextLink from '@/components/text-link';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Spinner } from '@/components/ui/spinner';
import { useTrans } from '@/hooks/use-trans';
import AuthLayout from '@/layouts/auth-layout';
import { hasNoChatAccess } from '@/lib/login-notice';
import { hostOf } from '@/lib/pizzasys-form';
import { hasPortalUnavailable } from '@/lib/portal-login';
import { safeExternalUrl } from '@/lib/urls';
import { register } from '@/routes';
import { store } from '@/routes/login';
import { request } from '@/routes/password';

type Props = {
    status?: string;
    /**
     * Set by the backend: `no_chat_access` when a sign-in succeeded upstream but the user has no
     * chat role; `unavailable` (Auth Portal mode) when the portal could not be reached.
     */
    reason?: string;
};

export default function Login({ status, reason }: Props) {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const { capabilities } = auth;
    const portal = auth.mode === 'pizzasys';
    const portalUrl = safeExternalUrl(capabilities.portalUrl);
    const portalHost = hostOf(portalUrl);
    const noChatAccess = (errors: Record<string, string | undefined>) =>
        hasNoChatAccess({ reason, errors });
    // Only the Auth Portal can be "unreachable"; local sign-in keeps the starter-kit behaviour.
    const portalUnavailable = (errors: Record<string, string | undefined>) =>
        portal &&
        !hasNoChatAccess({ reason, errors }) &&
        hasPortalUnavailable({ reason, errors });

    return (
        <>
            <Head
                title={t(
                    portal ? 'auth.login.portal_title' : 'auth.login.submit',
                )}
            />

            {capabilities.canManage2fa && (
                <PasskeyVerify
                    label={t('auth.login.passkey')}
                    loadingLabel={t('auth.login.passkey_loading')}
                    separator={t('auth.login.passkey_separator')}
                />
            )}

            {portal && (
                <div
                    className="flex gap-3 rounded-lg border bg-accent/40 p-3 text-sm"
                    data-testid="login-portal-hint"
                >
                    <ShieldCheck
                        className="mt-0.5 size-4 shrink-0 text-primary"
                        aria-hidden
                    />
                    <div className="grid gap-1">
                        <p className="font-medium">
                            {t('auth.login.portal_badge')}
                        </p>
                        <p className="text-muted-foreground">
                            {t('auth.login.portal_hint')}
                        </p>
                        {portalHost && (
                            <p
                                className="[overflow-wrap:anywhere] text-muted-foreground"
                                data-testid="login-portal-host"
                            >
                                {t('auth.portal.host_hint', {
                                    host: portalHost,
                                })}
                            </p>
                        )}
                        {portalUrl && (
                            <a
                                href={portalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="inline-flex w-fit items-center gap-1 underline underline-offset-4"
                            >
                                {t('auth.login.portal_link')}
                                <ExternalLink
                                    className="size-3.5 rtl:-scale-x-100"
                                    aria-hidden
                                />
                            </a>
                        )}
                    </div>
                </div>
            )}

            <Form
                {...store.form()}
                resetOnSuccess={['password']}
                className="flex flex-col gap-6"
            >
                {({ processing, errors }) => (
                    <>
                        {noChatAccess(errors) && (
                            <Alert
                                variant="destructive"
                                className="border-destructive/40 bg-destructive/5 *:data-[slot=alert-description]:text-foreground/80"
                                data-testid="login-no-chat-access"
                            >
                                <ShieldAlert />
                                <AlertTitle>
                                    {t('auth.no_chat_access.title')}
                                </AlertTitle>
                                <AlertDescription>
                                    {t('auth.no_chat_access.body')}
                                    {portal && (
                                        <> {t('auth.portal.no_access_hint')}</>
                                    )}
                                </AlertDescription>
                            </Alert>
                        )}

                        {portalUnavailable(errors) && (
                            <Alert
                                variant="destructive"
                                className="border-destructive/40 bg-destructive/5 *:data-[slot=alert-description]:text-foreground/80"
                                data-testid="login-portal-unavailable"
                            >
                                <WifiOff />
                                <AlertTitle>
                                    {t('auth.portal.unreachable.title')}
                                </AlertTitle>
                                <AlertDescription>
                                    {t('auth.portal.unreachable.body')}
                                </AlertDescription>
                            </Alert>
                        )}

                        <div className="grid gap-6">
                            <div className="grid gap-2">
                                <Label htmlFor="email">
                                    {t('auth.login.email')}
                                </Label>
                                <Input
                                    id="email"
                                    type="email"
                                    name="email"
                                    required
                                    autoFocus
                                    tabIndex={1}
                                    autoComplete="email"
                                    placeholder="email@example.com"
                                />
                                {/* The notice above already says it; no second line under the field. */}
                                <InputError
                                    message={
                                        noChatAccess(errors) ||
                                        portalUnavailable(errors)
                                            ? undefined
                                            : errors.email
                                    }
                                />
                            </div>

                            <div className="grid gap-2">
                                <div className="flex items-center">
                                    <Label htmlFor="password">
                                        {t('auth.login.password')}
                                    </Label>
                                    {capabilities.canResetPassword ? (
                                        <TextLink
                                            href={request()}
                                            className="ms-auto text-sm"
                                            tabIndex={5}
                                        >
                                            {t('auth.login.forgot')}
                                        </TextLink>
                                    ) : (
                                        portal &&
                                        portalUrl && (
                                            <a
                                                href={portalUrl}
                                                target="_blank"
                                                rel="noopener noreferrer"
                                                className="ms-auto text-sm underline underline-offset-4"
                                            >
                                                {t('auth.login.portal_forgot')}
                                            </a>
                                        )
                                    )}
                                </div>
                                <PasswordInput
                                    id="password"
                                    name="password"
                                    required
                                    tabIndex={2}
                                    autoComplete="current-password"
                                    placeholder={t('auth.login.password')}
                                />
                                <InputError message={errors.password} />
                            </div>

                            <div className="flex items-center gap-3">
                                <Checkbox
                                    id="remember"
                                    name="remember"
                                    tabIndex={3}
                                />
                                <Label htmlFor="remember">
                                    {t('auth.login.remember')}
                                </Label>
                            </div>

                            <Button
                                type="submit"
                                className="mt-4 w-full"
                                tabIndex={4}
                                disabled={processing}
                                data-test="login-button"
                            >
                                {processing && <Spinner />}
                                {t('auth.login.submit')}
                            </Button>
                        </div>

                        {capabilities.canRegister && (
                            <div className="text-center text-sm text-muted-foreground">
                                {t('auth.login.no_account')}{' '}
                                <TextLink href={register()} tabIndex={5}>
                                    {t('auth.login.sign_up')}
                                </TextLink>
                            </div>
                        )}
                    </>
                )}
            </Form>

            {status && (
                <div
                    className="mb-4 text-center text-sm font-medium text-primary"
                    role="status"
                >
                    {status}
                </div>
            )}
        </>
    );
}

/** The sign-in heading depends on the auth mode, so the layout is a component. */
function LoginLayout({ children }: { children: ReactNode }) {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const portal = auth.mode === 'pizzasys';

    return (
        <AuthLayout
            title={t(portal ? 'auth.login.portal_title' : 'auth.login.title')}
            description={t(
                portal
                    ? 'auth.login.portal_description'
                    : 'auth.login.description',
            )}
        >
            {children}
        </AuthLayout>
    );
}

Login.layout = LoginLayout;
