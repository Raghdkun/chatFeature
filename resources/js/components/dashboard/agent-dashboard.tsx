import { MessagesSquare } from 'lucide-react';
import { useState } from 'react';
import { GhostRows } from '@/components/dashboard/ghost-rows';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
} from '@/components/ui/empty';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTrans } from '@/hooks/use-trans';
import { cn } from '@/lib/utils';

/**
 * Agent view: an empty inbox plus an availability switch. The switch is a placeholder:
 * presence arrives in P5, so it only keeps local state for now.
 */
export function AgentDashboard() {
    const { t } = useTrans();
    const [available, setAvailable] = useState(false);

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
            <section
                aria-labelledby="dashboard-availability-title"
                className="grid content-start gap-3 rounded-xl border bg-card p-5 sm:p-6 lg:col-start-2 lg:row-start-1"
                data-testid="dashboard-availability"
            >
                <div className="flex items-center justify-between gap-4">
                    <Label
                        id="dashboard-availability-title"
                        htmlFor="dashboard-availability-switch"
                        className="text-sm font-semibold"
                    >
                        {t('dashboard.agent.availability')}
                    </Label>
                    <Switch
                        id="dashboard-availability-switch"
                        checked={available}
                        onCheckedChange={setAvailable}
                        aria-describedby="dashboard-availability-note"
                        data-testid="dashboard-availability-switch"
                    />
                </div>
                <p
                    role="status"
                    className={cn(
                        'text-sm font-medium',
                        available ? 'text-primary' : 'text-muted-foreground',
                    )}
                >
                    {available
                        ? t('dashboard.agent.availability_on')
                        : t('dashboard.agent.availability_off')}
                </p>
                <p
                    id="dashboard-availability-note"
                    className="text-sm text-muted-foreground"
                >
                    {t('dashboard.agent.availability_note')}
                </p>
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
