import { createInertiaApp } from '@inertiajs/react';
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
        // The Reverb address comes from the server's own settings (the shared `realtime` prop) so a changed host needs no rebuild;
        // the build-time `VITE_REVERB_*` values are the fallback.
        configureEcho(staffEchoOptions(page.props.realtime));

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
