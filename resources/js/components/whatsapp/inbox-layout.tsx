import { Head } from '@inertiajs/react';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { waRoutes } from '@/lib/whatsapp-api/routes';

/** What an agent would see if a stale tab rendered a WhatsApp page anyway (the server answers 403 first; the UI never shows WhatsApp data to them). */
export function WhatsAppForbidden() {
    const { t } = useTrans();

    return (
        <>
            <Head title={t('whatsapp.forbidden.title')} />
            <Alert
                variant="destructive"
                data-testid="whatsapp-forbidden"
                className="m-4 max-w-xl"
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

/** The layout of the WhatsApp inbox: the app shell with its breadcrumb (a function declaration: Inertia reads an arrow with one parameter as a render function). */
export function WaInboxLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('whatsapp.inbox.title'),
                    href: waRoutes.pages.inbox(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
