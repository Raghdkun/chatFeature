import { Users } from 'lucide-react';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { NavEntry } from '@/nav';

const entries: NavEntry[] = [
    {
        item: {
            title: 'Agents',
            titleKey: 'agents.nav',
            href: widgetsRoutes.pages.agents(),
            icon: Users,
        },
        order: 12,
        role: 'admin',
        group: 'admin',
    },
];

export default entries;
