import type { Auth } from '@/types/auth';

declare module 'react' {
    interface InputHTMLAttributes<T> {
        passwordrules?: string;
    }
}

declare module '@inertiajs/core' {
    /**
     * Mirrors docs/contracts/inertia-shared-props.md. Keep in sync with
     * `HandleInertiaRequests::share()`.
     */
    export interface InertiaConfig {
        sharedPageProps: {
            name: string;
            auth: Auth;
            locale: string;
            direction: 'ltr' | 'rtl';
            installed: boolean;
            sidebarOpen: boolean;
            flash: { success?: string; error?: string };
            realtime: {
                key: string;
                host: string;
                port: number;
                scheme: 'http' | 'https';
            } | null;
            [key: string]: unknown;
        };
    }
}
