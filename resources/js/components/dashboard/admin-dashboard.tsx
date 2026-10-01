import {
    Code,
    Inbox,
    Palette,
    Tags,
    Users,
    type LucideIcon,
} from 'lucide-react';
import { GhostRows } from '@/components/dashboard/ghost-rows';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useTrans } from '@/hooks/use-trans';
import { cn } from '@/lib/utils';

const STEPS: { key: string; icon: LucideIcon }[] = [
    { key: 'category', icon: Tags },
    { key: 'widget', icon: Palette },
    { key: 'agents', icon: Users },
    { key: 'embed', icon: Code },
];

/**
 * Admin view while nothing is configured yet. The checklist rows do not link anywhere
 * until the catalog and widget pages exist (P3).
 */
export function AdminDashboard() {
    const { t } = useTrans();
    const done = 0;

    return (
        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
            <section
                aria-labelledby="dashboard-setup-title"
                className="rounded-xl border bg-card"
                data-testid="dashboard-admin-setup"
            >
                <div className="grid gap-3 p-5 sm:p-6">
                    <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                        <h2
                            id="dashboard-setup-title"
                            className="text-lg font-semibold tracking-tight"
                        >
                            {t('dashboard.admin.title')}
                        </h2>
                        <p className="text-sm text-muted-foreground tabular-nums">
                            {t('dashboard.admin.progress', {
                                done,
                                total: STEPS.length,
                            })}
                        </p>
                    </div>
                    <p className="max-w-prose text-sm text-muted-foreground">
                        {t('dashboard.admin.description')}
                    </p>
                    <Progress
                        value={(done / STEPS.length) * 100}
                        aria-label={t('dashboard.admin.progress', {
                            done,
                            total: STEPS.length,
                        })}
                        className="h-1.5"
                    />
                </div>

                <ol className="border-t">
                    {STEPS.map(({ key, icon: Icon }, index) => (
                        <li
                            key={key}
                            data-testid={`dashboard-admin-step-${key}`}
                            className={cn(
                                'flex items-start gap-4 px-5 py-4 sm:px-6',
                                index > 0 && 'border-t',
                                index === 0 && 'bg-accent/30',
                            )}
                        >
                            <span
                                className={cn(
                                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                                    index === 0
                                        ? 'bg-primary text-primary-foreground'
                                        : 'bg-secondary text-secondary-foreground',
                                )}
                                aria-hidden
                            >
                                <Icon className="size-4" />
                            </span>
                            <div className="min-w-0 flex-1">
                                <p className="font-medium">
                                    {t(`dashboard.admin.steps.${key}.title`)}
                                </p>
                                <p className="mt-0.5 text-sm text-muted-foreground">
                                    {t(
                                        `dashboard.admin.steps.${key}.description`,
                                    )}
                                </p>
                            </div>
                            <Badge variant="secondary" className="shrink-0">
                                {t('common.soon')}
                            </Badge>
                        </li>
                    ))}
                </ol>
            </section>

            <div className="grid content-start gap-6">
                <section
                    aria-labelledby="dashboard-queue-title"
                    className="grid gap-5 rounded-xl border bg-card p-5 sm:p-6"
                    data-testid="dashboard-queue"
                >
                    <div className="flex items-center gap-3">
                        <span
                            className="flex size-9 items-center justify-center rounded-lg bg-secondary text-secondary-foreground"
                            aria-hidden
                        >
                            <Inbox className="size-4" />
                        </span>
                        <div>
                            <h2
                                id="dashboard-queue-title"
                                className="text-sm font-semibold"
                            >
                                {t('dashboard.queue.title')}
                            </h2>
                            <p className="text-sm text-muted-foreground">
                                {t('dashboard.queue.empty')}
                            </p>
                        </div>
                    </div>
                    <GhostRows count={3} />
                    <p className="text-sm text-muted-foreground">
                        {t('dashboard.queue.empty_hint')}
                    </p>
                </section>

                <section
                    aria-labelledby="dashboard-team-title"
                    className="rounded-xl border bg-card p-5 sm:p-6"
                    data-testid="dashboard-team"
                >
                    <h2
                        id="dashboard-team-title"
                        className="text-sm font-semibold"
                    >
                        {t('dashboard.team.title')}
                    </h2>
                    <p className="mt-1 text-sm text-muted-foreground">
                        {t('dashboard.team.empty')}
                    </p>
                </section>
            </div>
        </div>
    );
}
