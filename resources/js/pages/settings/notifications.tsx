import { Head, usePage } from '@inertiajs/react';
import { BrowserSection } from '@/components/notifications/browser-section';
import { DevicesSection } from '@/components/notifications/devices-section';
import { PreferencesSection } from '@/components/notifications/preferences-section';
import { QuietHoursSection } from '@/components/notifications/quiet-hours-section';
import Heading from '@/components/heading';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import {
    useNotificationsOptional,
    useNotificationsState,
} from '@/lib/notifications/context';
import { notificationRoutes } from '@/lib/notifications/routes';

/**
 * Settings > Notifications (decisions P5-D7, P5-D9): whether this browser gets push, what to be notified about, quiet hours and the
 * registered devices. The controller (`NotificationsHost`) owns the data; this page only shows it.
 */
export default function Notifications() {
    const { t } = useTrans();
    const { locale } = usePage().props;
    const controller = useNotificationsOptional();
    const state = useNotificationsState(controller);

    // The first load happens when the host starts (every dashboard page load); a failed one can be retried from here.
    const failed = state?.settingsStatus === 'error';
    const loaded = state?.settings != null;

    return (
        <>
            <Head title={t('notifications.settings.head')} />

            <h1 className="sr-only">{t('notifications.settings.head')}</h1>

            <div className="space-y-6">
                <Heading
                    variant="small"
                    title={t('notifications.settings.title')}
                    description={t('notifications.settings.description')}
                />

                {controller && state && loaded && state.settings && (
                    <>
                        <BrowserSection controller={controller} state={state} />
                        <PreferencesSection
                            controller={controller}
                            settings={state.settings}
                        />
                        <QuietHoursSection
                            controller={controller}
                            settings={state.settings}
                        />
                        <DevicesSection
                            controller={controller}
                            devices={state.devices}
                            thisDeviceHash={state.thisDeviceHash}
                            locale={locale}
                        />
                    </>
                )}

                {controller && !loaded && !failed && (
                    <div
                        className="grid gap-3"
                        role="status"
                        aria-label={t('notifications.settings.loading')}
                        data-testid="notifications-loading"
                    >
                        <Skeleton className="h-28 w-full" />
                        <Skeleton className="h-40 w-full" />
                    </div>
                )}

                {controller && failed && !loaded && (
                    <Notice tone="danger" data-testid="notifications-error">
                        <p>{t('notifications.settings.load_failed')}</p>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="mt-2"
                            onClick={() => void controller.loadSettings()}
                        >
                            {t('notifications.settings.retry')}
                        </Button>
                    </Notice>
                )}
            </div>
        </>
    );
}

Notifications.layout = {
    breadcrumbs: [
        {
            title: 'Notification settings',
            href: notificationRoutes.pages.settings,
        },
    ],
};
