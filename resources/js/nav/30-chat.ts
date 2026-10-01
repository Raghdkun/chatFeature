import { History, Inbox, Ticket } from 'lucide-react';
import { InboxNavBadge, TicketsNavBadge } from '@/components/inbox/nav-badges';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { NavEntry } from '@/nav';

/** The staff chat pages: inbox and offline tickets for every agent (and admin), the history of everything for admins. */
const entries: NavEntry[] = [
    {
        item: {
            title: 'Inbox',
            titleKey: 'inbox.nav',
            href: staffRoutes.pages.inbox(),
            icon: Inbox,
            badge: InboxNavBadge,
            activeOnChildren: true,
        },
        order: 30,
        role: 'agent',
        group: 'main',
    },
    {
        item: {
            title: 'Offline tickets',
            titleKey: 'tickets.nav',
            href: staffRoutes.pages.offlineTickets(),
            icon: Ticket,
            badge: TicketsNavBadge,
        },
        order: 31,
        role: 'agent',
        group: 'main',
    },
    {
        item: {
            title: 'History',
            titleKey: 'history.nav',
            href: staffRoutes.pages.history(),
            icon: History,
        },
        order: 32,
        role: 'admin',
        group: 'main',
    },
];

export default entries;
