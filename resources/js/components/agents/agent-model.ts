/**
 * Pure helpers of the agents page: filtering, role flags and the optimistic-update bookkeeping.
 */
import type { AgentListItemData, CategoryData } from '@/types/widgets';

export type RoleFilter = 'all' | 'admin' | 'agent' | 'none';

export type AgentFilters = {
    query: string;
    /** `'all'`, `'none'` (no categories assigned) or a category ulid. */
    category: string;
    role: RoleFilter;
};

export const NO_FILTERS: AgentFilters = {
    query: '',
    category: 'all',
    role: 'all',
};

export function filterAgents(
    agents: AgentListItemData[],
    filters: AgentFilters,
): AgentListItemData[] {
    const needle = filters.query.trim().toLowerCase();

    return agents.filter((agent) => {
        if (
            needle !== '' &&
            !`${agent.name} ${agent.email}`.toLowerCase().includes(needle)
        ) {
            return false;
        }

        if (filters.category === 'none') {
            if (agent.category_ulids.length > 0) {
                return false;
            }
        } else if (
            filters.category !== 'all' &&
            !agent.category_ulids.includes(filters.category)
        ) {
            return false;
        }

        switch (filters.role) {
            case 'admin':
                return agent.is_admin;
            case 'agent':
                return agent.is_agent;
            case 'none':
                return !agent.is_admin && !agent.is_agent;
            default:
                return true;
        }
    });
}

export function hasActiveFilters(filters: AgentFilters): boolean {
    return (
        filters.query.trim() !== '' ||
        filters.category !== 'all' ||
        filters.role !== 'all'
    );
}

/** Ulids that still exist in the catalog, in the catalog's order (drops categories deleted since). */
export function knownCategoryUlids(
    agent: Pick<AgentListItemData, 'category_ulids'>,
    categories: Pick<CategoryData, 'ulid'>[],
): string[] {
    const wanted = new Set(agent.category_ulids);

    return categories
        .map((category) => category.ulid)
        .filter((ulid) => wanted.has(ulid));
}

export function toggleUlid(current: string[], ulid: string): string[] {
    return current.includes(ulid)
        ? current.filter((entry) => entry !== ulid)
        : [...current, ulid];
}

/** Whole number in the allowed range, or `null` (empty, decimals, text, out of range). */
export function parseConcurrentChats(
    raw: string,
    range: { min: number; max: number },
): number | null {
    const text = raw.trim();

    if (!/^\d+$/.test(text)) {
        return null;
    }

    const value = Number(text);

    return value >= range.min && value <= range.max ? value : null;
}

/**
 * Keeps the last server-confirmed copy of every agent so an optimistic edit that fails (and has no
 * newer edit queued behind it) can be rolled back to the truth rather than to a stale snapshot.
 */
export function createAgentSync(initial: AgentListItemData[]) {
    const confirmed = new Map<number, AgentListItemData>(
        initial.map((agent) => [agent.id, agent]),
    );
    const pending = new Map<number, number>();
    const chains = new Map<number, Promise<unknown>>();

    return {
        confirmed: (id: number) => confirmed.get(id),
        confirm(agent: AgentListItemData) {
            confirmed.set(agent.id, agent);
        },
        remember(agent: AgentListItemData) {
            if (!confirmed.has(agent.id)) {
                confirmed.set(agent.id, agent);
            }
        },
        /** Runs `task` after every earlier task of the same agent; returns whether a newer one is already queued behind it. */
        enqueue<T>(id: number, task: () => Promise<T>): Promise<T> {
            pending.set(id, (pending.get(id) ?? 0) + 1);

            const run = (chains.get(id) ?? Promise.resolve()).then(task);
            const settle = () => {
                pending.set(id, (pending.get(id) ?? 1) - 1);
            };

            const tracked = run.then(
                (value) => {
                    settle();

                    return value;
                },
                (error: unknown) => {
                    settle();

                    throw error;
                },
            );

            chains.set(
                id,
                tracked.catch(() => undefined),
            );

            return tracked;
        },
        /** True when another edit for this agent is still waiting its turn. */
        hasNewerPending: (id: number) => (pending.get(id) ?? 0) > 0,
    };
}

export type AgentSync = ReturnType<typeof createAgentSync>;
