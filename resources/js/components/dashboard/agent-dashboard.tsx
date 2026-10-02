import { MessagesSquare } from 'lucide-react';
import { useId } from 'react';
import { GhostRows } from '@/components/dashboard/ghost-rows';
import { PresenceSelect } from '@/components/inbox/presence-select';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import {
    useInboxOptional,
    useStaffRealtimeOptional,
} from '@/lib/realtime/staff/context';

/**
 * Agent view: an empty inbox plus the availability control. It is the same control as the inbox's (Online / Away / Offline, saved
 * through the staff session, followed live: the server moves an agent to Away and back, and forgets one that went silent), so an agent
 * can go online from the landing page without opening the inbox.
 */
export function AgentDashboard() {
    const { t } = useTrans();
    const session = useStaffRealtimeOptional();
    const status = useInboxOptional((state) => state.presence);
    const selectId = useId();

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section
                aria-labelledby="dashboard-availability-title"
                className="grid content-start gap-3 rounded-xl border bg-card p-5 sm:p-6 lg:col-start-2 lg:row-start-1"
                data-testid="dashboard-availability"
            >
                <h2
                    id="dashboard-availability-title"
                    className="text-sm font-semibold"
                >
                    {t('dashboard.agent.availability')}
                </h2>
                <Label
                    htmlFor={selectId}
                    className="text-xs font-semibold tracking-wide text-muted-foreground uppercase"
                >
                    {t('inbox.presence.label')}
                </Label>
                <PresenceSelect
                    id={selectId}
                    status={status}
                    onChange={(next) =>
                        void session?.controller.setPresence(next)
                    }
                />
                {status === 'offline' ? (
                    <Notice
                        tone="warning"
                        data-testid="dashboard-availability-offline"
                        className="text-xs"
                    >
                        <p>{t('inbox.presence.offline_notice')}</p>
                        <Button
                            type="button"
                            size="sm"
                            variant="outline"
                            className="mt-2 bg-background"
                            data-testid="dashboard-availability-go-online"
                            onClick={() =>
                                void session?.controller.setPresence('online')
                            }
                        >
                            {t('inbox.presence.go_online')}
                        </Button>
                    </Notice>
                ) : (
                    <p className="text-sm text-muted-foreground">
                        {t('dashboard.agent.availability_note')}
                    </p>
                )}
            </section>

            <section
                aria-labelledby="dashboard-waiting-title"
                className="lg:col-start-1 lg:row-start-1"
                data-testid="dashboard-agent-waiting"
            >
                <Empty className="rounded-xl border border-dashed bg-card/50">
                    <EmptyHeader>
                        <EmptyMedia variant="icon">
                            <MessagesSquare aria-hidden />
                        </EmptyMedia>
                        <h2
                            id="dashboard-waiting-title"
                            className="text-lg font-medium tracking-tight"
                        >
                            {t('dashboard.agent.title')}
                        </h2>
                        <EmptyDescription>
                            {t('dashboard.agent.description')}
                        </EmptyDescription>
                    </EmptyHeader>
                    <EmptyContent>
                        <GhostRows count={3} />
                    </EmptyContent>
                </Empty>
            </section>
        </div>
    );
}
