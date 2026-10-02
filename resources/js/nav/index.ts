import type { NavItem } from '@/types';

export type NavRole = 'any' | 'admin' | 'agent' | 'agent-only';

export type NavGroup = 'main' | 'admin' | 'settings';

export type NavEntry = {
    item: NavItem;
    /** Lower renders first. Reserve ranges per context (see docs/architecture.md). */
    order: number;
    /** Who sees it. `admin` also implies the entry is hidden from agents. */
    role: NavRole;
    group?: NavGroup;
};

type NavUser = { is_admin?: boolean; is_agent?: boolean };

/**
 * Every file in this folder default-exports `NavEntry[]`; the registry merges them,
 * so each parallel track adds its own file and never edits a shared nav list.
 */
const modules = import.meta.glob<NavEntry[]>(
    ['./*.ts', '!./index.ts', '!./*.test.ts'],
    {
        eager: true,
        import: 'default',
    },
);

const allEntries: NavEntry[] = Object.values(modules)
    .flat()
    .sort((a, b) => a.order - b.order);

/**
 * Role filter: `any` for everyone, `agent` for agents and admins, `admin` for admins only, `agent-only` for agents who are not admins (an
 * entry whose admin twin is a different entry: "Analytics" for admins, "My performance" for agents).
 */
export function filterNav(entries: NavEntry[], user: NavUser): NavEntry[] {
    return entries.filter(
        (entry) =>
            entry.role === 'any' ||
            (entry.role === 'admin' && user.is_admin === true) ||
            (entry.role === 'agent' &&
                (user.is_agent === true || user.is_admin === true)) ||
            (entry.role === 'agent-only' &&
                user.is_agent === true &&
                user.is_admin !== true),
    );
}

export function navFor(user: NavUser): NavEntry[] {
    return filterNav(allEntries, user);
}

/** Entries without an explicit group belong to `main`. */
export function inNavGroup(entries: NavEntry[], group: NavGroup): NavItem[] {
    return entries
        .filter((entry) => (entry.group ?? 'main') === group)
        .map((entry) => entry.item);
}
