import { DirectionProvider } from '@/components/direction-provider';
import AppLayoutTemplate from '@/layouts/app/app-sidebar-layout';
import type { BreadcrumbItem } from '@/types';

export default function AppLayout({
    breadcrumbs = [],
    children,
}: {
    breadcrumbs?: BreadcrumbItem[];
    children: React.ReactNode;
}) {
    return (
        <DirectionProvider>
            <AppLayoutTemplate breadcrumbs={breadcrumbs}>
                {children}
            </AppLayoutTemplate>
        </DirectionProvider>
    );
}
