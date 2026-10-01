import { describe, expect, it } from 'vite-plus/test';
import { navFor } from '@/nav';

describe('nav registry', () => {
    it('shows the dashboard entry to every role', () => {
        const guestTitles = navFor({}).map((entry) => entry.item.title);

        expect(guestTitles).toContain('Dashboard');
    });

    it('hides admin-only entries from agents', () => {
        const agentEntries = navFor({ is_agent: true });

        expect(agentEntries.every((entry) => entry.role !== 'admin')).toBe(
            true,
        );
    });
});
