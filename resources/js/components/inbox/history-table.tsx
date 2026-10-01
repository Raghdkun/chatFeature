import { Link } from '@inertiajs/react';
import { Star } from 'lucide-react';
import { fullDateTime } from '@/components/inbox/format';
import { StatusBadge } from '@/components/inbox/status-badge';
import { VisitorAvatar } from '@/components/inbox/visitor-avatar';
import {
    Table,
    TableBody,
    TableCell,
    TableHead,
    TableHeader,
    TableRow,
} from '@/components/ui/table';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { ConversationStaff, RatingData } from '@/lib/chat/types';

function Rating({ rating }: { rating: RatingData | undefined }) {
    const { t } = useTrans();

    if (!rating) {
        return <span className="text-muted-foreground">-</span>;
    }

    return (
        <span
            className="inline-flex items-center gap-1 tabular-nums"
            title={rating.comment ?? undefined}
        >
            <Star
                className="size-3.5 fill-current text-amber-500"
                aria-hidden
            />
            {rating.score}
            <span className="sr-only">
                {t('history.rating.label', { score: rating.score })}
            </span>
        </span>
    );
}

/**
 * The results: a table from `md` up, cards below it (a nine-column table is unreadable on a phone). Every row opens the conversation
 * (read-only once it is closed).
 */
export function HistoryTable({
    conversations,
    ratings,
}: {
    conversations: ConversationStaff[];
    ratings: RatingData[];
}) {
    const { t, locale } = useTrans();
    const byConversation = new Map(
        ratings.map((rating) => [rating.conversation, rating]),
    );

    return (
        <>
            <div className="hidden md:block">
                <Table data-testid="history-table">
                    <TableHeader>
                        <TableRow>
                            <TableHead>{t('history.col.visitor')}</TableHead>
                            <TableHead>{t('history.col.ticket')}</TableHead>
                            <TableHead>{t('history.col.category')}</TableHead>
                            <TableHead>{t('history.col.status')}</TableHead>
                            <TableHead>{t('history.col.agent')}</TableHead>
                            <TableHead>{t('history.col.rating')}</TableHead>
                            <TableHead>{t('history.col.started')}</TableHead>
                        </TableRow>
                    </TableHeader>
                    <TableBody>
                        {conversations.map((conversation) => (
                            <TableRow
                                key={conversation.ulid}
                                data-testid={`history-row-${conversation.ulid}`}
                            >
                                <TableCell className="max-w-64">
                                    <Link
                                        href={staffRoutes.pages.conversation(
                                            conversation.ulid,
                                        )}
                                        className="flex items-center gap-2.5 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                    >
                                        <VisitorAvatar
                                            name={conversation.visitor.name}
                                            className="size-8"
                                        />
                                        <span className="min-w-0">
                                            <span className="block truncate font-medium">
                                                {conversation.visitor.name ??
                                                    t(
                                                        'inbox.visitor.anonymous',
                                                    )}
                                            </span>
                                            {conversation.visitor.email && (
                                                <span className="block truncate text-xs text-muted-foreground">
                                                    {conversation.visitor.email}
                                                </span>
                                            )}
                                        </span>
                                    </Link>
                                </TableCell>
                                <TableCell className="font-mono text-xs tracking-wider">
                                    {conversation.ticketNo}
                                </TableCell>
                                <TableCell>
                                    {conversation.category?.label ?? '-'}
                                </TableCell>
                                <TableCell>
                                    <span className="flex flex-wrap items-center gap-1.5">
                                        <StatusBadge
                                            status={conversation.status}
                                        />
                                        {conversation.type === 'offline' && (
                                            <span className="text-xs text-muted-foreground">
                                                {t('inbox.type.offline')}
                                            </span>
                                        )}
                                    </span>
                                </TableCell>
                                <TableCell>
                                    {conversation.assignedAgent?.name ?? '-'}
                                </TableCell>
                                <TableCell>
                                    <Rating
                                        rating={byConversation.get(
                                            conversation.ulid,
                                        )}
                                    />
                                </TableCell>
                                <TableCell className="text-muted-foreground tabular-nums">
                                    {fullDateTime(
                                        conversation.createdAt,
                                        locale,
                                    )}
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </div>

            <ul
                className="grid grid-cols-1 divide-y md:hidden"
                data-testid="history-cards"
            >
                {conversations.map((conversation) => (
                    <li
                        key={conversation.ulid}
                        data-testid={`history-card-${conversation.ulid}`}
                        className="min-w-0"
                    >
                        <Link
                            href={staffRoutes.pages.conversation(
                                conversation.ulid,
                            )}
                            className="grid grid-cols-1 gap-1.5 px-4 py-3 outline-none hover:bg-accent/50 focus-visible:bg-accent/60"
                        >
                            <span className="flex items-center justify-between gap-2">
                                <span className="min-w-0 truncate font-medium">
                                    {conversation.visitor.name ??
                                        t('inbox.visitor.anonymous')}
                                </span>
                                <StatusBadge status={conversation.status} />
                            </span>
                            <span className="flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                                <span className="font-mono tracking-wider">
                                    #{conversation.ticketNo}
                                </span>
                                {conversation.category && (
                                    <span>{conversation.category.label}</span>
                                )}
                                {conversation.assignedAgent && (
                                    <span>
                                        {conversation.assignedAgent.name}
                                    </span>
                                )}
                                <Rating
                                    rating={byConversation.get(
                                        conversation.ulid,
                                    )}
                                />
                            </span>
                            <span className="text-xs text-muted-foreground">
                                {fullDateTime(conversation.createdAt, locale)}
                            </span>
                        </Link>
                    </li>
                ))}
            </ul>
        </>
    );
}
