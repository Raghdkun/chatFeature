import { describe, expect, it } from 'vite-plus/test';
import { filterNav, navFor, type NavEntry } from '@/nav';

const titles = (user: { is_admin?: boolean; is_agent?: boolean }) =>
    navFor(user).map((entry) => entry.item.title);

describe('the analytics entries', () => {
    it('give an administrator "Analytics" and an agent "My performance", never both', () => {
        expect(titles({ is_admin: true, is_agent: true })).toContain(
            'Analytics',
        );
        expect(titles({ is_admin: true, is_agent: true })).not.toContain(
            'My performance',
        );
        expect(titles({ is_admin: false, is_agent: true })).toContain(
            'My performance',
        );
        expect(titles({ is_admin: false, is_agent: true })).not.toContain(
            'Analytics',
        );
        expect(titles({ is_admin: true })).toContain('Analytics');
    });

    it('give an account without a chat role neither', () => {
        expect(titles({})).not.toContain('Analytics');
        expect(titles({})).not.toContain('My performance');
        expect(titles({ is_admin: false, is_agent: false })).not.toContain(
            'My performance',
        );
    });

    it('lead to the same page with translatable titles', () => {
        const admin = navFor({ is_admin: true }).find(
            (entry) => entry.item.title === 'Analytics',
        );
        const agent = navFor({ is_agent: true }).find(
            (entry) => entry.item.title === 'My performance',
        );

        expect(admin?.item.href).toBe('/analytics');
        expect(agent?.item.href).toBe('/analytics');
        expect(admin?.item.titleKey).toBe('analytics.nav');
        expect(agent?.item.titleKey).toBe('analytics.nav_agent');
        expect(admin?.order).toBe(50);
    });

    it('the new agent-only role does not leak into the older roles', () => {
        const entry = (role: NavEntry['role']): NavEntry => ({
            item: { title: role, href: '/' },
            order: 1,
            role,
        });
        const all = [
            entry('any'),
            entry('agent'),
            entry('admin'),
            entry('agent-only'),
        ];
        const names = (user: { is_admin?: boolean; is_agent?: boolean }) =>
            filterNav(all, user).map((e) => e.role);

        expect(names({ is_agent: true })).toEqual([
            'any',
            'agent',
            'agent-only',
        ]);
        expect(names({ is_admin: true })).toEqual(['any', 'agent', 'admin']);
        expect(names({ is_admin: true, is_agent: true })).toEqual([
            'any',
            'agent',
            'admin',
        ]);
        expect(names({})).toEqual(['any']);
    });
});
