import { usePage } from '@inertiajs/react';
import { Breadcrumbs } from '@/components/breadcrumbs';
import { Badge } from '@/components/ui/badge';
import { SidebarTrigger } from '@/components/ui/sidebar';
import { useTrans } from '@/hooks/use-trans';
import { roleOf } from '@/lib/roles';
import type { BreadcrumbItem as BreadcrumbItemType } from '@/types';

export function AppSidebarHeader({
    breadcrumbs = [],
}: {
    breadcrumbs?: BreadcrumbItemType[];
}) {
    const { auth } = usePage().props;
    const { t } = useTrans();

    return (
        <header className="flex h-16 shrink-0 items-center gap-2 border-b border-sidebar-border/50 px-6 transition-[width,height] ease-linear group-has-data-[collapsible=icon]/sidebar-wrapper:h-12 md:px-4">
            <div className="flex min-w-0 flex-1 items-center gap-2">
                <SidebarTrigger className="-ms-1 rtl:-scale-x-100" />
                <Breadcrumbs breadcrumbs={breadcrumbs} />
            </div>
            {auth.user && (
                <Badge
                    variant="outline"
                    className="font-normal text-muted-foreground"
                    data-testid="header-role"
                >
                    {t(`shell.role.${roleOf(auth.user)}`)}
                </Badge>
            )}
        </header>
    );
}
