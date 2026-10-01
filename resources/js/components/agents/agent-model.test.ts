import { describe, expect, it, vi } from 'vite-plus/test';
import {
    createAgentSync,
    filterAgents,
    hasActiveFilters,
    knownCategoryUlids,
    NO_FILTERS,
    parseConcurrentChats,
    toggleUlid,
} from '@/components/agents/agent-model';
import { AGENTS, CATEGORIES, makeAgent } from '@/tests/fixtures';

describe('filterAgents', () => {
    const names = (filters: Partial<typeof NO_FILTERS>) =>
        filterAgents(AGENTS, { ...NO_FILTERS, ...filters }).map((a) => a.name);

    it('returns everyone without filters', () => {
        expect(names({})).toHaveLength(3);
        expect(hasActiveFilters(NO_FILTERS)).toBe(false);
    });

    it('searches name and email, ignoring case and padding', () => {
        expect(names({ query: '  LINA ' })).toEqual(['Lina Kassab']);
        expect(names({ query: 'omar@example' })).toEqual(['Omar Haddad']);
        expect(names({ query: 'nobody' })).toEqual([]);
    });

    it('filters by category, including "no categories"', () => {
        expect(names({ category: 'cat2' })).toEqual(['Lina Kassab']);
        expect(names({ category: 'cat1' })).toEqual([
            'Sara Ahmed',
            'Lina Kassab',
        ]);
        expect(names({ category: 'none' })).toEqual(['Omar Haddad']);
    });

    it('filters by role', () => {
        expect(names({ role: 'admin' })).toEqual(['Omar Haddad']);
        expect(names({ role: 'agent' })).toEqual(['Sara Ahmed', 'Lina Kassab']);
        expect(
            filterAgents([makeAgent({ id: 9, is_agent: false })], {
                ...NO_FILTERS,
                role: 'none',
            }),
        ).toHaveLength(1);
    });

    it('combines filters', () => {
        expect(
            names({ role: 'agent', category: 'cat2', query: 'lina' }),
        ).toEqual(['Lina Kassab']);
        expect(names({ role: 'admin', category: 'cat1' })).toEqual([]);
        expect(hasActiveFilters({ ...NO_FILTERS, role: 'admin' })).toBe(true);
    });
});

describe('helpers', () => {
    it('toggles a ulid in a list', () => {
        expect(toggleUlid(['a'], 'b')).toEqual(['a', 'b']);
        expect(toggleUlid(['a', 'b'], 'a')).toEqual(['b']);
    });

    it('keeps only categories that still exist, in catalog order', () => {
        expect(
            knownCategoryUlids(
                { category_ulids: ['cat3', 'gone', 'cat1'] },
                CATEGORIES,
            ),
        ).toEqual(['cat1', 'cat3']);
    });

    it('parses concurrent chats as a whole number in range', () => {
        const range = { min: 1, max: 50 };

        expect(parseConcurrentChats('7', range)).toBe(7);
        expect(parseConcurrentChats('0', range)).toBeNull();
        expect(parseConcurrentChats('51', range)).toBeNull();
        expect(parseConcurrentChats('2.5', range)).toBeNull();
        expect(parseConcurrentChats('', range)).toBeNull();
        expect(parseConcurrentChats('-3', range)).toBeNull();
    });
});

describe('createAgentSync', () => {
    it('remembers the confirmed copy and updates it', () => {
        const sync = createAgentSync([AGENTS[0]]);

        expect(sync.confirmed(1)).toBe(AGENTS[0]);

        sync.confirm({ ...AGENTS[0], max_concurrent_chats: 9 });

        expect(sync.confirmed(1)?.max_concurrent_chats).toBe(9);

        sync.remember({ ...AGENTS[1] });

        expect(sync.confirmed(2)).toBeDefined();
        sync.remember({ ...AGENTS[0], name: 'ignored' });
        expect(sync.confirmed(1)?.name).toBe('Sara Ahmed');
    });

    it('runs edits of one agent strictly in order', async () => {
        const sync = createAgentSync([]);
        const order: string[] = [];
        const slow = vi.fn(async () => {
            await new Promise((resolve) => setTimeout(resolve, 15));
            order.push('first');
        });
        const fast = vi.fn(async () => {
            order.push('second');
        });

        await Promise.all([sync.enqueue(1, slow), sync.enqueue(1, fast)]);

        expect(order).toEqual(['first', 'second']);
    });

    it('lets edits of different agents run side by side', async () => {
        const sync = createAgentSync([]);
        const order: string[] = [];

        await Promise.all([
            sync.enqueue(1, async () => {
                await new Promise((resolve) => setTimeout(resolve, 15));
                order.push('agent-1');
            }),
            sync.enqueue(2, async () => {
                order.push('agent-2');
            }),
        ]);

        expect(order).toEqual(['agent-2', 'agent-1']);
    });

    it('knows whether a newer edit is queued behind a failure, and keeps the chain alive', async () => {
        const sync = createAgentSync([]);
        const seen: boolean[] = [];
        const failing = sync.enqueue(1, async () => {
            throw new Error('nope');
        });
        const next = sync.enqueue(1, async () => 'ok');

        await failing.catch(() => {
            seen.push(sync.hasNewerPending(1));
        });

        await expect(next).resolves.toBe('ok');
        expect(seen).toEqual([true]);
        expect(sync.hasNewerPending(1)).toBe(false);
    });
});
