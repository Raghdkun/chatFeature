import '@/tests/dom-polyfills';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { TooltipProvider } from '@/components/ui/tooltip';
import AppLayout from '@/layouts/app-layout';
import SettingsLayout from '@/layouts/settings/layout';
import { inNavGroup, navFor } from '@/nav';
import AgentsIndex from '@/pages/agents/index';
import CategoriesIndex from '@/pages/categories/index';
import AuthSettings from '@/pages/settings/auth';
import NotificationSettings from '@/pages/settings/notifications';
import SupportCategories from '@/pages/settings/support-categories';
import WidgetBuilder from '@/pages/widgets/builder';
import WidgetsIndex from '@/pages/widgets/index';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';
import { makeBuilderData } from '@/tests/fixtures';
import { en } from '@/tests/lang';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const caps = {
    canRegister: false,
    canResetPassword: false,
    canManage2fa: false,
    profileEditable: false,
    portalUrl: null,
};

const user = (flags: { is_admin?: boolean; is_agent?: boolean }) => ({
    id: 1,
    name: 'Mina Haddad',
    email: 'mina@example.com',
    avatar: null,
    auth_source: 'local',
    is_admin: false,
    is_agent: false,
    ...flags,
});

const as = (flags: { is_admin?: boolean; is_agent?: boolean }) =>
    resetInertiaMock({
        auth: { user: user(flags), mode: 'fortify', capabilities: caps },
        sidebarOpen: true,
    });

beforeEach(() => as({ is_admin: true }));

describe('nav registry', () => {
    const adminTitles = (flags: { is_admin?: boolean; is_agent?: boolean }) =>
        inNavGroup(navFor(flags), 'admin').map((item) => item.title);

    it('gives admins Widgets, Categories and Agents in the administration group, in that order', () => {
        expect(adminTitles({ is_admin: true })).toEqual([
            'Widgets',
            'Categories',
            'Agents',
        ]);
    });

    it('hides all of it from agents and from accounts without a role', () => {
        expect(adminTitles({ is_agent: true })).toEqual([]);
        expect(adminTitles({})).toEqual([]);
        expect(adminTitles({ is_admin: false, is_agent: false })).toEqual([]);
    });

    it('links to the pages of the contract, with translatable titles', () => {
        const items = inNavGroup(navFor({ is_admin: true }), 'admin');

        expect(items.map((item) => item.href)).toEqual([
            '/widgets',
            '/categories',
            '/agents',
        ]);

        for (const item of items) {
            expect(item.titleKey).toBeDefined();
            expect(en).toHaveProperty([item.titleKey as string]);
            expect(en[item.titleKey as string]).toBe(item.title);
        }
    });
});

describe('sidebar', () => {
    const sidebarText = async () => {
        const view = await render(
            <TooltipProvider>
                <AppLayout>
                    <p>content</p>
                </AppLayout>
            </TooltipProvider>,
        );

        return view.container.querySelector('[data-slot="sidebar"]');
    };

    it('shows the three admin entries as links under Administration', async () => {
        const sidebar = await sidebarText();
        const hrefs = Array.from(sidebar?.querySelectorAll('a') ?? []).map(
            (a) => a.getAttribute('href'),
        );

        expect(sidebar?.textContent).toContain('Administration');
        expect(hrefs).toEqual(
            expect.arrayContaining(['/widgets', '/categories', '/agents']),
        );
    });

    it('shows none of them to an agent', async () => {
        as({ is_agent: true });

        const sidebar = await sidebarText();
        const hrefs = Array.from(sidebar?.querySelectorAll('a') ?? []).map(
            (a) => a.getAttribute('href'),
        );

        expect(hrefs).not.toContain('/widgets');
        expect(hrefs).not.toContain('/categories');
        expect(hrefs).not.toContain('/agents');
        expect(sidebar?.textContent).not.toContain('Administration');
    });
});

describe('settings menu', () => {
    const items = async () => {
        const view = await render(
            <SettingsLayout>
                <p>content</p>
            </SettingsLayout>,
        );

        return Array.from(
            view.container.querySelectorAll('nav[aria-label="Settings"] a'),
        ).map((a) => [a.textContent, a.getAttribute('href')]);
    };

    it('adds "Support categories" for agents', async () => {
        as({ is_agent: true });

        expect(await items()).toContainEqual([
            'Support categories',
            '/settings/support-categories',
        ]);
    });

    it('adds it for an admin who takes chats', async () => {
        as({ is_admin: true, is_agent: true });

        expect(await items()).toContainEqual([
            'Support categories',
            '/settings/support-categories',
        ]);
    });

    it('leaves it out for an admin who does not take chats (saving would be refused)', async () => {
        as({ is_admin: true });

        expect((await items()).map(([title]) => title)).not.toContain(
            'Support categories',
        );
    });

    it('leaves the menu alone for accounts without a chat role and keeps the existing items', async () => {
        as({});

        const list = await items();

        expect(list.map(([title]) => title)).not.toContain(
            'Support categories',
        );
        expect(list.map(([title]) => title)).toEqual(
            expect.arrayContaining(['Profile', 'Appearance']),
        );
    });
});

describe('page layouts (breadcrumbs)', () => {
    it('wraps every page of the area in the app layout with a translated breadcrumb', async () => {
        const pages: [string, { layout: unknown }][] = [
            ['Widgets', WidgetsIndex],
            ['Categories', CategoriesIndex],
            ['Agents', AgentsIndex],
        ];

        for (const [title, page] of pages) {
            const Layout = page.layout as React.ComponentType<{
                children: React.ReactNode;
            }>;
            const view = await render(
                <TooltipProvider>
                    <Layout>
                        <p>content</p>
                    </Layout>
                </TooltipProvider>,
            );

            expect(
                view.container.querySelector('nav[aria-label="breadcrumb"]')
                    ?.textContent,
            ).toContain(title);
        }
    });

    it('names the builder breadcrumb after the widget', async () => {
        const Layout = WidgetBuilder.layout as React.ComponentType<{
            children: React.ReactNode;
            widget: { ulid: string; name: string };
        }>;
        const data = makeBuilderData();
        const view = await render(
            <TooltipProvider>
                <Layout widget={data.widget}>
                    <p>content</p>
                </Layout>
            </TooltipProvider>,
        );
        const crumbs = view.container.querySelector(
            'nav[aria-label="breadcrumb"]',
        );

        expect(crumbs?.textContent).toContain('Widgets');
        expect(crumbs?.textContent).toContain('Marketing site');
    });

    it('translates the Settings > Auth breadcrumb and keeps the settings menu around the page', async () => {
        expect(AuthSettings.layout).toHaveLength(2);
        expect(AuthSettings.layout[1]).toBe(SettingsLayout);

        const Layout = AuthSettings.layout[0] as React.ComponentType<{
            children: React.ReactNode;
        }>;
        const view = await render(
            <TooltipProvider>
                <Layout>
                    <p>content</p>
                </Layout>
            </TooltipProvider>,
        );

        // The text comes from the translation table (settings.auth.title), not from a literal.
        expect(
            view.container.querySelector('nav[aria-label="breadcrumb"]')
                ?.textContent,
        ).toContain(en['settings.auth.title']);
    });

    it('translates the Settings > Notifications breadcrumb (no literal English) and keeps the settings menu around the page', async () => {
        expect(NotificationSettings.layout).toHaveLength(2);
        expect(NotificationSettings.layout[1]).toBe(SettingsLayout);

        const Layout = NotificationSettings.layout[0] as React.ComponentType<{
            children: React.ReactNode;
        }>;
        const view = await render(
            <TooltipProvider>
                <Layout>
                    <p>content</p>
                </Layout>
            </TooltipProvider>,
        );

        expect(
            view.container.querySelector('nav[aria-label="breadcrumb"]')
                ?.textContent,
        ).toContain(en['notifications.settings.title']);
    });

    it('puts support categories inside the settings layout', () => {
        expect(SupportCategories.layout).toHaveLength(2);
        expect(SupportCategories.layout[1]).toBe(SettingsLayout);
    });
});
