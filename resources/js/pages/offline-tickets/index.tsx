import { Head, router } from '@inertiajs/react';
import { Ticket } from 'lucide-react';
import { useLayoutEffect, useState } from 'react';
import { toast } from 'sonner';
import { EndChatDialog } from '@/components/inbox/end-chat-dialog';
import { OfflineTicketsLayout } from '@/components/inbox/inbox-layout';
import { TicketCard } from '@/components/inbox/ticket-card';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import {
    PageHeader,
    PageShell,
    usePlural,
} from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import {
    staffApi,
    describeStaffError,
    staffRoutes,
} from '@/lib/chat-api/staff';
import {
    useInbox,
    useStaffRealtimeContext,
} from '@/lib/realtime/staff/context';
import type { OfflineTicketsPageProps } from '@/types/chat-staff';

export default function OfflineTicketsIndex({
    tickets: initial,
}: OfflineTicketsPageProps) {
    const { t } = useTrans();
    const plural = usePlural();
    const { store, controller, viewer } = useStaffRealtimeContext();
    const tickets = useInbox((state) => state.tickets);
    const [closing, setClosing] = useState<string | null>(null);

    // Seed the live list from the props before the first paint; realtime events and the REST sync keep it current.
    useLayoutEffect(() => {
        store.dispatch({ type: 'hydrate', tickets: initial });
    }, [store, initial]);

    const claim = async (ulid: string): Promise<void> => {
        const outcome = await controller.claim(ulid);

        if (outcome.ok) {
            toast.success(t('tickets.claimed'));
            router.visit(staffRoutes.pages.conversation(ulid));
        }
    };

    const close = async (ulid: string): Promise<boolean> => {
        try {
            const closed = await staffApi.close(ulid);

            store.dispatch({
                type: 'conversationUpdated',
                conversation: closed,
                viewer,
            });
            toast.success(t('tickets.closed'));

            return true;
        } catch (error) {
            toast.error(describeStaffError(error, t));

            return false;
        }
    };

    const unclaimed = tickets.filter(
        (ticket) => ticket.status === 'queued',
    ).length;

    return (
        <>
            <Head title={t('tickets.title')} />

            <PageShell testId="tickets-page">
                <PageHeader
                    title={t('tickets.title')}
                    description={t('tickets.description')}
                />

                {tickets.length === 0 ? (
                    <Empty
                        data-testid="tickets-empty"
                        className="border bg-card"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Ticket aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>{t('tickets.empty.title')}</EmptyTitle>
                            <EmptyDescription>
                                {t('tickets.empty.body')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <section aria-labelledby="tickets-count">
                        <h2
                            id="tickets-count"
                            data-testid="tickets-count"
                            className="mb-3 text-sm text-muted-foreground"
                        >
                            {plural('tickets.unclaimed', unclaimed)}
                        </h2>
                        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2">
                            {tickets.map((ticket) => (
                                <TicketCard
                                    key={ticket.ulid}
                                    ticket={ticket}
                                    viewerId={viewer.id}
                                    canClaim={viewer.isAgent}
                                    onClaim={claim}
                                    onClose={setClosing}
                                />
                            ))}
                        </ul>
                    </section>
                )}
            </PageShell>

            <EndChatDialog
                open={closing !== null}
                mode="close"
                onOpenChange={(open) => {
                    if (!open) {
                        setClosing(null);
                    }
                }}
                onConfirm={() =>
                    closing ? close(closing) : Promise.resolve(false)
                }
            />
        </>
    );
}

OfflineTicketsIndex.layout = OfflineTicketsLayout;
