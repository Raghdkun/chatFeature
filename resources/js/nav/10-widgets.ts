import { MessagesSquare } from 'lucide-react';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { NavEntry } from '@/nav';

const entries: NavEntry[] = [
    {
        item: {
            title: 'Widgets',
            titleKey: 'widgets.nav',
            href: widgetsRoutes.pages.widgets(),
            icon: MessagesSquare,
        },
        order: 10,
        role: 'admin',
        group: 'admin',
    },
];

export default entries;
