import { useState } from 'react';
import { AgentCategoriesPicker } from '@/components/agents/agent-categories-picker';
import { parseConcurrentChats } from '@/components/agents/agent-model';
import { formatRelativeTime } from '@/components/widgets/page-chrome';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useInitials } from '@/hooks/use-initials';
import { useTrans } from '@/hooks/use-trans';
import { LIMITS } from '@/lib/limits';
import { cn } from '@/lib/utils';
import type { AgentListItemData, CategoryData } from '@/types/widgets';

/** Shared grid so the (xl-only) header row and every agent row line up. */
export const AGENT_GRID =
    'xl:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,2.3fr)_9rem_6.5rem_7rem] xl:items-center';

/** A caption that labels a cell on small screens and disappears when the header row takes over. */
function CellLabel({ children }: { children: string }) {
    return (
        <span className="text-xs font-medium text-muted-foreground xl:sr-only">
            {children}
        </span>
    );
}

export function AgentRow({
    agent,
    categories,
    canManageStaff,
    onSetCategories,
    onSetActive,
    onSetAgentRole,
    onSetMaxChats,
}: {
    agent: AgentListItemData;
    categories: CategoryData[];
    /** Mode 1: roles / active state are managed here. Mode 2: they come from the Auth Portal. */
    canManageStaff: boolean;
    onSetCategories: (agent: AgentListItemData, ulids: string[]) => void;
    onSetActive: (agent: AgentListItemData, active: boolean) => void;
    onSetAgentRole: (agent: AgentListItemData, isAgent: boolean) => void;
    onSetMaxChats: (agent: AgentListItemData, max: number) => void;
}) {
    const { t, locale } = useTrans();
    const getInitials = useInitials();
    const activeId = `agent-active-${agent.id}`;
    const roleId = `agent-role-${agent.id}`;
    const maxId = `agent-max-${agent.id}`;
    const lastSeen = formatRelativeTime(agent.last_seen_at, locale);

    return (
        <li
            data-testid={`agent-row-${agent.id}`}
            data-active={agent.is_active}
            className={cn(
                'grid grid-cols-2 gap-x-4 gap-y-3 p-4',
                AGENT_GRID,
                !agent.is_active && 'bg-muted/30',
            )}
        >
            <div className="col-span-2 flex min-w-0 items-center gap-3 xl:col-span-1">
                <Avatar className="size-10">
                    {agent.avatar && <AvatarImage src={agent.avatar} alt="" />}
                    <AvatarFallback className="text-sm">
                        {getInitials(agent.name)}
                    </AvatarFallback>
                </Avatar>
                <div className="min-w-0">
                    <p className="truncate font-medium">{agent.name}</p>
                    <p
                        className="truncate text-sm text-muted-foreground"
                        dir="ltr"
                    >
                        {agent.email}
                    </p>
                </div>
            </div>

            <div className="col-span-2 grid content-start gap-1.5 xl:col-span-1">
                <CellLabel>{t('agents.col.roles')}</CellLabel>
                <div className="flex flex-wrap gap-1.5">
                    {agent.is_admin && (
                        <Badge data-testid={`agent-badge-admin-${agent.id}`}>
                            {t('agents.role.admin')}
                        </Badge>
                    )}
                    {agent.is_agent && (
                        <Badge
                            variant="secondary"
                            data-testid={`agent-badge-agent-${agent.id}`}
                        >
                            {t('agents.role.agent')}
                        </Badge>
                    )}
                    {!agent.is_admin && !agent.is_agent && (
                        <Badge variant="outline">{t('agents.role.none')}</Badge>
                    )}
                    <Badge
                        variant="outline"
                        className="font-normal text-muted-foreground"
                        data-testid={`agent-source-${agent.id}`}
                    >
                        {agent.auth_source === 'pizzasys'
                            ? t('agents.source.pizzasys')
                            : t('agents.source.local')}
                    </Badge>
                </div>
            </div>

            <div className="col-span-2 grid content-start gap-1.5 xl:col-span-1">
                <CellLabel>{t('agents.col.categories')}</CellLabel>
                <AgentCategoriesPicker
                    agentId={agent.id}
                    agentName={agent.name}
                    categories={categories}
                    selected={agent.category_ulids}
                    onChange={(ulids) => onSetCategories(agent, ulids)}
                />
            </div>

            <div className="grid content-start gap-1.5">
                <CellLabel>{t('agents.col.active')}</CellLabel>
                <div className="flex flex-col gap-2">
                    <div className="flex items-center gap-2">
                        <Switch
                            id={activeId}
                            checked={agent.is_active}
                            disabled={!canManageStaff}
                            onCheckedChange={(checked) =>
                                onSetActive(agent, checked)
                            }
                            data-testid={activeId}
                        />
                        <Label
                            htmlFor={activeId}
                            className="text-sm font-normal whitespace-nowrap"
                        >
                            {agent.is_active
                                ? t('agents.active')
                                : t('agents.inactive')}
                        </Label>
                    </div>
                    {canManageStaff && !agent.is_admin && (
                        <div className="flex items-center gap-2">
                            <Switch
                                id={roleId}
                                size="sm"
                                checked={agent.is_agent}
                                onCheckedChange={(checked) =>
                                    onSetAgentRole(agent, checked)
                                }
                                data-testid={roleId}
                            />
                            <Label
                                htmlFor={roleId}
                                className="text-sm font-normal whitespace-nowrap"
                            >
                                {t('agents.takes_chats')}
                            </Label>
                        </div>
                    )}
                </div>
            </div>

            <div className="grid content-start gap-1.5">
                <CellLabel>{t('agents.col.max_chats')}</CellLabel>
                <MaxChatsInput
                    id={maxId}
                    label={t('agents.max_chats_for', { name: agent.name })}
                    value={agent.max_concurrent_chats}
                    onCommit={(value) => onSetMaxChats(agent, value)}
                />
            </div>

            <div className="col-span-2 grid content-start gap-1.5 xl:col-span-1">
                <CellLabel>{t('agents.col.last_seen')}</CellLabel>
                <p className="text-sm text-muted-foreground">
                    {lastSeen ?? t('agents.never_seen')}
                </p>
            </div>
        </li>
    );
}

/** Commits on blur / Enter; anything that is not a whole number in range snaps back. */
function MaxChatsInput({
    id,
    label,
    value,
    onCommit,
}: {
    id: string;
    label: string;
    value: number;
    onCommit: (value: number) => void;
}) {
    const [draft, setDraft] = useState<string | null>(null);
    const parsed =
        draft === null
            ? null
            : parseConcurrentChats(draft, LIMITS.maxConcurrentChats);
    const invalid = draft !== null && parsed === null;

    function commit() {
        if (parsed !== null && parsed !== value) {
            onCommit(parsed);
        }

        setDraft(null);
    }

    return (
        <Input
            id={id}
            data-testid={id}
            aria-label={label}
            type="number"
            inputMode="numeric"
            min={LIMITS.maxConcurrentChats.min}
            max={LIMITS.maxConcurrentChats.max}
            value={draft ?? String(value)}
            aria-invalid={invalid ? true : undefined}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={commit}
            onKeyDown={(event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    commit();
                }

                if (event.key === 'Escape') {
                    setDraft(null);
                }
            }}
            className="w-20 tabular-nums"
        />
    );
}
