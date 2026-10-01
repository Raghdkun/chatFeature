import { useTrans } from '@/hooks/use-trans';
import { useInboxOptional } from '@/lib/realtime/staff/context';
import {
    selectAttentionCount,
    selectTicketCount,
    type InboxState,
} from '@/lib/realtime/staff/store';

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
            className="ms-auto inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-primary-foreground tabular-nums group-data-[collapsible=icon]:hidden"
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
    const { t } = useTrans();

    return (
        <CountBadge
            count={useCount(selectAttentionCount)}
            testId="nav-badge-inbox"
            label={(count) => t('inbox.nav.badge', { count })}
        />
    );
}

/** Unclaimed offline tickets, at the end of the "Offline tickets" entry. */
export function TicketsNavBadge() {
    const { t } = useTrans();

    return (
        <CountBadge
            count={useCount(selectTicketCount)}
            testId="nav-badge-tickets"
            label={(count) => t('tickets.nav.badge', { count })}
        />
    );
}
