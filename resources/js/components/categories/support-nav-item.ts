import { usePage } from '@inertiajs/react';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { NavItem } from '@/types';

/**
 * The "Support categories" entry of the settings menu. Only people who take chats serve categories
 * (`PUT /api/v1/me/categories` answers 403 to anyone without `is_agent`), so it shows for them and
 * stays out of everyone else's way, administrators who do not take chats included.
 * Kept out of `layouts/settings/layout.tsx` so that file only gains a two-line hunk.
 */
export function useSupportCategoriesNavItem(): NavItem | null {
    const { auth } = usePage().props;
    const { t } = useTrans();
    const user = auth?.user;

    if (!user?.is_agent) {
        return null;
    }

    return {
        title: t('categories.support.nav'),
        titleKey: 'categories.support.nav',
        href: widgetsRoutes.pages.supportCategories(),
        icon: null,
    };
}
