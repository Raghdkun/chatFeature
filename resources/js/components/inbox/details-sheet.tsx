import { BadgeCheck, ExternalLink } from 'lucide-react';
import type { ReactNode } from 'react';
import { fullDateTime } from '@/components/inbox/format';
import { PAGE_URL_KEYS, visitorPageUrl } from '@/components/inbox/visitor-info';
import { safeExternalUrl } from '@/lib/urls';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { useDirection } from '@/hooks/use-direction';
import { useTrans } from '@/hooks/use-trans';
import type { ConversationStaff } from '@/lib/chat/types';

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid gap-0.5 py-2 first:pt-0 last:pb-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

/** Everything the server knows about this visitor and chat, in a side sheet (a full-width sheet on a phone). */
export function DetailsSheet({
    open,
    onOpenChange,
    conversation,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    conversation: ConversationStaff;
}) {
    const { t, locale } = useTrans();
    const { isRtl } = useDirection();
    const returnFocus = useReturnFocus(open);
    const { visitor } = conversation;
    // The page the visitor was on: what the session reported (as the header shows it), else a URL the host put into the metadata.
    const page =
        safeExternalUrl(conversation.pageUrl ?? '') ??
        visitorPageUrl(visitor.meta);
    const extra = Object.entries(visitor.meta).filter(
        ([key, value]) =>
            !PAGE_URL_KEYS.includes(key) && value !== null && value !== '',
    );

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side={isRtl ? 'left' : 'right'}
                data-testid="conversation-details"
                {...returnFocus}
                className="w-full overflow-y-auto sm:max-w-sm"
            >
                <SheetHeader>
                    <SheetTitle>{t('inbox.details.title')}</SheetTitle>
                    <SheetDescription>
                        {t('inbox.details.description')}
                    </SheetDescription>
                </SheetHeader>

                <div className="grid gap-5 px-4 pb-6">
                    <section aria-labelledby="details-visitor">
                        <h3
                            id="details-visitor"
                            className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                            {t('inbox.details.visitor')}
                        </h3>
                        <dl className="divide-y">
                            <Row label={t('inbox.details.name')}>
                                <span className="inline-flex items-center gap-1.5">
                                    {visitor.name ??
                                        t('inbox.visitor.anonymous')}
                                    {visitor.verified && (
                                        <BadgeCheck
                                            className="size-4 text-primary"
                                            aria-label={t(
                                                'inbox.visitor.verified',
                                            )}
                                        />
                                    )}
                                </span>
                            </Row>
                            {visitor.email && (
                                <Row label={t('inbox.details.email')}>
                                    <a
                                        href={`mailto:${visitor.email}`}
                                        className="underline underline-offset-2"
                                    >
                                        {visitor.email}
                                    </a>
                                </Row>
                            )}
                            {visitor.phone && (
                                <Row label={t('inbox.details.phone')}>
                                    <a
                                        href={`tel:${visitor.phone}`}
                                        dir="ltr"
                                        className="underline underline-offset-2"
                                    >
                                        {visitor.phone}
                                    </a>
                                </Row>
                            )}
                            {page && (
                                <Row label={t('inbox.details.page')}>
                                    <a
                                        href={page}
                                        target="_blank"
                                        rel="noopener noreferrer"
                                        title={
                                            conversation.pageTitle ?? undefined
                                        }
                                        className="inline-flex items-center gap-1 underline underline-offset-2"
                                    >
                                        <span className="break-all">
                                            {page}
                                        </span>
                                        <ExternalLink
                                            className="size-3.5 shrink-0 rtl:-scale-x-100"
                                            aria-hidden
                                        />
                                    </a>
                                </Row>
                            )}
                            {extra.map(([key, value]) => (
                                <Row key={key} label={key}>
                                    {String(value)}
                                </Row>
                            ))}
                        </dl>
                    </section>

                    <section aria-labelledby="details-chat">
                        <h3
                            id="details-chat"
                            className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                        >
                            {t('inbox.details.chat')}
                        </h3>
                        <dl className="divide-y">
                            <Row label={t('inbox.details.ticket')}>
                                <span className="font-mono tracking-wider">
                                    {conversation.ticketNo}
                                </span>
                            </Row>
                            <Row label={t('inbox.details.status')}>
                                {t(`inbox.status.${conversation.status}`)} ·{' '}
                                {t(`inbox.type.${conversation.type}`)}
                            </Row>
                            {conversation.category && (
                                <Row label={t('inbox.details.category')}>
                                    {conversation.category.label}
                                </Row>
                            )}
                            <Row label={t('inbox.details.widget')}>
                                {conversation.widget.name}
                            </Row>
                            {conversation.assignedAgent && (
                                <Row label={t('inbox.details.agent')}>
                                    {conversation.assignedAgent.name}
                                </Row>
                            )}
                            <Row label={t('inbox.details.started')}>
                                {fullDateTime(conversation.createdAt, locale)}
                            </Row>
                            {conversation.claimedAt && (
                                <Row label={t('inbox.details.claimed')}>
                                    {fullDateTime(
                                        conversation.claimedAt,
                                        locale,
                                    )}
                                </Row>
                            )}
                            {conversation.endedAt && (
                                <Row label={t('inbox.details.ended')}>
                                    {fullDateTime(conversation.endedAt, locale)}
                                </Row>
                            )}
                        </dl>
                    </section>
                </div>
            </SheetContent>
        </Sheet>
    );
}
