import { Link } from '@inertiajs/react';
import {
    ArrowRight,
    Check,
    Code,
    Inbox,
    Palette,
    Tags,
    Users,
    type LucideIcon,
} from 'lucide-react';
import { AvailabilityCard } from '@/components/dashboard/availability-card';
import { GhostRows } from '@/components/dashboard/ghost-rows';
import { ServingNotice } from '@/components/dashboard/serving-notice';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { useTrans } from '@/hooks/use-trans';
import { useInboxOptional } from '@/lib/realtime/staff/context';
import { cn } from '@/lib/utils';
import { widgetsRoutes } from '@/lib/widgets-routes';

type StepKey = 'category' | 'widget' | 'agents' | 'embed';

type Step = {
    key: StepKey;
    icon: LucideIcon;
    done: boolean;
    href: string;
    /** What is still missing, in one sentence (only while the step is not done). */
    hint: string | null;
};

/** Where each step leads and what is missing, read from the real configuration. */
export function setupSteps(
    setup: App.Data.Dashboard.SetupStatusData,
    t: (key: string) => string,
): Step[] {
    const builder = (tab?: string) =>
        setup.widgetUlid === null
            ? widgetsRoutes.pages.widgets()
            : `${widgetsRoutes.pages.widget(setup.widgetUlid)}${tab ? `?tab=${tab}` : ''}`;

    let embedHint: string | null = null;
    let embedTab: string | undefined;

    if (setup.widgets === 0) {
        embedHint = t('dashboard.admin.hint.widget_none');
    } else if (setup.widgetsLive === 0) {
        embedHint = t('dashboard.admin.hint.embed_offline');
        embedTab = 'general';
    } else if (setup.widgetsReachable === 0) {
        embedHint = t('dashboard.admin.hint.embed_domains');
        embedTab = 'domains';
    }

    const embedDone = setup.widgetsReachable > 0;

    return [
        {
            key: 'category',
            icon: Tags,
            done: setup.categories > 0,
            href: widgetsRoutes.pages.categories(),
            hint: null,
        },
        {
            key: 'widget',
            icon: Palette,
            done: setup.widgetCustomised,
            href: builder(),
            hint:
                setup.widgets === 0
                    ? t('dashboard.admin.hint.widget_none')
                    : null,
        },
        {
            key: 'agents',
            icon: Users,
            done: setup.agentsServing > 0,
            href: widgetsRoutes.pages.agents(),
            hint: t('dashboard.admin.hint.agents'),
        },
        {
            key: 'embed',
            icon: Code,
            done: embedDone,
            href: builder(embedDone ? 'embed' : embedTab),
            hint: embedDone ? null : embedHint,
        },
    ];
}

/**
 * Admin landing page: a setup checklist read from the real configuration (each row opens the page where the step is done), the live
 * queue and who is online. It says what is missing between an empty install and a visitor reaching an agent.
 */
export function AdminDashboard({
    setup,
    serving,
}: {
    setup: App.Data.Dashboard.SetupStatusData;
    serving: App.Data.Dashboard.ServingStatusData | null;
}) {
    const { t } = useTrans();
    const steps = setupSteps(setup, t);
    const done = steps.filter((step) => step.done).length;
    const complete = done === steps.length;
    const current = steps.find((step) => !step.done)?.key ?? null;
    const queue = useInboxOptional((state) => state.queue);
    const roster = useInboxOptional((state) => state.roster);
    const waiting = queue?.length ?? 0;
    const online = (roster ?? []).filter(
        (member) => member.status !== 'offline',
    );

    return (
        <div className="grid gap-6">
            <ServingNotice serving={serving} />

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
                                {complete
                                    ? t('dashboard.admin.title_done')
                                    : t('dashboard.admin.title')}
                            </h2>
                            <p className="text-sm text-muted-foreground tabular-nums">
                                {t('dashboard.admin.progress', {
                                    done,
                                    total: steps.length,
                                })}
                            </p>
                        </div>
                        <p className="max-w-prose text-sm text-muted-foreground">
                            {complete
                                ? t('dashboard.admin.description_done')
                                : t('dashboard.admin.description')}
                        </p>
                        <Progress
                            value={(done / steps.length) * 100}
                            aria-label={t('dashboard.admin.progress', {
                                done,
                                total: steps.length,
                            })}
                            className="h-1.5"
                        />
                    </div>

                    <ol className="border-t">
                        {steps.map((step, index) => {
                            const Icon = step.done ? Check : step.icon;

                            return (
                                <li
                                    key={step.key}
                                    data-testid={`dashboard-admin-step-${step.key}`}
                                    data-done={step.done ? 'true' : 'false'}
                                    className={cn(
                                        index > 0 && 'border-t',
                                        step.key === current && 'bg-accent/30',
                                    )}
                                >
                                    <Link
                                        href={step.href}
                                        className="flex items-start gap-4 px-5 py-4 transition-colors hover:bg-accent/40 focus-visible:bg-accent/40 focus-visible:outline-none sm:px-6"
                                    >
                                        <span
                                            className={cn(
                                                'flex size-9 shrink-0 items-center justify-center rounded-lg',
                                                step.done
                                                    ? 'bg-emerald-100 text-emerald-800 dark:bg-emerald-950 dark:text-emerald-300'
                                                    : step.key === current
                                                      ? 'bg-primary text-primary-foreground'
                                                      : 'bg-secondary text-secondary-foreground',
                                            )}
                                            aria-hidden
                                        >
                                            <Icon className="size-4" />
                                        </span>
                                        <div className="min-w-0 flex-1">
                                            <p className="font-medium">
                                                {t(
                                                    `dashboard.admin.steps.${step.key}.title`,
                                                )}
                                            </p>
                                            <p className="mt-0.5 text-sm text-muted-foreground">
                                                {t(
                                                    `dashboard.admin.steps.${step.key}.description`,
                                                )}
                                            </p>
                                            {!step.done && step.hint && (
                                                <p
                                                    className="mt-1.5 text-sm font-medium text-amber-800 dark:text-amber-300"
                                                    data-testid={`dashboard-admin-hint-${step.key}`}
                                                >
                                                    {step.hint}
                                                </p>
                                            )}
                                        </div>
                                        {step.done ? (
                                            <Badge
                                                variant="secondary"
                                                className="shrink-0"
                                            >
                                                {t(
                                                    'dashboard.admin.status.done',
                                                )}
                                            </Badge>
                                        ) : (
                                            <span className="flex shrink-0 items-center gap-1 text-sm font-medium">
                                                {t(
                                                    'dashboard.admin.status.open',
                                                )}
                                                <ArrowRight
                                                    className="size-4 rtl:rotate-180"
                                                    aria-hidden
                                                />
                                            </span>
                                        )}
                                    </Link>
                                </li>
                            );
                        })}
                    </ol>
                </section>

                <div className="grid content-start gap-6">
                    {serving?.takesChats && <AvailabilityCard />}
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
                                <p
                                    className="text-sm text-muted-foreground"
                                    data-testid="dashboard-queue-count"
                                >
                                    {waiting > 0
                                        ? t('dashboard.queue.waiting', {
                                              count: waiting,
                                          })
                                        : t('dashboard.queue.empty')}
                                </p>
                            </div>
                        </div>
                        {waiting > 0 ? (
                            <Link
                                href="/inbox"
                                className="flex w-fit items-center gap-1 text-sm font-medium underline-offset-4 hover:underline"
                            >
                                {t('dashboard.queue.open')}
                                <ArrowRight
                                    className="size-4 rtl:rotate-180"
                                    aria-hidden
                                />
                            </Link>
                        ) : (
                            <>
                                <GhostRows count={3} />
                                <p className="text-sm text-muted-foreground">
                                    {t('dashboard.queue.empty_hint')}
                                </p>
                            </>
                        )}
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
                        {online.length > 0 ? (
                            <ul
                                className="mt-2 grid gap-1.5 text-sm"
                                data-testid="dashboard-team-online"
                            >
                                {online.map((member) => (
                                    <li
                                        key={member.id}
                                        className="flex items-center gap-2"
                                    >
                                        <span
                                            className={cn(
                                                'size-2 rounded-full',
                                                member.status === 'online'
                                                    ? 'bg-emerald-500'
                                                    : 'bg-amber-500',
                                            )}
                                            aria-hidden
                                        />
                                        <span className="truncate">
                                            {member.name}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {t(
                                                `inbox.presence.${member.status}`,
                                            )}
                                        </span>
                                    </li>
                                ))}
                            </ul>
                        ) : (
                            <p className="mt-1 text-sm text-muted-foreground">
                                {t('dashboard.team.empty')}
                            </p>
                        )}
                    </section>
                </div>
            </div>
        </div>
    );
}
