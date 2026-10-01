import { createInertiaApp } from '@inertiajs/react';
import { Toaster } from '@/components/ui/sonner';
import { TooltipProvider } from '@/components/ui/tooltip';
import { initializeTheme } from '@/hooks/use-appearance';
import AppLayout from '@/layouts/app-layout';
import AuthLayout from '@/layouts/auth-layout';
import SettingsLayout from '@/layouts/settings/layout';
import SetupLayout from '@/layouts/setup-layout';
import { staffChannelAuthorization } from '@/lib/realtime/staff/echo-config';
import { StaffRealtimeHost } from '@/lib/realtime/staff/host';
import { configureEcho } from '@laravel/echo-react';

configureEcho({
    broadcaster: 'reverb',
    // The root view has no csrf-token meta tag: send the XSRF cookie value with the channel auth request instead.
    channelAuthorization: staffChannelAuthorization(),
});

const appName = import.meta.env.VITE_APP_NAME || 'Laravel';

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
        return (
            <TooltipProvider delayDuration={0}>
                {/* Above the pages: the websocket, the timers and the live inbox lists must outlive every visit. */}
                <StaffRealtimeHost initialPage={page}>{app}</StaffRealtimeHost>
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
