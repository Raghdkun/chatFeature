import { describe, expect, it } from 'vite-plus/test';
import { filterNav, inNavGroup, navFor, type NavEntry } from '@/nav';

const entry = (
    title: string,
    role: NavEntry['role'],
    group?: NavEntry['group'],
    order = 10,
): NavEntry => ({
    item: { title, href: `/${title.toLowerCase()}` },
    order,
    role,
    group,
});

const fixtures: NavEntry[] = [
    entry('Everyone', 'any'),
    entry('Inbox', 'agent'),
    entry('Widgets', 'admin', 'admin'),
    entry('Profile', 'any', 'settings'),
];

const titles = (entries: NavEntry[]) => entries.map((e) => e.item.title);

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

    it('carries a translation key for the dashboard entry', () => {
        const dashboard = navFor({}).find(
            (entry) => entry.item.title === 'Dashboard',
        );

        expect(dashboard?.item.titleKey).toBe('nav.dashboard');
    });
});

describe('filterNav', () => {
    it('gives guests (and users without a role) only the entries for everyone', () => {
        expect(titles(filterNav(fixtures, {}))).toEqual([
            'Everyone',
            'Profile',
        ]);
    });

    it('gives agents agent and shared entries but nothing admin-only', () => {
        expect(titles(filterNav(fixtures, { is_agent: true }))).toEqual([
            'Everyone',
            'Inbox',
            'Profile',
        ]);
    });

    it('gives admins everything, including agent entries', () => {
        expect(titles(filterNav(fixtures, { is_admin: true }))).toEqual([
            'Everyone',
            'Inbox',
            'Widgets',
            'Profile',
        ]);
    });

    it('treats an explicit false like a missing flag', () => {
        expect(
            titles(filterNav(fixtures, { is_admin: false, is_agent: false })),
        ).toEqual(['Everyone', 'Profile']);
    });
});

describe('inNavGroup', () => {
    it('defaults ungrouped entries to the main group', () => {
        const items = inNavGroup(fixtures, 'main').map((item) => item.title);

        expect(items).toEqual(['Everyone', 'Inbox']);
    });

    it('returns only the requested group', () => {
        expect(inNavGroup(fixtures, 'admin').map((item) => item.title)).toEqual(
            ['Widgets'],
        );
        expect(inNavGroup(fixtures, 'settings')).toHaveLength(1);
    });
});
