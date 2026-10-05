import { useId } from 'react';
import { PresenceSelect } from '@/components/inbox/presence-select';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Notice } from '@/components/widgets/form-bits';
import { useTrans } from '@/hooks/use-trans';
import {
    useInboxOptional,
    useStaffRealtimeOptional,
} from '@/lib/realtime/staff/context';
import { cn } from '@/lib/utils';

/**
 * The availability control of the dashboard: the same one as the inbox's (Online / Away / Offline, saved through the staff session and
 * followed live), so somebody who takes chats can go online from the landing page without opening the inbox.
 */
export function AvailabilityCard({ className }: { className?: string }) {
    const { t } = useTrans();
    const session = useStaffRealtimeOptional();
    const status = useInboxOptional((state) => state.presence);
    const selectId = useId();

    return (
        <section
            aria-labelledby="dashboard-availability-title"
            className={cn(
                'grid content-start gap-3 rounded-xl border bg-card p-5 sm:p-6',
                className,
            )}
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
                onChange={(next) => void session?.controller.setPresence(next)}
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
    );
}
