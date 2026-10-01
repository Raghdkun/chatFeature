import { Link, usePage } from '@inertiajs/react';
import type { PropsWithChildren } from 'react';
import { useSupportCategoriesNavItem } from '@/components/categories/support-nav-item';
import Heading from '@/components/heading';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useCurrentUrl } from '@/hooks/use-current-url';
import { useTrans } from '@/hooks/use-trans';
import { authSettingsRoutes } from '@/lib/auth-settings-routes';
import { cn, toUrl } from '@/lib/utils';
import { edit as editAppearance } from '@/routes/appearance';
import { edit } from '@/routes/profile';
import { edit as editSecurity } from '@/routes/security';
import type { NavItem } from '@/types';

const sidebarNavItems: NavItem[] = [
    {
        title: 'Profile',
        href: edit(),
        icon: null,
    },
    {
        title: 'Security',
        href: editSecurity(),
        icon: null,
    },
    {
        title: 'Appearance',
        href: editAppearance(),
        icon: null,
    },
];

export default function SettingsLayout({ children }: PropsWithChildren) {
    const { isCurrentOrParentUrl } = useCurrentUrl();
    const { auth } = usePage().props;
    const { t } = useTrans();
    const supportCategories = useSupportCategoriesNavItem();

    // Admin-only (the route is guarded server side too). Mode 2 calls it the Auth Portal; in mode 1
    // the page only explains that sign-in is managed by this app.
    const authItem: NavItem | null = auth.user?.is_admin
        ? {
              title: t(
                  auth.mode === 'pizzasys'
                      ? 'settings.auth.nav'
                      : 'settings.auth.nav_local',
              ),
              href: authSettingsRoutes.index,
              icon: null,
          }
        : null;

    const items: NavItem[] = [
        ...sidebarNavItems,
        ...(supportCategories ? [supportCategories] : []),
        ...(authItem ? [authItem] : []),
    ];

    return (
        <div className="px-4 py-6">
            <Heading
                title="Settings"
                description="Manage your profile and account settings"
            />

            <div className="flex flex-col lg:flex-row lg:gap-12">
                <aside className="w-full max-w-xl lg:w-48">
                    <nav
                        className="flex flex-col space-y-1"
                        aria-label="Settings"
                    >
                        {items.map((item, index) => (
                            <Button
                                key={`${toUrl(item.href)}-${index}`}
                                size="sm"
                                variant="ghost"
                                asChild
                                className={cn('w-full justify-start', {
                                    'bg-muted': isCurrentOrParentUrl(item.href),
                                })}
                            >
                                <Link href={item.href}>
                                    {item.icon && (
                                        <item.icon className="h-4 w-4" />
                                    )}
                                    {item.title}
                                </Link>
                            </Button>
                        ))}
                    </nav>
                </aside>

                <Separator className="my-6 lg:hidden" />

                <div className="flex-1 md:max-w-2xl">
                    <section className="max-w-xl space-y-12">
                        {children}
                    </section>
                </div>
            </div>
        </div>
    );
}
