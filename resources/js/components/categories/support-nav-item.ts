import { usePage } from '@inertiajs/react';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { NavItem } from '@/types';

/**
 * The "Support categories" entry of the settings menu. Any staff member (agents included) can pick
 * the categories they serve, so it shows for agents and admins and stays out of everyone else's way.
 * Kept out of `layouts/settings/layout.tsx` so that file only gains a two-line hunk.
 */
export function useSupportCategoriesNavItem(): NavItem | null {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const user = auth?.user;

    if (!user || (!user.is_agent && !user.is_admin)) {
        return null;
    }

    return {
        title: t('categories.support.nav'),
        titleKey: 'categories.support.nav',
        href: widgetsRoutes.pages.supportCategories(),
        icon: null,
    };
}
