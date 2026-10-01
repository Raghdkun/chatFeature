import { Tags } from 'lucide-react';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { NavEntry } from '@/nav';

const entries: NavEntry[] = [
    {
        item: {
            title: 'Categories',
            titleKey: 'categories.nav',
            href: widgetsRoutes.pages.categories(),
            icon: Tags,
        },
        order: 11,
        role: 'admin',
        group: 'admin',
    },
];

export default entries;
