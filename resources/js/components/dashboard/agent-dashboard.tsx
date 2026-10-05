import { MessagesSquare } from 'lucide-react';
import { GhostRows } from '@/components/dashboard/ghost-rows';
import { ServingNotice } from '@/components/dashboard/serving-notice';
import { AvailabilityCard } from '@/components/dashboard/availability-card';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from '@/components/ui/empty';
import { useTrans } from '@/hooks/use-trans';

/**
 * Agent view: an empty inbox plus the availability control. It is the same control as the inbox's (Online / Away / Offline, saved
 * through the staff session, followed live: the server moves an agent to Away and back, and forgets one that went silent), so an agent
 * can go online from the landing page without opening the inbox.
 */
export function AgentDashboard({
    serving,
}: {
    serving?: App.Data.Dashboard.ServingStatusData | null;
}) {
    const { t } = useTrans();

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <ServingNotice
                serving={serving}
                className="lg:col-span-2 lg:row-start-1"
            />
            <AvailabilityCard className="lg:col-start-2 lg:row-start-2" />

            <section
                aria-labelledby="dashboard-waiting-title"
                className="lg:col-start-1 lg:row-start-2"
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
