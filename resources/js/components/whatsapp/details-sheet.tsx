import { BadgeCheck, ShieldAlert, Trash2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { fullDateTime } from '@/components/inbox/format';
import { useReturnFocus } from '@/components/inbox/use-return-focus';
import { chatTitle } from '@/components/whatsapp/format';
import { ConfirmDialog } from '@/components/whatsapp/settings/confirm-dialog';
import { Button } from '@/components/ui/button';
import {
    Sheet,
    SheetContent,
    SheetDescription,
    SheetHeader,
    SheetTitle,
} from '@/components/ui/sheet';
import { useDirection } from '@/hooks/use-direction';
import { useTrans } from '@/hooks/use-trans';
import { describeWaError } from '@/lib/whatsapp-api/client';
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
    note,
}: {
    id: string;
    title: string;
    children?: ReactNode;
    /** Shown instead of the list when there is nothing to list (a `<dl>` may only hold terms and definitions). */
    empty?: ReactNode;
    /** Between the title and the list: a qualification of everything listed (it is not a term of the list itself). */
    note?: ReactNode;
}) {
    return (
        <section aria-labelledby={id}>
            <h3
                id={id}
                className="mb-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
                {title}
            </h3>
            {note}
            {empty ?? <dl className="divide-y">{children}</dl>}
        </section>
    );
}

/**
 * Everything the app knows about this chat: the number and the name WhatsApp shows, the session it is on, and, when a hand-off code
 * matched, the website visit it came from (widget, topic, visitor) and the code that was used. Admin-only, like the whole inbox.
 *
 * What a hand-off code says is NOT verified: the code is a secret that links the first WhatsApp number to send it, so the website
 * details are marked as such. The sheet also holds the one irreversible action, deleting the chat (a confirmation first).
 */
export function ChatDetailsSheet({
    open,
    onOpenChange,
    detail,
    chat,
    onDelete,
}: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    detail: WaChatDetail;
    /** The live copy of the chat (the detail's own copy is as old as the page). */
    chat: WaChat;
    /** Hard-delete the chat; resolves when it is gone, throws what the server said otherwise. Absent = the action is not offered. */
    onDelete?: () => Promise<void>;
}) {
    const { t, locale } = useTrans();
    const { isRtl } = useDirection();
    const returnFocus = useReturnFocus(open);
    const [confirming, setConfirming] = useState(false);
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
                        note={
                            chat.linked ? (
                                <div
                                    data-testid="wa-details-unverified"
                                    className="mb-2 grid gap-1"
                                >
                                    <span className="inline-flex w-fit items-center gap-1.5 rounded-md border border-amber-500/50 bg-amber-500/10 px-2 py-0.5 text-xs font-medium">
                                        <ShieldAlert
                                            className="size-3.5"
                                            aria-hidden
                                        />
                                        {t('whatsapp.details.unverified')}
                                    </span>
                                    <p
                                        id="wa-details-unverified-hint"
                                        className="text-xs text-muted-foreground"
                                    >
                                        {t('whatsapp.details.unverified_hint')}
                                    </p>
                                </div>
                            ) : undefined
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

                    {onDelete && (
                        <Section
                            id="wa-details-delete"
                            title={t('whatsapp.details.delete_section')}
                            empty={
                                <div className="grid gap-2">
                                    <p className="text-sm text-muted-foreground">
                                        {t('whatsapp.details.delete_hint')}
                                    </p>
                                    <Button
                                        type="button"
                                        variant="outline"
                                        data-testid="wa-details-delete"
                                        className="w-fit border-destructive/50 text-destructive hover:text-destructive"
                                        onClick={() => setConfirming(true)}
                                    >
                                        <Trash2 aria-hidden />
                                        {t('whatsapp.details.delete')}
                                    </Button>
                                </div>
                            }
                        />
                    )}
                </div>

                {onDelete && (
                    <ConfirmDialog
                        open={confirming}
                        testId="wa-delete-chat-dialog"
                        title={t('whatsapp.delete_chat.title')}
                        body={t('whatsapp.delete_chat.body', { name: title })}
                        confirm={t('whatsapp.delete_chat.confirm')}
                        cancel={t('whatsapp.cancel')}
                        destructive
                        error={(failure) => describeWaError(failure, t, locale)}
                        onClose={() => setConfirming(false)}
                        onConfirm={async () => {
                            await onDelete();
                            setConfirming(false);
                        }}
                    />
                )}
            </SheetContent>
        </Sheet>
    );
}
