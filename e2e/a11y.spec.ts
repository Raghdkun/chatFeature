import { type Page } from '@playwright/test';
import {
    expectNoSeriousA11yViolations,
    setTheme,
    type Theme,
} from './support/helpers';
import { expect, test } from './support/test';
import { ADMIN, loginAccounts, portalUsers } from './support/users';
import {
    expectStep,
    FAILED_TEST,
    mockConnectionTest,
    PASSED_TEST,
    submitPortalAdmin,
    type StepKey,
} from './support/wizard';

/**
 * axe-core (WCAG 2.0/2.1/2.2 A + AA) on every wizard screen and the sign-in pages, in light and
 * dark. `serious` and `critical` findings fail the test; anything milder is attached to the
 * report. The `done` screen only exists for a few seconds after a real install and is checked in
 * install/wizard.spec.ts.
 */
const THEMES: Theme[] = ['light', 'dark'];

async function checkBothThemes(
    page: Page,
    testInfo: Parameters<typeof expectNoSeriousA11yViolations>[1],
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
}

test.describe('install wizard', () => {
    // Answers are stored but nothing is installed: every screen can be opened with ?step=.
    test.use({ scenario: 'wizard-views' });

    const steps: StepKey[] = ['welcome', 'mode', 'admin', 'basics', 'run'];

    for (const step of steps) {
        test(`${step} step`, async ({ page }, testInfo) => {
            await page.goto(`/setup?step=${step}`);
            await expectStep(page, step);

            await checkBothThemes(page, testInfo, `wizard-${step}`);
        });
    }

    test('run step with a failed step', async ({ page }, testInfo) => {
        await page.goto('/setup?step=run');
        await expectStep(page, 'run');

        // Answer the first step with a failure (no request reaches the server, nothing is installed).
        await page.route('**/setup/run/run-migrations', (route) =>
            route.fulfill({
                json: {
                    status: 'failed',
                    message:
                        'Could not connect to the database: access denied. Check DB_USERNAME and DB_PASSWORD.',
                },
            }),
        );
        await page.getByTestId('setup-run-start').click();
        await expect(page.getByTestId('setup-run-progress')).toHaveAttribute(
            'data-phase',
            'failed',
        );
        await expect(page.getByTestId('setup-run-retry')).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-run-failed');
    });

    test('admin step with validation errors', async ({ page }, testInfo) => {
        await page.goto('/setup?step=admin');
        await expectStep(page, 'admin');

        // Invalid input is never stored, so this does not change the server state.
        await page.locator('input[name=password]').fill('short');
        await page.locator('input[name=password_confirmation]').fill('other');
        await page.getByTestId('setup-admin-submit').click();
        await expect(page.locator('#setup-admin-password-error')).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-admin-errors');
    });

    test('basics step with validation errors', async ({ page }, testInfo) => {
        await page.goto('/setup?step=basics');
        await expectStep(page, 'basics');

        await page
            .locator('input[name=app_url]')
            .fill('ftp://chat.example.com');
        await page.getByTestId('setup-basics-submit').click();
        await expect(page.locator('#setup-app-url-error')).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-basics-errors');
    });
});

test.describe('install wizard behind the setup token', () => {
    test.use({ scenario: 'fresh-token' });

    test('welcome step asks for the token', async ({ page }, testInfo) => {
        await page.goto('/setup');
        await expectStep(page, 'welcome');
        await expect(page.getByTestId('setup-token')).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-welcome-token');
    });
});

test.describe('sign-in pages', () => {
    test.use({ scenario: 'installed' });

    test('login page', async ({ page }, testInfo) => {
        await page.goto('/login');
        await expect(page.locator('#email')).toBeVisible();

        await checkBothThemes(page, testInfo, 'login');
    });

    test('login page with an error', async ({ page }, testInfo) => {
        await page.goto('/login');
        await page.locator('#email').fill('nobody@example.test');
        await page.locator('#password').fill('wrong-password');
        await page.locator('[data-test="login-button"]').click();
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();

        await checkBothThemes(page, testInfo, 'login-error');
    });

    test('login page with the no-chat-access notice', async ({
        page,
    }, testInfo) => {
        const { noAccess } = loginAccounts(
            testInfo.project.name === 'mobile' ? 'mobile' : 'desktop',
        );

        await page.goto('/login');
        await page.locator('#email').fill(noAccess.email);
        await page.locator('#password').fill(noAccess.password);
        await page.locator('[data-test="login-button"]').click();
        await expect(page.getByTestId('login-no-chat-access')).toBeVisible();

        await checkBothThemes(page, testInfo, 'login-no-chat-access');
    });

    test('forgot password page', async ({ page }, testInfo) => {
        await page.goto('/forgot-password');
        await expect(page.locator('#email')).toBeVisible();

        await checkBothThemes(page, testInfo, 'forgot-password');
    });
});

// Saved sessions are chosen per describe through the `role` option.
test.describe('dashboards and settings (admin)', () => {
    test.use({ scenario: 'installed', role: 'admin' });

    test('admin dashboard', async ({ page }, testInfo) => {
        await page.goto('/dashboard');
        await expect(page.getByTestId('dashboard-admin-setup')).toBeVisible();

        await checkBothThemes(page, testInfo, 'dashboard-admin');
    });

    test('profile settings', async ({ page }, testInfo) => {
        await page.goto('/settings/profile');
        await expect(page.locator('input[name=email]')).toHaveValue(
            ADMIN.email,
        );

        await checkBothThemes(page, testInfo, 'settings-profile');
    });

    test('appearance settings', async ({ page }, testInfo) => {
        await page.goto('/settings/appearance');
        await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();

        await checkBothThemes(page, testInfo, 'settings-appearance');
    });
});

test.describe('dashboard (agent)', () => {
    test.use({ scenario: 'installed', role: 'agent' });

    test('agent dashboard', async ({ page }, testInfo) => {
        await page.goto('/dashboard');
        await expect(page.getByTestId('dashboard-agent-waiting')).toBeVisible();

        await checkBothThemes(page, testInfo, 'dashboard-agent');
    });
});

/**
 * Mode 2 (Auth Portal): the wizard screens, the portal variant of the sign-in page and Settings > Auth.
 * They need the local pizzasys harness (docs/testing.md).
 */
test.describe('install wizard, Auth Portal mode', { tag: '@pizzasys' }, () => {
    // Mode 2 answers (portal environment, roles, a verified portal admin) are stored: every screen opens with ?step=.
    test.use({ scenario: 'wizard-views-pizzasys' });

    for (const step of [
        'mode',
        'pizzasys',
        'portal-admin',
        'basics',
        'run',
    ] as StepKey[]) {
        test(`${step} step`, async ({ page }, testInfo) => {
            await page.goto(`/setup?step=${step}`);
            await expectStep(page, step);

            await checkBothThemes(page, testInfo, `wizard-pizzasys-${step}`);
        });
    }

    test('portal step with the Testing environment open', async ({
        page,
    }, testInfo) => {
        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');
        await page.getByTestId('setup-env-testing-toggle').click();
        await expect(
            page.getByTestId('setup-env-testing-base-url'),
        ).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-testing-open');
    });

    test('portal step with a passed connection test', async ({
        page,
    }, testInfo) => {
        await mockConnectionTest(page, PASSED_TEST);
        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');

        await page.getByTestId('setup-env-test-production').click();
        await expect(
            page.getByTestId('setup-env-result-production'),
        ).toHaveAttribute('data-ok', 'true');

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-test-passed');
    });

    test('portal step with a failed connection test', async ({
        page,
    }, testInfo) => {
        await mockConnectionTest(page, FAILED_TEST);
        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');

        await page.getByTestId('setup-env-test-production').click();
        await expect(
            page.getByTestId('setup-env-result-production'),
        ).toHaveAttribute('data-ok', 'false');
        await expect(
            page.getByTestId(
                'setup-env-result-production-service_credential-hint',
            ),
        ).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-test-failed');
    });

    test('portal step with validation errors', async ({ page }, testInfo) => {
        await page.goto('/setup?step=pizzasys');
        await expectStep(page, 'pizzasys');

        // Rejected in the browser: nothing is sent, the stored answers stay as they are.
        await page
            .getByTestId('setup-env-production-base-url')
            .fill('http://auth.example.com');
        await page
            .getByTestId('setup-roles-agent-permission')
            .fill('chat.admin');
        await page.getByTestId('setup-pizzasys-submit').click();
        await expect(
            page.locator('#setup-env-production-base-url-error'),
        ).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-errors');
    });

    test('portal admin step with the sign-in form', async ({
        page,
    }, testInfo) => {
        await page.goto('/setup?step=portal-admin');
        await expectStep(page, 'portal-admin');
        await page.getByTestId('setup-portal-change').click();
        await expect(page.getByTestId('setup-portal-form')).toBeVisible();

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-portal-form');
    });

    test('portal admin step with a refused account', async ({
        page,
    }, testInfo) => {
        await page.goto('/setup?step=portal-admin');
        await expectStep(page, 'portal-admin');
        await page.getByTestId('setup-portal-change').click();

        // A real attempt against the harness: an agent is not good enough. Nothing is stored for a refusal.
        await submitPortalAdmin(page, portalUsers().agent);
        await expect(page.getByTestId('setup-portal-problem')).toHaveAttribute(
            'data-code',
            'not_admin',
        );

        await checkBothThemes(page, testInfo, 'wizard-pizzasys-portal-refused');
    });
});

test.describe(
    'sign-in and Settings > Auth, Auth Portal mode',
    { tag: '@pizzasys' },
    () => {
        test.use({ scenario: 'installed-pizzasys' });

        test('login page', async ({ page }, testInfo) => {
            await page.goto('/login');
            await expect(page.getByTestId('login-portal-hint')).toBeVisible();

            await checkBothThemes(page, testInfo, 'login-portal');
        });

        test('login page with an error', async ({ page }, testInfo) => {
            await page.goto('/login');
            await page.locator('#email').fill('a11y.nobody@test.local');
            await page.locator('#password').fill('wrong-password');
            await page.locator('[data-test="login-button"]').click();
            await expect(
                page.getByText('These credentials do not match our records.'),
            ).toBeVisible();

            await checkBothThemes(page, testInfo, 'login-portal-error');
        });

        test('login page with the no-chat-access notice', async ({
            page,
        }, testInfo) => {
            const { storeUser } = portalUsers();

            await page.goto('/login');
            await page.locator('#email').fill(storeUser.email);
            await page.locator('#password').fill(storeUser.password);
            await page.locator('[data-test="login-button"]').click();
            await expect(
                page.getByTestId('login-no-chat-access'),
            ).toBeVisible();

            await checkBothThemes(
                page,
                testInfo,
                'login-portal-no-chat-access',
            );
        });

        test.describe('as an administrator', () => {
            test.use({ role: 'admin' });

            test('profile settings, managed by the portal', async ({
                page,
            }, testInfo) => {
                await page.goto('/settings/profile');
                await expect(page.getByTestId('profile-managed')).toBeVisible();

                await checkBothThemes(
                    page,
                    testInfo,
                    'settings-profile-portal',
                );
            });

            test('Settings > Auth', async ({ page }, testInfo) => {
                await page.goto('/settings/auth');
                await expect(page.getByTestId('settings-auth')).toBeVisible();
                await expect(
                    page.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', 'ok');

                await checkBothThemes(page, testInfo, 'settings-auth');
            });

            test('Settings > Auth with a tested environment', async ({
                page,
            }, testInfo) => {
                await page.goto('/settings/auth');
                await page
                    .getByTestId('settings-auth-env-testing-test')
                    .click();
                await expect(
                    page.getByTestId('settings-auth-env-testing-result'),
                ).toHaveAttribute('data-ok', 'true');

                await checkBothThemes(page, testInfo, 'settings-auth-tested');
            });

            test('the environment switch dialog', async ({
                page,
            }, testInfo) => {
                await page.goto('/settings/auth');
                await page.getByTestId('settings-auth-switch-open').click();
                await expect(
                    page.getByTestId('settings-auth-switch-dialog'),
                ).toBeVisible();

                await checkBothThemes(
                    page,
                    testInfo,
                    'settings-auth-switch-dialog',
                );
            });
        });
    },
);
