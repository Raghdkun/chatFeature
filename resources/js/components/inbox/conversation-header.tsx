import { Link } from '@inertiajs/react';
import {
    ArrowLeft,
    BadgeCheck,
    BellRing,
    ClipboardCopy,
    Info,
    LogOut,
    Share2,
} from 'lucide-react';
import { VisitorAvatar } from '@/components/inbox/visitor-avatar';
import {
    shortPageLabel,
    visitorPageUrl,
} from '@/components/inbox/visitor-info';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { ConversationStaff } from '@/lib/chat/types';
import { safeExternalUrl } from '@/lib/urls';

/**
 * Who this is, what it is about, and what the agent can do with it. The back arrow (phones) returns to the list; the queue pill
 * (phones, only while someone waits) keeps Accept one tap away from inside a chat.
 */
export function ConversationHeader({
    conversation,
    waiting,
    canTransfer,
    endAction,
    onDetails,
    onCopy,
    onTransfer,
    onEnd,
}: {
    conversation: ConversationStaff;
    /** Open offers in the queue. */
    waiting: number;
    canTransfer: boolean;
    /** `end` a live chat, `close` an offline ticket, `null` when neither applies. */
    endAction: 'end' | 'close' | null;
    onDetails: () => void;
    onCopy: () => void;
    onTransfer: () => void;
    onEnd: () => void;
}) {
    const { t } = useTrans();
    const { visitor } = conversation;
    const name = visitor.name ?? t('inbox.visitor.anonymous');
    const pageUrl = safeExternalUrl(conversation.pageUrl ?? '') ?? visitorPageUrl(visitor.meta);
    const subline = [
        `#${conversation.ticketNo}`,
        conversation.category?.label,
        conversation.widget.name,
    ].filter(Boolean);

    return (
        <header
            data-testid="conversation-header"
            className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b px-2 py-2.5 sm:px-4"
        >
            <Button asChild variant="ghost" size="icon" className="md:hidden">
                <Link
                    href={staffRoutes.pages.inbox()}
                    data-testid="conversation-back"
                    aria-label={t('inbox.back')}
                >
                    <ArrowLeft className="rtl:-scale-x-100" aria-hidden />
                </Link>
            </Button>

            <VisitorAvatar name={visitor.name} />

            <div className="min-w-32 flex-1">
                <h1 className="flex items-center gap-1.5 text-sm font-semibold sm:text-base">
                    <span className="truncate" data-testid="conversation-name">
                        {name}
                    </span>
                    {visitor.verified && (
                        <span
                            data-testid="conversation-verified"
                            className="inline-flex shrink-0 items-center gap-1 rounded-full bg-accent px-1.5 py-0.5 text-xs font-medium text-accent-foreground"
                        >
                            <BadgeCheck className="size-3.5" aria-hidden />
                            <span className="sr-only sm:not-sr-only">
                                {t('inbox.visitor.verified')}
                            </span>
                        </span>
                    )}
                </h1>
                <p className="truncate text-xs text-muted-foreground">
                    {subline.join(' · ')}
                </p>
                {(visitor.email || visitor.phone || pageUrl) && (
                    <p
                        data-testid="conversation-contact"
                        className="hidden items-center gap-x-2 truncate text-xs text-muted-foreground lg:flex"
                    >
                        {visitor.email && (
                            <a
                                href={`mailto:${visitor.email}`}
                                className="truncate underline-offset-2 hover:underline"
                            >
                                {visitor.email}
                            </a>
                        )}
                        {visitor.phone && (
                            <a
                                href={`tel:${visitor.phone}`}
                                dir="ltr"
                                className="shrink-0 underline-offset-2 hover:underline"
                            >
                                {visitor.phone}
                            </a>
                        )}
                        {pageUrl && (
                            <a
                                href={pageUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                title={pageUrl}
                                className="hidden max-w-56 truncate underline-offset-2 hover:underline xl:inline"
                            >
                                {shortPageLabel(pageUrl)}
                            </a>
                        )}
                    </p>
                )}
            </div>

            {waiting > 0 && (
                <Button
                    asChild
                    variant="outline"
                    size="sm"
                    className="md:hidden"
                >
                    <Link
                        href={staffRoutes.pages.inbox()}
                        data-testid="conversation-queue-pill"
                        aria-label={t('inbox.queue.pill', { count: waiting })}
                    >
                        <BellRing aria-hidden />
                        {waiting}
                    </Link>
                </Button>
            )}

            <div className="ms-auto flex items-center gap-0.5">
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="conversation-info"
                    aria-label={t('inbox.details.open')}
                    title={t('inbox.details.open')}
                    onClick={onDetails}
                >
                    <Info aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    data-testid="copy-transcript"
                    aria-label={t('inbox.transcript.copy')}
                    title={t('inbox.transcript.copy')}
                    onClick={onCopy}
                >
                    <ClipboardCopy aria-hidden />
                </Button>
                {canTransfer && (
                    <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="sm:w-auto sm:px-3"
                        data-testid="transfer-chat"
                        aria-label={t('inbox.transfer.open')}
                        title={t('inbox.transfer.open')}
                        onClick={onTransfer}
                    >
                        <Share2 aria-hidden />
                        <span className="hidden sm:inline">
                            {t('inbox.transfer.open')}
                        </span>
                    </Button>
                )}
                {endAction && (
                    <Button
                        type="button"
                        variant="outline"
                        size="icon"
                        className="ms-1 sm:w-auto sm:px-3"
                        data-testid="end-chat"
                        aria-label={t(`inbox.${endAction}.open`)}
                        title={t(`inbox.${endAction}.open`)}
                        onClick={onEnd}
                    >
                        <LogOut aria-hidden />
                        <span className="hidden sm:inline">
                            {t(`inbox.${endAction}.open`)}
                        </span>
                    </Button>
                )}
            </div>
        </header>
    );
}
