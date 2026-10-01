import type { ReactNode } from 'react';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { staffRoutes } from '@/lib/chat-api/staff';

/** The page layout of the staff chat pages: the app shell with a breadcrumb for the current page. */
export function StaffPageLayout({
    titleKey,
    href,
    children,
}: {
    titleKey: string;
    href: string;
    children: ReactNode;
}) {
    const { t } = useTrans();

    return (
        <AppLayout breadcrumbs={[{ title: t(titleKey), href }]}>
            {children}
        </AppLayout>
    );
}

export function InboxLayout({ children }: { children: ReactNode }) {
    return (
        <StaffPageLayout
            titleKey="inbox.title"
            href={staffRoutes.pages.inbox()}
        >
            {children}
        </StaffPageLayout>
    );
}

export function OfflineTicketsLayout({ children }: { children: ReactNode }) {
    return (
        <StaffPageLayout
            titleKey="tickets.title"
            href={staffRoutes.pages.offlineTickets()}
        >
            {children}
        </StaffPageLayout>
    );
}

export function HistoryLayout({ children }: { children: ReactNode }) {
    return (
        <StaffPageLayout
            titleKey="history.title"
            href={staffRoutes.pages.history()}
        >
            {children}
        </StaffPageLayout>
    );
}
