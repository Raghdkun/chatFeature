import { usePlural } from '@/components/widgets/page-chrome';
import { useInboxOptional } from '@/lib/realtime/staff/context';
import {
    selectAttentionCount,
    selectTicketCount,
    type InboxState,
} from '@/lib/realtime/staff/store';

/** On the collapsed rail the count sits on the icon's corner instead of disappearing (the rail is the only thing that says something is waiting). */
function CountBadge({
    count,
    testId,
    label,
}: {
    count: number | null;
    testId: string;
    label: (count: number) => string;
}) {
    if (!count) {
        return null;
    }

    return (
        <span
            data-testid={testId}
            className="ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums group-data-[collapsible=icon]:pointer-events-none group-data-[collapsible=icon]:absolute group-data-[collapsible=icon]:end-0 group-data-[collapsible=icon]:top-0 group-data-[collapsible=icon]:h-4 group-data-[collapsible=icon]:min-w-4 group-data-[collapsible=icon]:px-1 group-data-[collapsible=icon]:text-[10px]"
        >
            <span aria-hidden>{count > 99 ? '99+' : count}</span>
            <span className="sr-only">{label(count)}</span>
        </span>
    );
}

function useCount(select: (state: InboxState) => number): number | null {
    return useInboxOptional(select);
}

/** Waiting requests + unread messages, at the end of the "Inbox" sidebar entry. */
export function InboxNavBadge() {
    const plural = usePlural();

    return (
        <CountBadge
            count={useCount(selectAttentionCount)}
            testId="nav-badge-inbox"
            label={(count) => plural('inbox.nav.badge', count)}
        />
    );
}

/** Unclaimed offline tickets, at the end of the "Offline tickets" entry. */
export function TicketsNavBadge() {
    const plural = usePlural();

    return (
        <CountBadge
            count={useCount(selectTicketCount)}
            testId="nav-badge-tickets"
            label={(count) => plural('tickets.nav.badge', count)}
        />
    );
}
