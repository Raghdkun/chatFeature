/**
 * Phase 2 screenshots for the project deck: `npm run e2e:screenshots` (E2E_SCREENSHOTS=1).
 *
 * Mode 2 (Auth Portal) against the local pizzasys harness: the wizard screens (portal environment, passed and
 * failed connection test, validation, verified portal admin, a refused account, install summary, done), the
 * portal variant of the sign-in page (plain, wrong password, no chat access, portal unreachable) and
 * Settings > Auth (health, environments, switch dialog, roles, the read-only profile). Every screen is saved
 * light and dark, desktop (1280px) and mobile (375px @2x) as
 * docs/screenshots/p2/NN-description-{desktop|mobile}-{light|dark}.png (git-ignored PNGs).
 *
 * The wizard screens come from the read-only `wizard-views-pizzasys` scenario: the connection tests and the
 * install steps are answered locally (nothing is saved or installed), the refused portal account is a real
 * attempt. The "portal unreachable" screens stop the harness for a moment and always start it again.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import { type Browser, type Page, type TestInfo } from '@playwright/test';
import { harnessIsUp, startHarness, stopHarness } from '../support/harness';
import { ROOT } from '../support/scenarios';
import {
    captureElementTo,
    captureTo,
    instance,
    newContext,
    type Viewport,
} from '../support/shots';
import { expect, test } from '../support/test';
import { authStatePath, portalUsers } from '../support/users';
import {
    expectStep,
    FAILED_TEST,
    mockConnectionTest,
    PASSED_TEST,
    submitPortalAdmin,
} from '../support/wizard';

const OUTPUT = `${ROOT}docs/screenshots/p2`;
const users = portalUsers();

const capture = (page: Page, viewport: Viewport, name: string) =>
    captureTo(OUTPUT, page, viewport, name);

async function captureWizard(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const target = instance('wizard-views-pizzasys');
    const context = await newContext(browser, viewport, target);
    const page = await context.newPage();

    try {
        await page.goto('/setup?step=mode');
        await expectStep(page, 'mode');
        await expect(page.locator('#setup-mode-pizzasys')).toBeChecked();
        await capture(page, viewport, '01-wizard-signin-method-portal');

        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');
        await capture(page, viewport, '02-wizard-portal-environment');

        await page.getByTestId('setup-env-testing-toggle').click();
        await expect(
            page.getByTestId('setup-env-testing-base-url'),
        ).toBeVisible();
        await capture(page, viewport, '03-wizard-portal-testing-environment');
        await page.getByTestId('setup-env-testing-toggle').click();

        await mockConnectionTest(page, PASSED_TEST);
        await page.getByTestId('setup-env-test-production').click();
        await expect(
            page.getByTestId('setup-env-result-production'),
        ).toHaveAttribute('data-ok', 'true');
        await capture(page, viewport, '04-wizard-portal-test-passed');

        await mockConnectionTest(page, FAILED_TEST);
        await page.getByTestId('setup-env-test-production').click();
        await expect(
            page.getByTestId('setup-env-result-production'),
        ).toHaveAttribute('data-ok', 'false');
        await expect(
            page.getByTestId(
                'setup-env-result-production-service_credential-hint',
            ),
        ).toBeVisible();
        await capture(page, viewport, '05-wizard-portal-test-failed');

        // Rejected in the browser: nothing is sent.
        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');
        await page
            .getByTestId('setup-env-production-base-url')
            .fill('http://auth.example.com');
        await page.getByTestId('setup-pizzasys-submit').click();
        await expect(
            page.locator('#setup-env-production-base-url-error'),
        ).toBeVisible();
        await capture(page, viewport, '06-wizard-portal-validation');

        await page.goto('/setup?step=portal-admin');
        await expectStep(page, 'portal-admin');
        await expect(page.getByTestId('setup-portal-verified')).toBeVisible();
        await capture(page, viewport, '07-wizard-portal-admin-verified');

        await page.getByTestId('setup-portal-change').click();
        await submitPortalAdmin(page, users.agent);
        await expect(page.getByTestId('setup-portal-problem')).toHaveAttribute(
            'data-code',
            'not_admin',
        );
        await capture(page, viewport, '08-wizard-portal-admin-refused');

        await page.goto('/setup?step=run');
        await expectStep(page, 'run');
        await capture(page, viewport, '09-wizard-install-ready');

        // The success screen from locally answered install steps (nothing is installed), kept on display.
        const next: Record<string, string | null> = {
            'run-migrations': 'seed-defaults',
            'seed-defaults': 'create-admin',
            'create-admin': 'write-lock',
            'write-lock': null,
        };
        await page.route('**/setup/run/*', async (route) => {
            const step = new URL(route.request().url()).pathname
                .split('/')
                .pop() as string;

            await route.fulfill({
                json: {
                    status: 'ok',
                    next: next[step] ?? null,
                    ...(next[step] === null ? { redirect: '/login' } : {}),
                },
            });
        });

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

        await page.getByTestId('setup-run-start').click();
        await expectStep(page, 'done');
        await capture(page, viewport, '10-wizard-done-portal');
        releaseLogin();
    } finally {
        await context.close();
    }
}

async function captureSignedOut(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const target = instance('installed-pizzasys');
    const context = await newContext(browser, viewport, target);
    const page = await context.newPage();

    try {
        await page.goto('/login');
        await expect(page.getByTestId('login-portal-hint')).toBeVisible();
        await capture(page, viewport, '20-login-portal');

        await page.locator('#email').fill('nobody@test.local');
        await page.locator('#password').fill('not-the-password');
        await page.locator('[data-test="login-button"]').click();
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();
        await capture(page, viewport, '21-login-portal-error');

        await page.goto('/login');
        await page.locator('#email').fill(users.noRole.email);
        await page.locator('#password').fill(users.noRole.password);
        await page.locator('[data-test="login-button"]').click();
        await expect(page.getByTestId('login-no-chat-access')).toBeVisible();
        await capture(page, viewport, '22-login-portal-no-chat-access');
    } finally {
        await context.close();
    }
}

async function captureSettings(
    browser: Browser,
    viewport: Viewport,
): Promise<void> {
    const target = instance('installed-pizzasys');
    const context = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, 'admin'),
    );
    const page = await context.newPage();

    try {
        await page.goto('/settings/auth');
        await expect(page.getByTestId('settings-auth-health')).toHaveAttribute(
            'data-status',
            'ok',
        );
        await capture(page, viewport, '30-settings-auth');
        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('settings-auth-health'),
            viewport,
            '31-settings-auth-health',
        );

        await page.getByTestId('settings-auth-env-production-test').click();
        await expect(
            page.getByTestId('settings-auth-env-production-result'),
        ).toHaveAttribute('data-ok', 'true');
        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('settings-auth-env-production'),
            viewport,
            '32-settings-auth-environment-tested',
        );

        await captureElementTo(
            OUTPUT,
            page,
            page.getByTestId('settings-auth-roles'),
            viewport,
            '33-settings-auth-roles',
        );

        await page.getByTestId('settings-auth-switch-open').click();
        await expect(
            page.getByTestId('settings-auth-switch-dialog'),
        ).toBeVisible();
        await capture(page, viewport, '34-settings-auth-switch-dialog');

        await page
            .getByTestId('settings-auth-switch-email')
            .fill('admin@test.local');
        await page
            .getByTestId('settings-auth-switch-password')
            .fill('••••••••');
        await page.getByTestId('settings-auth-switch-ack').click();
        await capture(page, viewport, '35-settings-auth-switch-dialog-ready');

        await page.goto('/settings/profile');
        await expect(page.getByTestId('profile-managed')).toBeVisible();
        await capture(page, viewport, '36-settings-profile-managed');
    } finally {
        await context.close();
    }
}

/** The portal is stopped for a moment: the sign-in notice and the health card both show it. */
async function captureOutage(browser: Browser): Promise<void> {
    const target = instance('installed-pizzasys');

    await stopHarness();

    try {
        for (const viewport of ['desktop', 'mobile'] as const) {
            const guest = await newContext(browser, viewport, target);
            const admin = await newContext(
                browser,
                viewport,
                target,
                authStatePath(target, 'admin'),
            );

            try {
                const guestPage = await guest.newPage();

                // Five failures within 30 seconds open the circuit breaker: the health card then says "Down".
                for (const account of [
                    users.chatAdmin,
                    users.agent,
                    users.roleAgent,
                    users.noRole,
                    users.storeUser,
                ]) {
                    await guestPage.goto('/login');
                    await guestPage.locator('#email').fill(account.email);
                    await guestPage.locator('#password').fill(account.password);
                    await guestPage
                        .locator('[data-test="login-button"]')
                        .click();
                    await expect(
                        guestPage.getByTestId('login-portal-unavailable'),
                    ).toBeVisible();
                }

                await capture(
                    guestPage,
                    viewport,
                    '23-login-portal-unreachable',
                );

                const adminPage = await admin.newPage();
                await adminPage.goto('/settings/auth');
                await expect(
                    adminPage.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', 'down');
                await captureElementTo(
                    OUTPUT,
                    adminPage,
                    adminPage.getByTestId('settings-auth-health'),
                    viewport,
                    '37-settings-auth-health-down',
                );
            } finally {
                await guest.close();
                await admin.close();
            }
        }
    } finally {
        await startHarness();
    }
}

test.skip(
    process.env.E2E_SCREENSHOTS !== '1',
    'Screenshots only run with E2E_SCREENSHOTS=1 (npm run e2e:screenshots).',
);
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

test.afterAll(async () => {
    if (!(await harnessIsUp())) {
        await startHarness();
    }
});

for (const viewport of ['desktop', 'mobile'] as const) {
    test(`Auth Portal wizard, sign-in and settings screens, ${viewport}`, async ({
        browser,
    }: {
        browser: Browser;
    }, testInfo: TestInfo) => {
        test.setTimeout(240_000);

        await captureWizard(browser, viewport);
        await captureSignedOut(browser, viewport);
        await captureSettings(browser, viewport);

        testInfo.annotations.push({
            type: 'screenshots',
            description: `${OUTPUT} (${viewport})`,
        });
    });
}

// Last: it stops the harness (a running outage would break the screens above).
test('portal unreachable screens, desktop and mobile', async ({
    browser,
}: {
    browser: Browser;
}, testInfo: TestInfo) => {
    test.setTimeout(240_000);

    await captureOutage(browser);

    testInfo.annotations.push({
        type: 'screenshots',
        description: `${OUTPUT} (outage)`,
    });
});
