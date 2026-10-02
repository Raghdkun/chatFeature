import { usePlural } from '@/components/widgets/page-chrome';
import {
    useWaRetain,
    useWaStateOptional,
} from '@/lib/realtime/whatsapp/context';
import { selectUnreadTotal } from '@/lib/realtime/whatsapp/selectors';

/**
 * Unread WhatsApp messages, at the end of the "WhatsApp" sidebar entry (administrators only: the entry is not shown to anybody else, and
 * without the live context this renders nothing). Mounting it is what starts the live data for the whole dashboard (`useWaRetain`).
 */
export function WhatsAppNavBadge() {
    const plural = usePlural();
    const count = useWaStateOptional(selectUnreadTotal);

    useWaRetain();

    if (!count) {
        return null;
    }

    return (
        <span
            data-testid="nav-badge-whatsapp"
            className="ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums group-data-[collapsible=icon]:hidden"
        >
            <span aria-hidden>{count > 99 ? '99+' : count}</span>
            <span className="sr-only">
                {plural('whatsapp.nav.badge', count)}
            </span>
        </span>
    );
}
