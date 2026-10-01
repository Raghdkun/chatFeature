import { LayoutGrid } from 'lucide-react';
import { dashboard } from '@/routes';
import type { NavEntry } from '@/nav';

const entries: NavEntry[] = [
    {
        item: {
            title: 'Dashboard',
            titleKey: 'nav.dashboard',
            href: dashboard(),
            icon: LayoutGrid,
        },
        order: 0,
        role: 'any',
        group: 'main',
    },
];

export default entries;
