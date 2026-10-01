import { Link, usePage } from '@inertiajs/react';
import AppLogo from '@/components/app-logo';
import { NavMain } from '@/components/nav-main';
import { NavUser } from '@/components/nav-user';
import {
    Sidebar,
    SidebarContent,
    SidebarFooter,
    SidebarHeader,
    SidebarMenu,
    SidebarMenuButton,
    SidebarMenuItem,
} from '@/components/ui/sidebar';
import { useDirection } from '@/hooks/use-direction';
import { useTrans } from '@/hooks/use-trans';
import { inNavGroup, navFor } from '@/nav';
import { dashboard } from '@/routes';

export function AppSidebar() {
    const { auth } = usePage().props;
    const { isRtl } = useDirection();
    const { t } = useTrans();

    // Entries come from the nav registry (resources/js/nav/*.ts), filtered by role.
    const entries = navFor(auth.user ?? {});

    return (
        <Sidebar
            side={isRtl ? 'right' : 'left'}
            collapsible="icon"
            variant="inset"
        >
            <SidebarHeader>
                <SidebarMenu>
                    <SidebarMenuItem>
                        <SidebarMenuButton size="lg" asChild>
                            <Link href={dashboard()} prefetch>
                                <AppLogo />
                            </Link>
                        </SidebarMenuButton>
                    </SidebarMenuItem>
                </SidebarMenu>
            </SidebarHeader>

            <SidebarContent>
                <NavMain
                    items={inNavGroup(entries, 'main')}
                    label={t('nav.platform')}
                />
                <NavMain
                    items={inNavGroup(entries, 'admin')}
                    label={t('nav.administration')}
                />
            </SidebarContent>

            <SidebarFooter>
                <NavUser />
            </SidebarFooter>
        </Sidebar>
    );
}
