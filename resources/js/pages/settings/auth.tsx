import { Head, usePage } from '@inertiajs/react';
import type { ReactNode } from 'react';
import { ShieldAlert } from 'lucide-react';
import { ActiveEnvironmentCard } from '@/components/settings/auth/active-environment-card';
import { EnvironmentCard } from '@/components/settings/auth/environment-card';
import { HealthCard } from '@/components/settings/auth/health-card';
import { ManagedNotice } from '@/components/settings/auth/managed-notice';
import { RolesCard } from '@/components/settings/auth/roles-card';
import Heading from '@/components/heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import SettingsLayout from '@/layouts/settings/layout';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import type { SettingsAuthProps } from '@/types/pizzasys';

/**
 * Settings > Auth (admin only; docs/contracts/auth-pizzasys.md). Mode 2 shows the portal's health,
 * both environments, the guarded active-environment switch and the role mapping; mode 1 only
 * explains that sign-in is managed by this app. The server guards the route (`admin` middleware);
 * the check here keeps a stale tab from rendering admin controls for an agent.
 */
export default function AuthSettings({ authSettings }: SettingsAuthProps) {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const portal = authSettings.mode === 'pizzasys';

    if (!auth.user?.is_admin) {
        return (
            <>
                <Head title={t('settings.auth.title')} />
                <Alert
                    variant="destructive"
                    data-testid="settings-auth-forbidden"
                >
                    <ShieldAlert />
                    <AlertTitle>
                        {t('settings.auth.forbidden.title')}
                    </AlertTitle>
                    <AlertDescription>
                        {t('settings.auth.forbidden.body')}
                    </AlertDescription>
                </Alert>
            </>
        );
    }

    return (
        <>
            <Head title={t('settings.auth.title')} />

            <h1 className="sr-only">{t('settings.auth.title')}</h1>

            <div
                className="space-y-6"
                data-testid="settings-auth"
                data-mode={authSettings.mode}
            >
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <Heading
                        variant="small"
                        title={t('settings.auth.title')}
                        description={t(
                            portal
                                ? 'settings.auth.description_portal'
                                : 'settings.auth.description_local',
                        )}
                    />
                    <Badge variant="secondary" data-testid="settings-auth-mode">
                        {t(`settings.auth.mode.${authSettings.mode}`)}
                    </Badge>
                </div>

                {portal ? (
                    <>
                        <HealthCard health={authSettings.health} />
                        <ActiveEnvironmentCard settings={authSettings} />
                        {authSettings.environments.map((env) => (
                            <EnvironmentCard
                                key={env.key}
                                env={env}
                                isActive={env.key === authSettings.active_env}
                            />
                        ))}
                        <RolesCard roles={authSettings.roles} />
                    </>
                ) : (
                    <ManagedNotice />
                )}
            </div>
        </>
    );
}

AuthSettings.layout = [AuthSettingsAppLayout, SettingsLayout];

/** The breadcrumb is translated like every other label (a static layout prop could not be). */
function AuthSettingsAppLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('settings.auth.title'),
                    href: authSettingsRoutes.index,
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
