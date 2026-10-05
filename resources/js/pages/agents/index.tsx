import { Head, usePage } from '@inertiajs/react';
import {
    ExternalLink,
    Search,
    ShieldCheck,
    UserPlus,
    Users,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import {
    countOnline,
    resolvePresence,
} from '@/components/agents/agent-presence';
import { AGENT_GRID, AgentRow } from '@/components/agents/agent-row';
import {
    filterAgents,
    hasActiveFilters,
    NO_FILTERS,
    type AgentFilters,
    type RoleFilter,
} from '@/components/agents/agent-model';
import { CreateStaffDialog } from '@/components/agents/create-staff-dialog';
import { useAgents } from '@/components/agents/use-agents';
import { NativeSelect } from '@/components/setup/native-select';
import { Notice } from '@/components/widgets/form-bits';
import {
    PageHeader,
    PageShell,
    usePlural,
} from '@/components/widgets/page-chrome';
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { useInboxOptional } from '@/lib/realtime/staff/context';
import { safeExternalUrl } from '@/lib/urls';
import { cn } from '@/lib/utils';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { AgentListItemData, AgentsPageProps } from '@/types/widgets';

export default function AgentsIndex({
    agents: initialAgents,
    categories,
    authMode,
    canManageStaff,
    presence,
}: AgentsPageProps) {
    const { t } = useTrans();
    const plural = usePlural();
    const { auth } = usePage().props;
    const portalUrl = safeExternalUrl(auth?.capabilities?.portalUrl);
    const { agents, setCategories, setActive, setAgentRole, setMaxChats, add } =
        useAgents(initialAgents);
    const [filters, setFilters] = useState<AgentFilters>(NO_FILTERS);
    const [creating, setCreating] = useState(false);
    // An admin who stops taking chats loses the categories they serve: say so before it happens.
    const [stopping, setStopping] = useState<AgentListItemData | null>(null);
    // The props are a snapshot of the moment the page loaded; `presence.changed` events heard since then update the dots.
    const [loadedAt] = useState(() => Date.now());
    const heard = useInboxOptional((state) => state.seenPresence);
    const statusOf = (id: number) =>
        resolvePresence(id, presence, heard, loadedAt);
    const online = countOnline(
        agents.filter((agent) => agent.is_active).map((agent) => agent.id),
        statusOf,
    );

    const visible = filterAgents(agents, filters);
    const filtered = hasActiveFilters(filters);

    return (
        <>
            <Head title={t('agents.title')} />

            <PageShell testId="agents-page">
                <PageHeader
                    title={t('agents.title')}
                    description={t('agents.description')}
                    actions={
                        canManageStaff ? (
                            <Button
                                data-testid="agent-create"
                                onClick={() => setCreating(true)}
                            >
                                <UserPlus aria-hidden />
                                {t('agents.create.open')}
                            </Button>
                        ) : undefined
                    }
                />

                {!canManageStaff && (
                    <Notice data-testid="agents-portal-notice">
                        <p className="flex items-center gap-1.5 font-medium">
                            <ShieldCheck className="size-4" aria-hidden />
                            {t('agents.portal.title')}
                        </p>
                        <p className="mt-0.5 text-muted-foreground">
                            {authMode === 'pizzasys'
                                ? t('agents.portal.body')
                                : t('agents.portal.body_generic')}
                        </p>
                        {portalUrl && (
                            <a
                                href={portalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="mt-1.5 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-4"
                            >
                                {t('agents.portal.open')}
                                <ExternalLink
                                    className="size-3.5 rtl:-scale-x-100"
                                    aria-hidden
                                />
                            </a>
                        )}
                    </Notice>
                )}

                {agents.length === 0 ? (
                    <Empty
                        data-testid="agents-empty"
                        className="border bg-card"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Users aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>{t('agents.empty.title')}</EmptyTitle>
                            <EmptyDescription>
                                {canManageStaff
                                    ? t('agents.empty.body_manage')
                                    : t('agents.empty.body_portal')}
                            </EmptyDescription>
                        </EmptyHeader>
                    </Empty>
                ) : (
                    <section
                        aria-label={t('agents.list_label')}
                        className="overflow-hidden rounded-xl border bg-card"
                    >
                        <p
                            className="border-b px-4 py-2 text-sm text-muted-foreground"
                            aria-live="polite"
                            data-testid="agents-online-count"
                        >
                            {t('presence.online_count', { count: online })}
                        </p>

                        <div className="grid gap-2 border-b p-3 sm:grid-cols-[minmax(0,1fr)_12rem_10rem]">
                            <div className="relative">
                                <Search
                                    className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                                    aria-hidden
                                />
                                <Input
                                    type="search"
                                    value={filters.query}
                                    onChange={(event) =>
                                        setFilters({
                                            ...filters,
                                            query: event.target.value,
                                        })
                                    }
                                    placeholder={t('agents.search')}
                                    aria-label={t('agents.search')}
                                    data-testid="agent-search"
                                    className="ps-9"
                                />
                            </div>
                            <NativeSelect
                                aria-label={t('agents.filter.category')}
                                data-testid="agent-filter-category"
                                value={filters.category}
                                onChange={(event) =>
                                    setFilters({
                                        ...filters,
                                        category: event.target.value,
                                    })
                                }
                            >
                                <option value="all">
                                    {t('agents.filter.all_categories')}
                                </option>
                                <option value="none">
                                    {t('agents.filter.no_categories')}
                                </option>
                                {categories.map((category) => (
                                    <option
                                        key={category.ulid}
                                        value={category.ulid}
                                    >
                                        {category.name}
                                    </option>
                                ))}
                            </NativeSelect>
                            <NativeSelect
                                aria-label={t('agents.filter.role')}
                                data-testid="agent-filter-role"
                                value={filters.role}
                                onChange={(event) =>
                                    setFilters({
                                        ...filters,
                                        role: event.target.value as RoleFilter,
                                    })
                                }
                            >
                                <option value="all">
                                    {t('agents.filter.all_roles')}
                                </option>
                                <option value="admin">
                                    {t('agents.role.admin')}
                                </option>
                                <option value="agent">
                                    {t('agents.role.agent')}
                                </option>
                                <option value="none">
                                    {t('agents.role.none')}
                                </option>
                            </NativeSelect>
                        </div>

                        <div
                            aria-hidden
                            className={cn(
                                'hidden gap-x-4 border-b bg-muted/40 px-4 py-2 text-xs font-medium text-muted-foreground xl:grid',
                                AGENT_GRID,
                            )}
                        >
                            <span>{t('agents.col.agent')}</span>
                            <span>{t('agents.col.roles')}</span>
                            <span>{t('agents.col.categories')}</span>
                            <span>{t('agents.col.active')}</span>
                            <span>{t('agents.col.max_chats')}</span>
                            <span>{t('agents.col.last_seen')}</span>
                        </div>

                        {visible.length === 0 ? (
                            <p
                                className="px-4 py-10 text-center text-sm text-muted-foreground"
                                data-testid="agents-no-match"
                            >
                                {t('agents.no_match')}
                            </p>
                        ) : (
                            <ul className="divide-y" data-testid="agents-list">
                                {visible.map((agent) => (
                                    <AgentRow
                                        key={agent.id}
                                        agent={agent}
                                        presence={statusOf(agent.id)}
                                        categories={categories}
                                        canManageStaff={canManageStaff}
                                        onSetCategories={(entry, ulids) =>
                                            void setCategories(entry, ulids)
                                        }
                                        onSetActive={(entry, active) =>
                                            void setActive(entry, active)
                                        }
                                        onSetAgentRole={(entry, isAgent) =>
                                            !isAgent &&
                                            entry.category_ulids.length > 0
                                                ? setStopping(entry)
                                                : void setAgentRole(
                                                      entry,
                                                      isAgent,
                                                  )
                                        }
                                        onSetMaxChats={(entry, max) =>
                                            void setMaxChats(entry, max)
                                        }
                                    />
                                ))}
                            </ul>
                        )}

                        <p
                            className="border-t px-4 py-2 text-xs text-muted-foreground"
                            aria-live="polite"
                            data-testid="agents-count"
                        >
                            {filtered
                                ? t('agents.count_filtered', {
                                      shown: visible.length,
                                      total: agents.length,
                                  })
                                : plural('agents.count', agents.length)}
                        </p>
                    </section>
                )}
            </PageShell>

            {canManageStaff && (
                <CreateStaffDialog
                    open={creating}
                    onOpenChange={setCreating}
                    categories={categories}
                    onCreated={(agent) => {
                        add(agent);
                        toast.success(
                            t('agents.toast.created', { name: agent.name }),
                        );
                    }}
                />
            )}

            <AlertDialog
                open={stopping !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setStopping(null);
                    }
                }}
            >
                <AlertDialogContent data-testid="agent-stop-dialog">
                    <AlertDialogHeader>
                        <AlertDialogTitle className="[overflow-wrap:anywhere]">
                            {t('agents.stop.title', {
                                name: stopping?.name ?? '',
                            })}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t('agents.stop.body', {
                                count: stopping?.category_ulids.length ?? 0,
                            })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel>
                            {t('agents.stop.cancel')}
                        </AlertDialogCancel>
                        <AlertDialogAction
                            data-testid="agent-stop-confirm"
                            onClick={() => {
                                if (stopping) {
                                    void setAgentRole(stopping, false);
                                    setStopping(null);
                                }
                            }}
                        >
                            {t('agents.stop.confirm')}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    );
}

AgentsIndex.layout = AgentsLayout;

function AgentsLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('agents.title'),
                    href: widgetsRoutes.pages.agents(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
