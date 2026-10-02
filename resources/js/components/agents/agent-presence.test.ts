import { describe, expect, it } from 'vite-plus/test';
import {
    countOnline,
    resolvePresence,
} from '@/components/agents/agent-presence';

describe('resolvePresence', () => {
    const loaded = { 1: 'online', 2: 'away' } as const;

    it('starts from the status the page was loaded with, offline when it is not listed', () => {
        expect(resolvePresence(1, loaded, null, 1_000)).toBe('online');
        expect(resolvePresence(2, loaded, {}, 1_000)).toBe('away');
        expect(resolvePresence(3, loaded, {}, 1_000)).toBe('offline');
        expect(resolvePresence(3, undefined, null, 1_000)).toBe('offline');
    });

    it('takes a status heard after the page loaded, and ignores one heard before (the store outlives page visits)', () => {
        const seen = {
            1: { status: 'offline', at: 2_000 },
            2: { status: 'offline', at: 500 },
        } as const;

        expect(resolvePresence(1, loaded, seen, 1_000)).toBe('offline');
        expect(resolvePresence(2, loaded, seen, 1_000)).toBe('away');
        expect(resolvePresence(1, loaded, { 1: seen[1] }, 2_000)).toBe(
            'offline',
        );
    });
});

describe('countOnline', () => {
    it('counts the people who are online, not the ones who are away', () => {
        const status = (id: number) =>
            id === 1 ? 'online' : id === 2 ? 'away' : 'offline';

        expect(countOnline([1, 2, 3], status)).toBe(1);
        expect(countOnline([], status)).toBe(0);
    });
});
