import { ChartNoAxesCombined, Gauge } from 'lucide-react';
import { analyticsRoutes } from '@/lib/analytics/routes';
import type { NavEntry } from '@/nav';

/**
 * One page, two entries: administrators open the whole-account dashboard ("Analytics"), agents their own numbers ("My performance"). Both go to
 * `/analytics`; the server decides what the page and its API answer (an agent never gets more than their own row), the nav only picks the words.
 */
const entries: NavEntry[] = [
    {
        item: {
            title: 'Analytics',
            titleKey: 'analytics.nav',
            href: analyticsRoutes.page(),
            icon: ChartNoAxesCombined,
        },
        order: 50,
        role: 'admin',
        group: 'main',
    },
    {
        item: {
            title: 'My performance',
            titleKey: 'analytics.nav_agent',
            href: analyticsRoutes.page(),
            icon: Gauge,
        },
        order: 50,
        role: 'agent-only',
        group: 'main',
    },
];

export default entries;
