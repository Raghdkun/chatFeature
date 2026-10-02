import { BadgeCheck } from 'lucide-react';
import type { ReactNode } from 'react';
import { fullDateTime } from '@/components/inbox/format';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { chatTitle } from '@/components/whatsapp/format';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { useDirection } from '@/hooks/use-direction';
import { useTrans } from '@/hooks/use-trans';
import type { WaChat, WaChatDetail } from '@/lib/whatsapp/types';

function Row({ label, children }: { label: string; children: ReactNode }) {
    return (
        <div className="grid gap-0.5 py-2 first:pt-0 last:pb-0">
            <dt className="text-xs text-muted-foreground">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{children}</dd>
        </div>
    );
}

function Section({
    id,
    title,
    children,
    empty,
}: {
    id: string;
    title: string;
    children?: ReactNode;
    /** Shown instead of the list when there is nothing to list (a `<dl>` may only hold terms and definitions). */
    empty?: ReactNode;
}) {
    return (
        <section aria-labelledby={id}>
            <h3
                id={id}
                className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
                {title}
            </h3>
            {empty ?? <dl className="divide-y">{children}</dl>}
        </section>
    );
}

/**
 * Everything the app knows about this chat: the number and the name WhatsApp shows, the session it is on, and, when a hand-off code
 * matched, the website visit it came from (widget, topic, visitor) and the code that was used. Admin-only, like the whole inbox.
 */
export function ChatDetailsSheet({
    open,
    onOpenChange,
    detail,
    chat,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    detail: WaChatDetail;
    /** The live copy of the chat (the detail's own copy is as old as the page). */
    chat: WaChat;
}) {
    const { t, locale } = useTrans();
    const { isRtl } = useDirection();
    const returnFocus = useReturnFocus(open);
    const { visitor, handoff } = detail;
    const title = chatTitle(chat, t('whatsapp.chat.unknown'));

    return (
        <Sheet open={open} onOpenChange={onOpenChange}>
            <SheetContent
                side={isRtl ? 'left' : 'right'}
                data-testid="wa-details"
                {...returnFocus}
                className="w-full overflow-y-auto sm:max-w-sm"
            >
                <SheetHeader>
                    <SheetTitle>{t('whatsapp.details.title')}</SheetTitle>
                    <SheetDescription>
                        {t('whatsapp.details.description')}
                    </SheetDescription>
                </SheetHeader>

                <div className="grid gap-5 px-4 pb-6">
                    <Section
                        id="wa-details-contact"
                        title={t('whatsapp.details.contact')}
                    >
                        <Row label={t('whatsapp.details.name')}>
                            <span dir="auto">{title}</span>
                        </Row>
                        {chat.phone && (
                            <Row label={t('whatsapp.details.phone')}>
                                <a
                                    href={`tel:${chat.phone}`}
                                    dir="ltr"
                                    className="underline underline-offset-2"
                                >
                                    {chat.phone}
                                </a>
                            </Row>
                        )}
                        {chat.pushName && chat.pushName !== title && (
                            <Row label={t('whatsapp.details.push_name')}>
                                <span dir="auto">{chat.pushName}</span>
                            </Row>
                        )}
                    </Section>

                    <Section
                        id="wa-details-chat"
                        title={t('whatsapp.details.chat')}
                    >
                        <Row label={t('whatsapp.details.session')}>
                            {chat.session.name}
                        </Row>
                        <Row label={t('whatsapp.details.status')}>
                            {t(`whatsapp.status.chat_${chat.status}`)}
                            {chat.isGroup && ` · ${t('whatsapp.chat.group')}`}
                        </Row>
                        <Row label={t('whatsapp.details.started_by')}>
                            {t(
                                chat.inboundInitiated
                                    ? 'whatsapp.details.started_by_customer'
                                    : 'whatsapp.details.started_by_us',
                            )}
                        </Row>
                        <Row label={t('whatsapp.details.first_seen')}>
                            {fullDateTime(chat.createdAt, locale)}
                        </Row>
                        {chat.lastInboundAt && (
                            <Row label={t('whatsapp.details.last_inbound')}>
                                {fullDateTime(chat.lastInboundAt, locale)}
                            </Row>
                        )}
                    </Section>

                    <Section
                        id="wa-details-link"
                        title={t('whatsapp.details.website')}
                        empty={
                            chat.linked ? undefined : (
                                <p
                                    data-testid="wa-details-unlinked"
                                    className="text-sm text-muted-foreground"
                                >
                                    {t('whatsapp.details.unlinked')}
                                </p>
                            )
                        }
                    >
                        {chat.linked && (
                            <>
                                {chat.widget && (
                                    <Row label={t('whatsapp.details.widget')}>
                                        {chat.widget.name}
                                    </Row>
                                )}
                                {chat.category && (
                                    <Row label={t('whatsapp.details.category')}>
                                        {chat.category.label}
                                    </Row>
                                )}
                                {visitor && (
                                    <>
                                        <Row
                                            label={t(
                                                'whatsapp.details.visitor',
                                            )}
                                        >
                                            <span className="inline-flex items-center gap-1.5">
                                                {visitor.name ??
                                                    t(
                                                        'whatsapp.details.anonymous',
                                                    )}
                                                {visitor.verified && (
                                                    <BadgeCheck
                                                        className="size-4 text-primary"
                                                        aria-label={t(
                                                            'whatsapp.details.verified',
                                                        )}
                                                    />
                                                )}
                                            </span>
                                        </Row>
                                        {visitor.email && (
                                            <Row
                                                label={t(
                                                    'whatsapp.details.email',
                                                )}
                                            >
                                                <a
                                                    href={`mailto:${visitor.email}`}
                                                    className="underline underline-offset-2"
                                                >
                                                    {visitor.email}
                                                </a>
                                            </Row>
                                        )}
                                        {visitor.phone && (
                                            <Row
                                                label={t(
                                                    'whatsapp.details.visitor_phone',
                                                )}
                                            >
                                                <span dir="ltr">
                                                    {visitor.phone}
                                                </span>
                                            </Row>
                                        )}
                                    </>
                                )}
                                {handoff && (
                                    <>
                                        <Row label={t('whatsapp.details.code')}>
                                            <span
                                                data-testid="wa-details-code"
                                                dir="ltr"
                                                className="font-mono tracking-wider"
                                            >
                                                {handoff.code}
                                            </span>
                                        </Row>
                                        <Row
                                            label={t(
                                                'whatsapp.details.code_issued',
                                            )}
                                        >
                                            {fullDateTime(
                                                handoff.createdAt,
                                                locale,
                                            )}
                                        </Row>
                                        {handoff.consumedAt && (
                                            <Row
                                                label={t(
                                                    'whatsapp.details.code_used',
                                                )}
                                            >
                                                {fullDateTime(
                                                    handoff.consumedAt,
                                                    locale,
                                                )}
                                            </Row>
                                        )}
                                    </>
                                )}
                            </>
                        )}
                    </Section>
                </div>
            </SheetContent>
        </Sheet>
    );
}
