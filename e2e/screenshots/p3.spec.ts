/**
 * Phase 3 screenshots for the project deck: `E2E_SCREENSHOTS=1 E2E_ONLY=p3-views E2E_SKIP_PIZZASYS=1 npx playwright test
 * e2e/screenshots/p3.spec.ts` (or `npm run e2e:screenshots`, which runs every phase).
 *
 * The catalog and widget screens of the administrator (categories, agents, widgets, every tab of the builder with its live
 * preview in three device frames, the agents' own support categories) and the REAL widget on a customer-site page of
 * another origin (closed bubble, the flip with its greeting popup, the opened chat frame). Every screen is saved light and dark,
 * desktop (1280px) and mobile (375px @2x) as docs/screenshots/p3/NN-description-{desktop|mobile}-{light|dark}.png (git-ignored PNGs).
 *
 * Read-only against the seeded `p3-views` scenario ("Acme Storefront" is a fixed demo widget), so the images only change when the
 * screens do: reduced motion, fonts and transitions settled, and the clock of the page fixed where a relative time is shown.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { type Browser, type Page, type TestInfo } from '@playwright/test';
import { Api } from '../support/api';
import { dismiss } from '../support/helpers';
import { hostPage, settleWidget, widget } from '../support/host';
import { ROOT } from '../support/scenarios';
import {
    captureElementTo,
    captureTo,
    instance,
    newContext,
    VIEWPORTS,
    type Viewport,
} from '../support/shots';
import { expect, test } from '../support/test';
import { authStatePath } from '../support/users';

const OUTPUT = `${ROOT}docs/screenshots/p3`;
const target = instance('p3-views');
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

const capture = (page: Page, viewport: Viewport, name: string) =>
    captureTo(OUTPUT, page, viewport, name);

async function demo(page: Page): Promise<{ ulid: string; key: string }> {
    const api = new Api(page.request, target.url);
    const list = (await api.ok('GET', '/api/v1/widgets')).data as {
        ulid: string;
        name: string;
        public_key: string;
    }[];
    const found = list.find((item) => item.name === 'Acme Storefront')!;

    return { ulid: found.ulid, key: found.public_key };
}

async function captureAdminScreens(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const context = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'admin'),
    );
    const page = await context.newPage();
    const phone = viewport === 'mobile';

    try {
        // Categories.
        await page.goto('/categories');
        await expect(page.getByTestId('categories-page')).toBeVisible();
        await capture(page, viewport, '01-categories');

        await page.getByTestId('category-create').click();
        await expect(page.getByTestId('category-dialog')).toBeVisible();
        await page.getByLabel('Name', { exact: true }).fill('Shipping');
        await page.getByRole('button', { name: '#e11d48' }).click();
        await capture(page, viewport, '02-category-dialog');
        await dismiss(page);

        // Agents.
        await page.goto('/agents');
        await expect(page.getByTestId('agents-page')).toBeVisible();
        await capture(page, viewport, '03-agents');

        await page
            .getByTestId(/^agent-categories-\d+$/)
            .first()
            .click();
        await expect(page.getByTestId(/^agent-categories-menu-/)).toBeVisible();
        await capture(page, viewport, '04-agent-categories-picker');
        await dismiss(page);

        await page.getByTestId('agent-create').click();
        await expect(page.getByTestId('agent-create-dialog')).toBeVisible();
        await capture(page, viewport, '05-agent-create-dialog');
        await dismiss(page);

        // Widgets: relative times ("Updated 5 minutes ago") depend on the clock, so the page gets a fixed one.
        const { ulid } = await demo(page);
        const api = new Api(page.request, target.url);
        const items = (await api.ok('GET', '/api/v1/widgets')).data as {
            updated_at: string;
        }[];
        const latest = Math.max(
            ...items.map((item) => Date.parse(item.updated_at)),
        );

        await page.clock.setFixedTime(new Date(latest + 5 * 60_000));
        await page.goto('/widgets');
        await expect(page.getByTestId('widgets-page')).toBeVisible();
        await capture(page, viewport, '06-widgets');

        // The builder: every tab (the page includes the live preview on a wide screen).
        await page.goto(`/widgets/${ulid}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();

        let number = 7;

        for (const tab of TABS) {
            await page.getByTestId(`builder-tab-${tab}`).click();
            await expect(
                page.getByTestId(`builder-panel-${tab}`),
            ).toBeVisible();
            await page.evaluate(() => window.scrollTo(0, 0));
            await capture(
                page,
                viewport,
                `${String(number).padStart(2, '0')}-builder-${tab}`,
            );
            number += 1;
        }

        // A validation problem in the hours tab.
        await page.getByTestId('builder-tab-hours').click();
        await page.getByTestId('builder-hours-add-1').click();
        await page.getByLabel('Monday opening time').nth(1).fill('10:00');
        await page.getByLabel('Monday closing time').nth(1).fill('12:00');
        await page.getByTestId('builder-save').click();
        await expect(
            page.getByTestId('builder-tab-hours-error'),
        ).toBeAttached();
        await page.evaluate(() => window.scrollTo(0, 0));
        await capture(page, viewport, '16-builder-hours-validation');

        // Back to a clean builder for the preview frames.
        await page.goto(`/widgets/${ulid}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();

        if (phone) {
            await page
                .getByTestId('builder-view-switch')
                .getByText('Preview', { exact: true })
                .click();
        }

        await expect(
            page.getByTestId('builder-preview-status'),
        ).toHaveAttribute('data-loader', 'ready');

        const frame = page.frameLocator(
            '[data-testid="builder-preview-iframe"]',
        );
        const previewShot = async (label: string) => {
            await expect(frame.locator('pne-chat-widget .greet')).toBeVisible({
                timeout: 15_000,
            });
            await settleWidget(frame);
            await captureElementTo(
                OUTPUT,
                page,
                page.getByTestId('builder-preview'),
                viewport,
                label,
            );
        };

        await previewShot('17-builder-preview-1024px');

        for (const [device, label] of [
            ['tablet', '18-builder-preview-768px'],
            ['phone', '19-builder-preview-375px'],
        ] as const) {
            await page
                .getByTestId('builder-preview-device')
                .getByRole('radio', { name: new RegExp(device, 'i') })
                .check({ force: true });
            await expect(
                page.getByTestId('builder-preview-status'),
            ).toHaveAttribute('data-loader', 'ready');
            await previewShot(label);
        }

        await page
            .getByTestId('builder-preview-view')
            .getByText('Approximation', { exact: true })
            .click();
        await expect(page.getByTestId('preview-static')).toBeVisible();
        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('builder-preview'),
            viewport,
            '20-builder-preview-approximation',
        );
    } finally {
        await context.close();
    }
}

async function captureAgentScreens(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const agent = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'agent'),
    );
    const adminOnly = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'admin-only'),
    );

    try {
        const page = await agent.newPage();

        await page.goto('/settings/support-categories');
        await expect(page.getByTestId('support-categories-page')).toBeVisible();
        const boxes = page.getByTestId(/^support-category-check-/);

        await boxes.nth(1).click();
        await boxes.nth(2).click();
        await capture(page, viewport, '21-support-categories-agent');

        const notAgent = await adminOnly.newPage();

        await notAgent.goto('/settings/support-categories');
        await expect(
            notAgent.getByTestId('support-categories-not-agent'),
        ).toBeVisible();
        await capture(notAgent, viewport, '22-support-categories-not-agent');
    } finally {
        await agent.close();
        await adminOnly.close();
    }
}

/** The widget on the customer's page: no dashboard session, light and dark follow the page's colour scheme. */
async function captureHostPage(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const context = await browser.newContext({
        ...VIEWPORTS[viewport],
        colorScheme: 'light',
        // The flip is part of the picture: let it run (screenshots wait for it to finish).
        reducedMotion: 'no-preference',
        locale: 'en-US',
        timezoneId: 'UTC',
        storageState: { cookies: [], origins: [] },
    });
    const page = await context.newPage();
    const admin = await browser.newContext({
        baseURL: target.url,
        storageState: authStatePath(target, 'admin'),
    });

    try {
        const list = (
            await new Api(admin.request, target.url).ok(
                'GET',
                '/api/v1/widgets',
            )
        ).data as { name: string; public_key: string }[];
        const key = list.find(
            (item) => item.name === 'Acme Storefront',
        )!.public_key;
        const shoot = async (name: string, theme: 'light' | 'dark') => {
            await page.emulateMedia({
                colorScheme: theme,
                reducedMotion: 'no-preference',
            });
            await settleWidget(page);
            await page.evaluate(() =>
                (document.activeElement as HTMLElement | null)?.blur(),
            );
            await page.screenshot({
                path: `${OUTPUT}/${name}-${viewport}-${theme}.png`,
                animations: 'disabled',
                caret: 'hide',
            });
        };
        const both = async (name: string) => {
            await shoot(name, 'light');
            await shoot(name, 'dark');
            await page.emulateMedia({ colorScheme: 'light' });
        };

        // A short page: the picture is the viewport, the widget sits in its corner.
        await page.goto(
            hostPage(target, {
                key,
                height: 200,
                title: 'Acme Store',
                attrs: { greetings: 'off' },
            }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await both('23-widget-on-host-page-closed');

        // The greeting: the launcher flips to the agent and the popup slides in (deterministic pick: the heaviest message).
        await page.addInitScript(() => {
            Math.random = () => 0;
        });
        await page.goto(
            hostPage(target, { key, height: 200, title: 'Acme Store' }),
        );
        await expect(widget(page).greeting).toBeVisible({ timeout: 15_000 });
        await expect(widget(page).card).toHaveAttribute('data-flip', 'agent');
        await both('24-widget-on-host-page-greeting');

        // Opened: the chat frame the loader creates (the P3 placeholder page until the chat arrives in P4).
        await widget(page).launcher.click();
        await expect(widget(page).panel).toHaveAttribute('data-open', 'true');
        await expect(
            widget(page)
                .iframe.contentFrame()
                .getByText('Chat panel (coming in P4)'),
        ).toBeVisible();
        await both('25-widget-on-host-page-opened');
    } finally {
        await admin.close();
        await context.close();
    }
}

test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });

    // Names change between runs; do not leave stale files behind.
    for (const file of readdirSync(OUTPUT)) {
        if (file.endsWith('.png')) {
            rmSync(`${OUTPUT}/${file}`);
        }
    }
});

for (const viewport of ['desktop', 'mobile'] as const) {
    test(`catalog, widgets, builder and the widget on a host page, ${viewport}`, async ({
        browser,
    }: {
        browser: Browser;
    }, testInfo: TestInfo) => {
        test.setTimeout(240_000);

        await captureAdminScreens(browser, viewport);
        await captureAgentScreens(browser, viewport);
        await captureHostPage(browser, viewport);

        testInfo.annotations.push({
            type: 'screenshots',
            description: `${OUTPUT} (${viewport})`,
        });
    });
}
