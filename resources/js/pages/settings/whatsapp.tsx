import { Head, usePage } from '@inertiajs/react';
import { ShieldAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import Heading from '@/components/heading';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { BehaviorCard } from '@/components/whatsapp/settings/behavior-card';
import { ConnectionCard } from '@/components/whatsapp/settings/connection-card';
import { RiskNotice } from '@/components/whatsapp/settings/risk-notice';
import { SessionsCard } from '@/components/whatsapp/settings/sessions-card';
import { WaReady } from '@/components/whatsapp/wa-ready';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import SettingsLayout from '@/layouts/settings/layout';
import { useWaSessions } from '@/lib/realtime/whatsapp/use-wa-sessions';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaSettingsPageProps } from '@/types/whatsapp';

/**
 * Settings > WhatsApp (administrators only; the server answers 403 to everybody else). The ban-risk notice first, then the connection to
 * OpenWA, the sessions with their QR codes, and how replies and hand-offs behave. The check here only keeps a stale tab from drawing the
 * controls for an agent.
 */
export default function WhatsAppSettings(props: WaSettingsPageProps) {
    const { auth } = usePage().props;
    const { t } = useTrans();

    if (!auth.user?.is_admin) {
        return (
            <>
                <Head title={t('whatsapp.settings.title')} />
                <Alert
                    variant="destructive"
                    data-testid="settings-whatsapp-forbidden"
                >
                    <ShieldAlert />
                    <AlertTitle>{t('whatsapp.forbidden.title')}</AlertTitle>
                    <AlertDescription>
                        {t('whatsapp.forbidden.body')}
                    </AlertDescription>
                </Alert>
            </>
        );
    }

    return (
        <WaReady>
            <WhatsAppSettingsBody {...props} />
        </WaReady>
    );
}

function WhatsAppSettingsBody({
    sessions,
    settings: initial,
    privateHostsAllowed,
}: WaSettingsPageProps) {
    const { t } = useTrans();
    const [settings, setSettings] = useState(initial);
    const controller = useWaSessions(sessions);

    // A later Inertia reload is a newer picture of the saved settings.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- adopts the new props
        setSettings(initial);
    }, [initial]);

    return (
        <>
            <Head title={t('whatsapp.settings.title')} />

            <h1 className="sr-only">{t('whatsapp.settings.title')}</h1>

            <div className="space-y-6" data-testid="settings-whatsapp">
                <Heading
                    variant="small"
                    title={t('whatsapp.settings.title')}
                    description={t('whatsapp.settings.description')}
                />

                <RiskNotice />
                <ConnectionCard
                    settings={settings}
                    privateHostsAllowed={privateHostsAllowed}
                    onSaved={setSettings}
                />
                <SessionsCard
                    controller={controller}
                    globalPacing={{
                        sendMinIntervalMs: settings.sendMinIntervalMs,
                        dailySendCap: settings.dailySendCap,
                    }}
                />
                <BehaviorCard
                    settings={settings}
                    sessions={controller.sessions}
                    onSaved={setSettings}
                />
            </div>
        </>
    );
}

WhatsAppSettings.layout = [WhatsAppSettingsAppLayout, SettingsLayout];

/** The breadcrumb is translated like every other label (a static layout prop could not be). */
function WhatsAppSettingsAppLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('whatsapp.settings.title'),
                    href: waRoutes.pages.settings(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
