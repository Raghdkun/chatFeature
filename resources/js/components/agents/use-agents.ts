import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { createAgentSync } from '@/components/agents/agent-model';
import { useTrans } from '@/hooks/use-trans';
import { api, describeApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { AgentListItemData } from '@/types/widgets';

/**
 * Agents list with optimistic edits. Every edit updates the row immediately, then goes through a
 * per-agent queue (edits of one agent never overlap); a failure rolls the row back to the last
 * server-confirmed copy and toasts the reason, unless a newer edit is already queued behind it
 * (that one carries the full value and settles the row either way).
 */
export function useAgents(initial: AgentListItemData[]) {
    const { t } = useTrans();
    const [agents, setAgents] = useState<AgentListItemData[]>(initial);
    const [sync] = useState(() => createAgentSync(initial));

    const replace = useCallback((next: AgentListItemData) => {
        setAgents((current) =>
            current.map((agent) => (agent.id === next.id ? next : agent)),
        );
    }, []);

    const mutate = useCallback(
        async (
            agent: AgentListItemData,
            optimistic: Partial<AgentListItemData>,
            request: () => Promise<Partial<AgentListItemData>>,
        ): Promise<boolean> => {
            sync.remember(agent);
            replace({ ...agent, ...optimistic });

            try {
                const answer = await sync.enqueue(agent.id, request);
                const merged = {
                    ...(sync.confirmed(agent.id) ?? agent),
                    ...answer,
                } as AgentListItemData;

                sync.confirm(merged);

                if (!sync.hasNewerPending(agent.id)) {
                    replace(merged);
                }

                return true;
            } catch (error) {
                if (!sync.hasNewerPending(agent.id)) {
                    const truth = sync.confirmed(agent.id);

                    if (truth) {
                        replace(truth);
                    }
                }

                toast.error(describeApiError(error, t));

                return false;
            }
        },
        [replace, sync, t],
    );

    const patch = useCallback(
        (
            agent: AgentListItemData,
            body: Record<string, unknown>,
            optimistic: Partial<AgentListItemData>,
        ) =>
            mutate(agent, optimistic, () =>
                api.patch<AgentListItemData>(
                    widgetsRoutes.api.agents.show(agent.id),
                    body,
                ),
            ),
        [mutate],
    );

    return {
        agents,
        setCategories: (agent: AgentListItemData, categoryUlids: string[]) =>
            mutate(agent, { category_ulids: categoryUlids }, () =>
                api.patch<AgentListItemData>(
                    widgetsRoutes.api.agents.categories(agent.id),
                    { category_ulids: categoryUlids },
                ),
            ),
        setActive: (agent: AgentListItemData, active: boolean) =>
            patch(agent, { is_active: active }, { is_active: active }),
        setAgentRole: (agent: AgentListItemData, isAgent: boolean) =>
            // Only accounts that take chats serve categories: the server drops them when the switch goes off.
            patch(
                agent,
                { is_agent: isAgent },
                isAgent
                    ? { is_agent: true }
                    : { is_agent: false, category_ulids: [] },
            ),
        setMaxChats: (agent: AgentListItemData, max: number) =>
            patch(
                agent,
                { max_concurrent_chats: max },
                { max_concurrent_chats: max },
            ),
        add: (agent: AgentListItemData) => {
            sync.confirm(agent);
            setAgents((current) => [...current, agent]);
        },
    };
}
