import { Head, usePage } from '@inertiajs/react';
import { ShieldAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { WaInboxShell } from '@/components/whatsapp/inbox-shell';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { WaInboxShellProps, WaInboxShowProps } from '@/types/whatsapp';

/** What an agent would see if a stale tab rendered the page anyway (the server answers 403 first; the UI never shows WhatsApp data to them). */
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

/**
 * The persistent layout of `/whatsapp` and `/whatsapp/{chat}` (a function DECLARATION on purpose: Inertia treats an arrow function with
 * one parameter as a render function, not a component). The list column lives here, so it survives the move between the two pages; the
 * pages render the conversation pane only. It receives the page props.
 */
export function WaInboxLayout({
    children,
    ...props
}: { children: ReactNode } & Partial<WaInboxShowProps>) {
    const { t } = useTrans();
    const { auth } = usePage().props;

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('whatsapp.inbox.title'),
                    href: waRoutes.pages.inbox(),
                },
            ]}
        >
            {auth.user?.is_admin ? (
                <WaInboxShell
                    chats={props.chats ?? []}
                    hasMore={props.hasMore ?? false}
                    sessions={props.sessions ?? []}
                    replyOnlyToInbound={props.replyOnlyToInbound ?? true}
                    selectedUlid={props.detail?.chat.ulid ?? null}
                >
                    {children}
                </WaInboxShell>
            ) : (
                <WhatsAppForbidden />
            )}
        </AppLayout>
    );
}

export type { WaInboxShellProps };
