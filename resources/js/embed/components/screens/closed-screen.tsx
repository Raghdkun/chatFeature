import { useController, useSnapshot } from '@/embed/components/context';
import { Check } from '@/embed/components/icons';
import { Button } from '@/embed/components/ui';

/** `closed`: thank-you (or the offline ticket confirmation) and "Start a new chat". */
export function ClosedScreen() {
    const { state, t } = useSnapshot();
    const controller = useController();
    const reason = state.closedReason;
    const ticket = state.offline.ticket;

    const title =
        reason === 'whatsapp'
            ? t('embed.chat.whatsapp.closed_title')
            : reason === 'ticket'
              ? t('embed.chat.offline.sent_title')
              : reason === 'rated' || reason === 'skipped'
                ? t('thanks')
                : t('embed.chat.closed.title');
    const body =
        reason === 'whatsapp'
            ? t('embed.chat.whatsapp.closed_body')
            : reason === 'ticket' && ticket !== null
              ? t('embed.chat.offline.sent_body', {
                    email:
                        state.offline.email || state.form.email.trim() || '…',
                    ticket: ticket.ticketNo,
                })
              : reason === 'idle'
                ? t('embed.chat.closed.idle')
                : reason === 'cancelled'
                  ? t('embed.chat.closed.cancelled')
                  : reason === 'expired'
                    ? t('embed.chat.closed.expired')
                    : reason === 'rated' || reason === 'skipped'
                      ? null
                      : reason === 'ticket'
                        ? null
                        : t('embed.chat.closed.ended');

    return (
        <section className="pne-screen flex min-h-0 flex-1 flex-col items-center gap-5 overflow-y-auto p-6 text-center">
            <span
                aria-hidden="true"
                className="bg-brand-soft text-brand mt-6 grid size-16 place-items-center rounded-full"
            >
                <Check className="size-8" strokeWidth={2.25} />
            </span>
            <div className="flex flex-col gap-2">
                <h2
                    data-screen-title
                    tabIndex={-1}
                    className="text-[20px] leading-snug font-semibold outline-none"
                >
                    {title}
                </h2>
                {body ? (
                    <p className="text-subtle mx-auto max-w-[32ch]">{body}</p>
                ) : null}
            </div>
            <Button
                data-testid="new-chat"
                data-autofocus
                onClick={() => controller.newChat()}
            >
                {t('startNewChat')}
            </Button>
        </section>
    );
}
