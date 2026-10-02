import { MessageCircleMore } from 'lucide-react';
import { WhatsAppNavBadge } from '@/components/whatsapp/nav-badge';
import { waRoutes } from '@/lib/whatsapp-api/routes';
import type { NavEntry } from '@/nav';

/**
 * The WhatsApp inbox (P6, decision P6-D1): for administrators ONLY. `role: 'admin'` keeps the entry out of an agent's sidebar; the page
 * answers 403 to an agent as well. (The settings page is reached from Settings > WhatsApp, not from here.)
 */
const entries: NavEntry[] = [
    {
        item: {
            title: 'WhatsApp',
            titleKey: 'whatsapp.nav',
            href: waRoutes.pages.inbox(),
            icon: MessageCircleMore,
            badge: WhatsAppNavBadge,
            activeOnChildren: true,
        },
        order: 40,
        role: 'admin',
        group: 'main',
    },
];

export default entries;
