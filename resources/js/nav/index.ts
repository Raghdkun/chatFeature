import type { NavItem } from '@/types';

export type NavRole = 'any' | 'admin' | 'agent';

export type NavEntry = {
    item: NavItem;
    /** Lower renders first. Reserve ranges per context (see docs/architecture.md). */
    order: number;
    /** Who sees it. `admin` also implies the entry is hidden from agents. */
    role: NavRole;
    group?: 'main' | 'admin' | 'settings';
};

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

export function navFor(user: {
    is_admin?: boolean;
    is_agent?: boolean;
}): NavEntry[] {
    return allEntries.filter(
        (entry) =>
            entry.role === 'any' ||
            (entry.role === 'admin' && user.is_admin === true) ||
            (entry.role === 'agent' &&
                (user.is_agent === true || user.is_admin === true)),
    );
}
