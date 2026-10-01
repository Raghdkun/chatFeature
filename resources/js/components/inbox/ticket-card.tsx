import { Link } from '@inertiajs/react';
import { Check, Mail, MessageSquareReply, X } from 'lucide-react';
import { useState } from 'react';
import { fullDateTime, shortAge } from '@/components/inbox/format';
import { StatusBadge } from '@/components/inbox/status-badge';
import { useNow } from '@/components/inbox/use-now';
import { VisitorAvatar } from '@/components/inbox/visitor-avatar';
import { Button } from '@/components/ui/button';
import { Busy } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { ConversationStaff } from '@/lib/chat/types';

/**
 * One offline ticket: who wrote, what about, and the three things an agent does with it: claim it (unclaimed), reply (it opens the
 * conversation, where the answer is a normal message the server also e-mails) and close it once it is answered.
 */
export function TicketCard({
    ticket,
    viewerId,
    canClaim,
    onClaim,
    onClose,
}: {
    ticket: ConversationStaff;
    viewerId: number;
    /** Only agents take tickets; an admin who does not can still read and close them. */
    canClaim: boolean;
    onClaim: (ulid: string) => Promise<void>;
    onClose: (ulid: string) => void;
}) {
    const { t, locale } = useTrans();
    const now = useNow();
    const [claiming, setClaiming] = useState(false);
    const name = ticket.visitor.name ?? t('inbox.visitor.anonymous');
    const claimed = ticket.status === 'active';
    const mine = ticket.assignedAgent?.id === viewerId;
    const age = shortAge(ticket.createdAt, now, locale, t);

    const claim = async (): Promise<void> => {
        setClaiming(true);

        try {
            await onClaim(ticket.ulid);
        } finally {
            setClaiming(false);
        }
    };

    return (
        <li
            data-testid={`ticket-${ticket.ulid}`}
            data-status={ticket.status}
            className="rounded-xl border bg-card p-4 shadow-xs"
        >
            <div className="flex items-start gap-3">
                <VisitorAvatar name={ticket.visitor.name} />
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h2 className="truncate text-sm font-semibold">
                            {name}
                        </h2>
                        <StatusBadge status={ticket.status} />
                    </div>
                    <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                        {ticket.visitor.email && (
                            <a
                                href={`mailto:${ticket.visitor.email}`}
                                className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
                            >
                                <Mail className="size-3" aria-hidden />
                                {ticket.visitor.email}
                            </a>
                        )}
                        <span className="font-mono tracking-wider">
                            #{ticket.ticketNo}
                        </span>
                        {ticket.category && (
                            <span>{ticket.category.label}</span>
                        )}
                        <time
                            dateTime={ticket.createdAt}
                            title={
                                fullDateTime(ticket.createdAt, locale) ??
                                undefined
                            }
                        >
                            {age}
                        </time>
                    </p>
                </div>
            </div>

            {ticket.lastMessagePreview && (
                <p className="mt-3 line-clamp-3 text-sm break-words text-foreground/90">
                    {ticket.lastMessagePreview}
                </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
                {!claimed && canClaim && (
                    <Button
                        type="button"
                        size="sm"
                        disabled={claiming}
                        data-testid={`ticket-claim-${ticket.ulid}`}
                        onClick={() => void claim()}
                    >
                        {claiming ? <Busy /> : <Check aria-hidden />}
                        {t('tickets.claim')}
                    </Button>
                )}
                <Button
                    asChild
                    size="sm"
                    variant={claimed ? 'default' : 'outline'}
                >
                    <Link
                        href={staffRoutes.pages.conversation(ticket.ulid)}
                        data-testid={`ticket-reply-${ticket.ulid}`}
                    >
                        <MessageSquareReply
                            className="rtl:-scale-x-100"
                            aria-hidden
                        />
                        {claimed ? t('tickets.reply') : t('tickets.view')}
                    </Link>
                </Button>
                {claimed && (
                    <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        data-testid={`ticket-close-${ticket.ulid}`}
                        onClick={() => onClose(ticket.ulid)}
                    >
                        <X aria-hidden />
                        {t('tickets.close')}
                    </Button>
                )}
                {claimed && !mine && ticket.assignedAgent && (
                    <span className="text-xs text-muted-foreground">
                        {t('tickets.claimed_by', {
                            name: ticket.assignedAgent.name,
                        })}
                    </span>
                )}
            </div>
        </li>
    );
}
