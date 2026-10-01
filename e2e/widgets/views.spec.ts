import { type Page, type TestInfo } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { type Api } from '../support/api';
import {
    expectNoHorizontalScroll,
    dismiss,
    expectNoSeriousA11yViolations,
    setTheme,
    settle,
    type Theme,
} from '../support/helpers';
import { hostPage, settleWidget, widget } from '../support/host';
import { expect, test } from '../support/test';

/**
 * The P3 screens as a person with a screen reader, a phone or an Arabic UI meets them: axe (WCAG A/AA, light and dark), no
 * sideways scrolling at 375px, and right-to-left layout. Read-only: dialogs are opened and cancelled, nothing is saved, so the
 * three scenarios (English, English host page, Arabic) are shared by both projects.
 */
const THEMES: Theme[] = ['light', 'dark'];
const TABS = [
    'general',
    'branding',
    'texts',
    'features',
    'greetings',
    'hours',
    'domains',
    'categories',
    'embed',
] as const;

async function bothThemes(
    page: Page,
    testInfo: TestInfo,
    label: string,
): Promise<void> {
    for (const theme of THEMES) {
        await setTheme(page, theme);
        await expectNoSeriousA11yViolations(
            page,
            testInfo,
            `${label}-${theme}`,
        );
    }

    await setTheme(page, 'light');
}

async function demoWidgetUlid(api: Api): Promise<string> {
    const list = (await api.ok('GET', '/api/v1/widgets')).data as {
        ulid: string;
        name: string;
    }[];

    return list.find((item) => item.name === 'Acme Storefront')!.ulid;
}

async function openTab(page: Page, tab: (typeof TABS)[number]): Promise<void> {
    await page.getByTestId(`builder-tab-${tab}`).click();
    await expect(page.getByTestId(`builder-panel-${tab}`)).toBeVisible();
}

test.describe('accessibility (axe, WCAG A/AA)', () => {
    test.use({ scenario: 'p3-views', role: 'admin' });

    test('categories: list, create dialog, delete dialog', async ({
        page,
    }, testInfo) => {
        await page.goto('/categories');
        await expect(page.getByTestId('categories-page')).toBeVisible();
        await bothThemes(page, testInfo, 'categories');

        await page.getByTestId('category-create').click();
        await expect(page.getByTestId('category-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'category-dialog');
        await dismiss(page);

        await page
            .getByRole('button', { name: /^Delete / })
            .first()
            .click();
        await expect(page.getByTestId('category-delete-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'category-delete-dialog');
        await dismiss(page);

        // The empty search result.
        await page.getByTestId('category-search').fill('zzzz-nothing');
        await expect(page.getByTestId('categories-no-match')).toBeVisible();
        await bothThemes(page, testInfo, 'categories-no-match');
    });

    test('agents: list, categories popover, create dialog', async ({
        page,
    }, testInfo) => {
        await page.goto('/agents');
        await expect(page.getByTestId('agents-page')).toBeVisible();
        await bothThemes(page, testInfo, 'agents');

        await page
            .getByTestId(/^agent-categories-\d+$/)
            .first()
            .click();
        await expect(page.getByTestId(/^agent-categories-menu-/)).toBeVisible();
        await bothThemes(page, testInfo, 'agents-categories-popover');
        await dismiss(page);

        await page.getByTestId('agent-create').click();
        await expect(page.getByTestId('agent-create-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'agent-create-dialog');
        await page.getByTestId('agent-create-submit').click();
        await expect(
            page.getByTestId('agent-create-dialog').getByText('Enter a name.'),
        ).toBeVisible();
        await bothThemes(page, testInfo, 'agent-create-dialog-errors');
    });

    test('widgets: list and create dialog', async ({ page }, testInfo) => {
        await page.goto('/widgets');
        await expect(page.getByTestId('widgets-page')).toBeVisible();
        await bothThemes(page, testInfo, 'widgets');

        await page.getByTestId('widget-create').click();
        await expect(page.getByTestId('widget-create-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'widget-create-dialog');
        await page.getByTestId('widget-create-submit').click();
        await bothThemes(page, testInfo, 'widget-create-dialog-error');
    });

    test('builder: every tab, with the live preview', async ({
        page,
        api,
    }, testInfo) => {
        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();

        const phone = testInfo.project.name === 'mobile';

        for (const tab of TABS) {
            await openTab(page, tab);
            await bothThemes(page, testInfo, `builder-${tab}`);
        }

        // Dialogs of the builder header and the general tab.
        await openTab(page, 'general');
        await page.getByTestId('builder-enabled-toggle').click();
        await expect(page.getByTestId('builder-enabled-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'builder-enabled-dialog');
        await dismiss(page);

        // Publish needs something to publish: make a change, but never confirm.
        await openTab(page, 'branding');
        await page
            .getByTestId('builder-panel-branding')
            .getByRole('textbox', { name: 'Label', exact: true })
            .fill('Axe label');
        await page.getByTestId('builder-publish').click();
        await expect(page.getByTestId('builder-publish-dialog')).toBeVisible();
        await bothThemes(page, testInfo, 'builder-publish-dialog');
        await dismiss(page);

        // A validation error state (hours overlap) and the preview in both of its views.
        await openTab(page, 'hours');
        await page.getByTestId('builder-hours-add-1').click();
        await page.getByLabel('Monday opening time').nth(1).fill('10:00');
        await page.getByLabel('Monday closing time').nth(1).fill('12:00');
        await page.getByTestId('builder-save').click();
        await expect(
            page.getByTestId('builder-tab-hours-error'),
        ).toBeAttached();
        await bothThemes(page, testInfo, 'builder-hours-errors');

        if (phone) {
            await page
                .getByTestId('builder-view-switch')
                .getByText('Preview', { exact: true })
                .click();
        }

        await expect(page.getByTestId('builder-preview')).toBeVisible();
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        await bothThemes(page, testInfo, 'builder-preview-live');
        await page
            .getByTestId('builder-preview-view')
            .getByText('Approximation', { exact: true })
            .click();
        await expect(page.getByTestId('preview-static')).toBeVisible();
        await bothThemes(page, testInfo, 'builder-preview-static');
    });

    test('structure: headings go down one level at a time and there is one main landmark', async ({
        page,
        api,
    }) => {
        const structure = async (label: string) => {
            const results = await new AxeBuilder({ page })
                .withRules([
                    'heading-order',
                    'landmark-unique',
                    'landmark-one-main',
                    'page-has-heading-one',
                ])
                .analyze();

            expect(
                results.violations.map((violation) => ({
                    id: violation.id,
                    nodes: violation.nodes.map((node) => node.target.join(' ')),
                })),
                `document structure of ${label}`,
            ).toEqual([]);
        };

        for (const path of [
            '/categories',
            '/widgets',
            '/agents',
            '/settings/support-categories',
        ]) {
            await page.goto(path);
            await expect(page.locator('main')).toBeVisible();
            await structure(path);
        }

        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);
        await expect(page.getByTestId('builder-preview-status'))
            .toHaveAttribute('data-loader', 'ready')
            .catch(() => undefined);

        for (const tab of TABS) {
            await openTab(page, tab);
            await structure(`builder ${tab}`);
        }
    });

    test('my support categories (agent) and the not-an-agent notice (administrator)', async ({
        page,
        browser,
        instance,
    }, testInfo) => {
        // The administrator of this scenario takes chats: the picker is shown.
        await page.goto('/settings/support-categories');
        await expect(page.getByTestId('support-categories-page')).toBeVisible();
        await bothThemes(page, testInfo, 'support-categories-admin');

        const agent = await browser.newContext({
            baseURL: instance.url,
            storageState: `${instance.authDir}/agent.json`,
        });
        const notAgent = await browser.newContext({
            baseURL: instance.url,
            storageState: `${instance.authDir}/admin-only.json`,
        });

        try {
            const agentPage = await agent.newPage();

            await agentPage.goto('/settings/support-categories');
            await expect(
                agentPage.getByTestId('support-categories-save'),
            ).toBeVisible();
            await agentPage
                .getByTestId(/^support-category-check-/)
                .first()
                .click();
            await expect(
                agentPage.getByTestId('support-categories-status'),
            ).toHaveText('You have unsaved changes.');
            await bothThemes(agentPage, testInfo, 'support-categories-agent');

            const adminOnly = await notAgent.newPage();

            await adminOnly.goto('/settings/support-categories');
            await expect(
                adminOnly.getByTestId('support-categories-not-agent'),
            ).toBeVisible();
            await bothThemes(
                adminOnly,
                testInfo,
                'support-categories-not-agent',
            );
        } finally {
            await agent.close();
            await notAgent.close();
        }
    });

    test('the widget on a host page: launcher, greeting popup and opened chat frame', async ({
        page,
        api,
        instance,
    }, testInfo) => {
        const list = (await api.ok('GET', '/api/v1/widgets')).data as {
            name: string;
            public_key: string;
        }[];
        const key = list.find(
            (item) => item.name === 'Acme Storefront',
        )!.public_key;
        const scoped = async (label: string) => {
            await settleWidget(page);

            for (const theme of THEMES) {
                // The host page is not the app: the widget follows the page's colour-scheme preference.
                await page.emulateMedia({ colorScheme: theme });
                await settleWidget(page);

                const results = await new AxeBuilder({ page })
                    .include('pne-chat-widget')
                    .withTags([
                        'wcag2a',
                        'wcag2aa',
                        'wcag21a',
                        'wcag21aa',
                        'wcag22aa',
                    ])
                    .analyze();

                await testInfo.attach(`axe-${label}-${theme}`, {
                    body: JSON.stringify(results.violations, null, 2),
                    contentType: 'application/json',
                });
                expect(
                    results.violations
                        .filter(
                            (violation) =>
                                violation.impact === 'serious' ||
                                violation.impact === 'critical',
                        )
                        .map((violation) => ({
                            id: violation.id,
                            nodes: violation.nodes.map((node) =>
                                node.html.slice(0, 120),
                            ),
                        })),
                    `axe on the widget: ${label} (${theme})`,
                ).toEqual([]);
            }

            await page.emulateMedia({ colorScheme: 'light' });
        };

        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).launcher).toBeVisible();
        await scoped('launcher');

        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
        await scoped('greeting-popup');

        await widget(page).launcher.click();
        await expect(widget(page).panel).toHaveAttribute('data-open', 'true');
        await scoped('opened');
    });
});

test.describe('phone layout (375px, no sideways scrolling)', () => {
    test.use({
        scenario: 'p3-views',
        role: 'admin',
        viewport: { width: 375, height: 812 },
    });

    test('lists, dialogs and forms fit', async ({ page }) => {
        for (const [path, testId] of [
            ['/categories', 'categories-page'],
            ['/agents', 'agents-page'],
            ['/widgets', 'widgets-page'],
            ['/settings/support-categories', 'support-categories-page'],
        ] as const) {
            await page.goto(path);
            await expect(page.getByTestId(testId)).toBeVisible();
            await expectNoHorizontalScroll(page);
        }

        // Dialogs: nothing wider than the screen, the primary action reachable.
        await page.goto('/categories');
        await page.getByTestId('category-create').click();
        await expect(page.getByTestId('category-dialog')).toBeVisible();
        await expectNoHorizontalScroll(page);
        const dialog = (await page
            .getByTestId('category-dialog')
            .boundingBox())!;

        expect(dialog.x).toBeGreaterThanOrEqual(0);
        expect(dialog.x + dialog.width).toBeLessThanOrEqual(375);
        await page.getByTestId('category-submit').scrollIntoViewIfNeeded();
        await expect(page.getByTestId('category-submit')).toBeInViewport();
        await dismiss(page);

        await page.goto('/agents');
        await page.getByTestId('agent-create').click();
        await expect(page.getByTestId('agent-create-dialog')).toBeVisible();
        await expectNoHorizontalScroll(page);
        await dismiss(page);
        await page
            .getByTestId(/^agent-categories-\d+$/)
            .first()
            .click();
        await expect(page.getByTestId(/^agent-categories-menu-/)).toBeVisible();
        const popover = (await page
            .getByTestId(/^agent-categories-menu-/)
            .boundingBox())!;

        expect(popover.x).toBeGreaterThanOrEqual(0);
        expect(popover.x + popover.width).toBeLessThanOrEqual(375);

        await page.goto('/widgets');
        await page.getByTestId('widget-create').click();
        await expect(page.getByTestId('widget-create-dialog')).toBeVisible();
        await expectNoHorizontalScroll(page);
    });

    test('the builder: every tab fits, the tab strip scrolls inside itself, edit and preview switch', async ({
        page,
        api,
    }) => {
        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();
        await expect(page.getByTestId('builder-view-switch')).toBeVisible();

        for (const tab of TABS) {
            await openTab(page, tab);
            await expectNoHorizontalScroll(page);
        }

        // The header actions stay reachable (sticky) while the page scrolls.
        await openTab(page, 'texts');
        await page.mouse.wheel(0, 1500);
        await expect(page.getByTestId('builder-save')).toBeInViewport();

        await page
            .getByTestId('builder-view-switch')
            .getByText('Preview', { exact: true })
            .click();
        await expect(page.getByTestId('builder-preview')).toBeVisible();
        await expectNoHorizontalScroll(page);
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        // The device frame is scaled down to the column instead of overflowing it.
        const frame = (await page
            .getByTestId('builder-preview-frame')
            .boundingBox())!;

        expect(frame.x).toBeGreaterThanOrEqual(0);
        expect(frame.x + frame.width).toBeLessThanOrEqual(375);
        await page
            .getByTestId('builder-preview-view')
            .getByText('Approximation', { exact: true })
            .click();
        await expectNoHorizontalScroll(page);
    });

    test('the widget on a host page: launcher, popup and the full-screen panel fit', async ({
        page,
        api,
        instance,
    }) => {
        const list = (await api.ok('GET', '/api/v1/widgets')).data as {
            name: string;
            public_key: string;
        }[];
        const key = list.find(
            (item) => item.name === 'Acme Storefront',
        )!.public_key;

        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).greeting).toBeVisible({ timeout: 10_000 });
        await expectNoHorizontalScroll(page);
        const popup = (await widget(page).greeting.boundingBox())!;

        expect(popup.x).toBeGreaterThanOrEqual(0);
        expect(popup.x + popup.width).toBeLessThanOrEqual(375);

        await widget(page).launcher.click();
        await expect(widget(page).panel).toHaveAttribute(
            'data-mode',
            'fullscreen',
        );
        await settleWidget(page);
        const panel = (await widget(page).panel.boundingBox())!;

        expect(panel.width).toBe(375);
        expect(panel.height).toBe(812);
    });
});

test.describe('right-to-left (Arabic UI)', () => {
    test.use({ scenario: 'p3-views-rtl', role: 'admin' });

    const ARABIC = /[؀-ۿ]/;

    async function expectRtl(page: Page): Promise<void> {
        await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
        await expect
            .poll(() =>
                page.evaluate(() => getComputedStyle(document.body).direction),
            )
            .toBe('rtl');
    }

    test('categories, agents, widgets and support categories mirror, with the sidebar on the right', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });

        for (const [path, testId] of [
            ['/categories', 'categories-page'],
            ['/agents', 'agents-page'],
            ['/widgets', 'widgets-page'],
            ['/settings/support-categories', 'support-categories-page'],
        ] as const) {
            await page.goto(path);
            await expect(page.getByTestId(testId)).toBeVisible();
            await expectRtl(page);
            await expectNoHorizontalScroll(page);
            await expect(page.locator('[data-slot="sidebar"]')).toHaveAttribute(
                'data-side',
                'right',
            );
        }

        // Page chrome that is translated is Arabic; the rest of the seed falls back to English (lang/ar.json is partial).
        await page.goto('/widgets');
        await expect(
            page.getByRole('link', { name: ARABIC }).first(),
        ).toBeVisible();

        // Mixed content in an RTL row stays readable: the technical bits are isolated left-to-right.
        await page.goto('/categories');
        await expect(
            page.locator('[data-testid^="category-row-"] code').first(),
        ).toHaveAttribute('dir', 'ltr');
        await page.goto('/agents');
        await expect(
            page.locator('[data-testid^="agent-row-"] p[dir="ltr"]').first(),
        ).toBeVisible();
    });

    test('the builder mirrors: tabs, preview toggles, no overflow, and the preview widget keeps its corner', async ({
        page,
        api,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();
        await expectRtl(page);
        await expectNoHorizontalScroll(page);

        for (const tab of TABS) {
            await openTab(page, tab);
            await expectNoHorizontalScroll(page);
        }

        // Preview frames are drawn left-to-right (a fake site), whatever the dashboard's direction.
        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');
        await page
            .getByTestId('builder-preview-dir')
            .getByRole('radio', { name: 'RTL' })
            .check({ force: true });
        await expect(
            page
                .frameLocator('[data-testid="builder-preview-iframe"]')
                .locator('html'),
        ).toHaveAttribute('dir', 'rtl');
        await expect(
            page
                .frameLocator('[data-testid="builder-preview-iframe"]')
                .locator('pne-chat-widget button.launcher'),
        ).toBeVisible();
        await settle(page);
        await expectNoHorizontalScroll(page);
    });

    test('on a phone the pages and the builder fit and the drawer opens from the right', async ({
        page,
        api,
    }) => {
        await page.setViewportSize({ width: 375, height: 812 });

        for (const path of [
            '/categories',
            '/agents',
            '/widgets',
            '/settings/support-categories',
        ]) {
            await page.goto(path);
            await expectRtl(page);
            await expectNoHorizontalScroll(page);
        }

        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);
        await expectRtl(page);

        for (const tab of TABS) {
            await openTab(page, tab);
            await expectNoHorizontalScroll(page);
        }

        await page.goto('/categories');
        await page
            .getByRole('button', { name: 'Toggle Sidebar' })
            .first()
            .click();
        await expect(page.getByRole('dialog')).toBeVisible();
        await settle(page);
        const drawer = (await page.getByRole('dialog').boundingBox())!;

        expect(drawer.x + drawer.width).toBeGreaterThanOrEqual(374);
        await settle(page);
    });

    test('axe on the Arabic pages and the builder tabs', async ({
        page,
        api,
    }, testInfo) => {
        for (const path of [
            '/categories',
            '/agents',
            '/widgets',
            '/settings/support-categories',
        ]) {
            await page.goto(path);
            await expect(page.locator('main')).toBeVisible();
            await bothThemes(page, testInfo, `rtl${path.replaceAll('/', '-')}`);
        }

        await page.goto(`/widgets/${await demoWidgetUlid(api)}`);

        for (const tab of TABS) {
            await openTab(page, tab);
            await bothThemes(page, testInfo, `rtl-builder-${tab}`);
        }
    });
});
