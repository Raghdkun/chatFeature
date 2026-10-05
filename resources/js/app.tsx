import { createInertiaApp, router } from '@inertiajs/react';
import { NotificationsHost } from '@/components/notifications/notifications-host';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initializeTheme } from '@/hooks/use-appearance';
import AppLayout from '@/layouts/app-layout';
import AuthLayout from '@/layouts/auth-layout';
import SettingsLayout from '@/layouts/settings/layout';
import SetupLayout from '@/layouts/setup-layout';
import { staffEchoOptions } from '@/lib/realtime/staff/echo-config';
import { StaffRealtimeHost } from '@/lib/realtime/staff/host';
import { configureEcho } from '@laravel/echo-react';

// The name an administrator chose in the setup wizard (`name`, a shared prop) wins over the build-time one: every page title carries it.
let appName = import.meta.env.VITE_APP_NAME || 'Laravel';

function rememberAppName(props: Record<string, unknown>): void {
    if (typeof props.name === 'string' && props.name !== '') {
        appName = props.name;
    }
}

router.on('navigate', (event) => rememberAppName(event.detail.page.props));

void createInertiaApp({
    title: (title) => (title ? `${title} - ${appName}` : appName),
    layout: (name) => {
        switch (true) {
            case name.startsWith('setup/'):
                return SetupLayout;
            case name.startsWith('auth/'):
                return AuthLayout;
            case name.startsWith('settings/'):
                return [AppLayout, SettingsLayout];
            default:
                return AppLayout;
        }
    },
    strictMode: true,
    withApp(app, { page }) {
        rememberAppName(page.props);
        // The Reverb address comes from the server's own settings (the shared `realtime` prop) so a changed host needs no rebuild, and
        // the server's `null` ("realtime is off") wins over the build: the build-time `VITE_REVERB_*` values only serve a server that
        // does not send the prop at all.
        configureEcho(staffEchoOptions(page.props.realtime));

        return (
            <TooltipProvider delayDuration={0}>
                {/* Above the pages: the websocket, the timers and the live inbox lists must outlive every visit. */}
                <StaffRealtimeHost initialPage={page}>
                    {/* Web push: the settings, the first-login dialog and the subscription; inside the staff host for its sound player. */}
                    <NotificationsHost initialPage={page}>
                        {app}
                    </NotificationsHost>
                </StaffRealtimeHost>
                <Toaster />
            </TooltipProvider>
        );
    },
    progress: {
        color: '#2f6b60',
    },
});

// This will set light / dark mode on load...
initializeTheme();
