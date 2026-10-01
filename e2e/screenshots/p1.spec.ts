/**
 * Phase 1 screenshots for the project deck: `npm run e2e:screenshots` (E2E_SCREENSHOTS=1).
 *
 * It walks the REAL first-run experience (setup token, wizard, install) on two throwaway servers,
 * then captures sign-in, both dashboards and the settings from the installed scenario, plus the
 * Arabic/RTL screens. Every screen is saved full page, light and dark, desktop (1280px) and
 * mobile (375px @2x) as docs/screenshots/p1/NN-description-{desktop|mobile}-{light|dark}.png.
 *
 * Deterministic on purpose: fixed names and data, reduced motion, web fonts and every finite
 * transition settled, animations disabled, caret hidden, no focus ring left behind.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { type Browser, type Page, type TestInfo } from '@playwright/test';
import { ROOT, SETUP_TOKEN, type Instance } from '../support/scenarios';
import {
    captureTo,
    instance,
    newContext,
    type Viewport,
} from '../support/shots';
import { expect, test } from '../support/test';
import { ADMIN, authStatePath, NO_ACCESS } from '../support/users';
import {
    expectStep,
    fillAdmin,
    INSTALL_TIMEOUT,
    submitAdmin,
} from '../support/wizard';

const OUTPUT = `${ROOT}docs/screenshots/p1`;

/** Saves the current screen in light and dark. */
const capture = (page: Page, viewport: Viewport, name: string) =>
    captureTo(OUTPUT, page, viewport, name);

async function walkTheWizard(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
): Promise<void> {
    const context = await newContext(browser, viewport, target);
    const page = await context.newPage();

    try {
        await page.goto('/setup');
        await expectStep(page, 'welcome');
        await expect(page.getByTestId('setup-token')).toBeVisible();
        await capture(page, viewport, '01-wizard-welcome-token');

        await page.locator('input[name=token]').fill(SETUP_TOKEN);
        await page.getByTestId('setup-token-submit').click();
        await expectStep(page, 'mode');

        // The environment check, one Back away.
        await page.getByTestId('setup-back').click();
        await expectStep(page, 'welcome');
        await expect(page.getByTestId('setup-environment')).toHaveAttribute(
            'data-ok',
            'true',
        );
        await capture(page, viewport, '02-wizard-environment');
        await page.getByTestId('setup-welcome-continue').click();

        await expectStep(page, 'mode');
        await capture(page, viewport, '03-wizard-signin-method');
        await page.getByTestId('setup-mode-submit').click();

        await expectStep(page, 'admin');
        await fillAdmin(page, ADMIN);
        await capture(page, viewport, '04-wizard-admin');

        await fillAdmin(page, { ...ADMIN, password: 'short' }, 'different');
        await submitAdmin(page);
        await expect(page.locator('#setup-admin-password-error')).toBeVisible();
        await capture(page, viewport, '05-wizard-admin-validation');

        await fillAdmin(page, ADMIN);
        await submitAdmin(page);

        await expectStep(page, 'basics');
        // A production-looking address for the deck (the value is only stored, never navigated to).
        await page
            .locator('input[name=app_url]')
            .fill('https://chat.example.com');
        await capture(page, viewport, '06-wizard-basics');
        await page.getByTestId('setup-basics-submit').click();

        await expectStep(page, 'run');
        await capture(page, viewport, '07-wizard-install-ready');

        // Show the install while it is running: hold the first request.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        await page.route('**/setup/run/run-migrations', async (route) => {
            await gate;
            await route.continue();
        });
        await page.getByTestId('setup-run-start').click();
        await expect(
            page.getByTestId('setup-run-row-run-migrations'),
        ).toHaveAttribute('data-status', 'running');
        await capture(page, viewport, '08-wizard-installing');

        // Keep the success screen on display (it moves on to /login by itself after a moment).
        let releaseLogin: () => void = () => undefined;
        const loginGate = new Promise<void>((resolve) => {
            releaseLogin = resolve;
        });
        await page.route(
            (url) => url.pathname === '/login',
            async (route) => {
                await loginGate;
                await route.continue();
            },
        );

        release();
        await expectStep(page, 'done', INSTALL_TIMEOUT);
        await capture(page, viewport, '09-wizard-done');

        releaseLogin();
        await expect(page).toHaveURL(/\/login$/);
    } finally {
        await context.close();
    }
}

async function captureSignedOut(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
): Promise<void> {
    const context = await newContext(browser, viewport, target);
    const page = await context.newPage();

    try {
        await page.goto('/login');
        await expect(page.locator('#email')).toBeVisible();
        await capture(page, viewport, '10-login');

        await page.locator('#email').fill('nobody@example.test');
        await page.locator('#password').fill('not-the-password');
        await page.locator('[data-test="login-button"]').click();
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();
        await capture(page, viewport, '11-login-error');

        await page.goto('/login');
        await page.locator('#email').fill(NO_ACCESS.email);
        await page.locator('#password').fill(NO_ACCESS.password);
        await page.locator('[data-test="login-button"]').click();
        await expect(page.getByTestId('login-no-chat-access')).toBeVisible();
        await capture(page, viewport, '12-login-no-chat-access');
    } finally {
        await context.close();
    }
}

async function captureSignedIn(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
): Promise<void> {
    const admin = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'admin'),
    );
    const adminPage = await admin.newPage();

    try {
        await adminPage.goto('/dashboard');
        await expect(
            adminPage.getByTestId('dashboard-admin-setup'),
        ).toBeVisible();
        await capture(adminPage, viewport, '13-dashboard-admin');

        if (viewport === 'mobile') {
            await adminPage
                .getByRole('button', { name: 'Toggle Sidebar' })
                .first()
                .click();
            await expect(adminPage.getByRole('dialog')).toBeVisible();
            await capture(adminPage, viewport, '17-sidebar-drawer');
        }

        await adminPage.goto('/settings/profile');
        await expect(adminPage.locator('input[name=email]')).toHaveValue(
            ADMIN.email,
        );
        await capture(adminPage, viewport, '15-settings-profile');

        await adminPage.goto('/settings/appearance');
        await expect(
            adminPage.getByRole('button', { name: 'Dark' }),
        ).toBeVisible();
        await capture(adminPage, viewport, '16-settings-appearance');
    } finally {
        await admin.close();
    }

    const agent = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'agent'),
    );
    const agentPage = await agent.newPage();

    try {
        await agentPage.goto('/dashboard');
        await expect(
            agentPage.getByTestId('dashboard-agent-waiting'),
        ).toBeVisible();
        await capture(agentPage, viewport, '14-dashboard-agent');
    } finally {
        await agent.close();
    }
}

async function captureArabic(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const wizard = await newContext(
        browser,
        viewport,
        instance('wizard-views-rtl'),
    );
    const wizardPage = await wizard.newPage();

    try {
        await wizardPage.goto('/setup?step=mode');
        await expectStep(wizardPage, 'mode');
        await expect(wizardPage.locator('html')).toHaveAttribute('dir', 'rtl');
        await capture(wizardPage, viewport, '20-wizard-signin-method-rtl');
    } finally {
        await wizard.close();
    }

    const app = instance('installed-rtl');
    const login = await newContext(browser, viewport, app);
    const loginPage = await login.newPage();

    try {
        await loginPage.goto('/login');
        await expect(loginPage.locator('#email')).toBeVisible();
        await capture(loginPage, viewport, '21-login-rtl');
    } finally {
        await login.close();
    }

    const admin = await newContext(
        browser,
        viewport,
        app,
        authStatePath(app, 'admin'),
    );
    const adminPage = await admin.newPage();

    try {
        await adminPage.goto('/dashboard');
        await expect(
            adminPage.getByTestId('dashboard-admin-setup'),
        ).toBeVisible();
        await capture(adminPage, viewport, '22-dashboard-admin-rtl');
    } finally {
        await admin.close();
    }
}

test.skip(
    process.env.E2E_SCREENSHOTS !== '1',
    'Screenshots only run with E2E_SCREENSHOTS=1 (npm run e2e:screenshots).',
);
test.describe.configure({ retries: 0 });

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
    test(`first run and sign-in screens, ${viewport}`, async ({
        browser,
    }: {
        browser: Browser;
    }, testInfo: TestInfo) => {
        test.setTimeout(240_000);

        await walkTheWizard(browser, viewport, instance(`shots-${viewport}`));
        await captureSignedOut(browser, viewport, instance('installed'));
        await captureSignedIn(browser, viewport, instance('installed'));
        await captureArabic(browser, viewport);

        testInfo.annotations.push({
            type: 'screenshots',
            description: `${OUTPUT} (${viewport})`,
        });
    });
}
