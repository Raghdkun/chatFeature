import { expectNoHorizontalScroll } from './support/helpers';
import { expect, test } from './support/test';
import { portalUsers } from './support/users';
import {
    expectStep,
    FAILED_TEST,
    mockConnectionTest,
    PASSED_TEST,
    submitPortalAdmin,
    type StepKey,
} from './support/wizard';

/**
 * Phone layout at 375px (iPhone SE / small Android): nothing scrolls sideways and the wizard
 * swaps its vertical rail for the compact "Step n of m" summary.
 */
test.use({ viewport: { width: 375, height: 812 } });

test.describe('install wizard at 375px', () => {
    test.use({ scenario: 'wizard-views' });

    const steps: StepKey[] = ['welcome', 'mode', 'admin', 'basics', 'run'];

    for (const step of steps) {
        test(`${step} step fits and shows the compact stepper`, async ({
            page,
        }) => {
            await page.goto(`/setup?step=${step}`);
            await expectStep(page, step);

            await expect(
                page.getByTestId('setup-stepper-compact'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-stepper-compact'),
            ).toHaveAttribute('data-step', step);
            await expect(
                page.getByTestId('setup-stepper-compact'),
            ).toContainText(/Step \d of 6/);
            await expect(page.getByTestId('setup-stepper')).toBeHidden();

            await expectNoHorizontalScroll(page);

            // The primary action is reachable without sideways scrolling.
            const action = page
                .locator(
                    '[data-testid="setup-welcome-continue"], [data-testid$="-submit"], [data-testid="setup-run-start"]',
                )
                .first();
            await action.scrollIntoViewIfNeeded();
            const box = await action.boundingBox();
            expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
            expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(375);
        });
    }

    test('validation errors do not break the layout', async ({ page }) => {
        await page.goto('/setup?step=admin');
        await page.locator('input[name=password]').fill('short');
        await page.locator('input[name=password_confirmation]').fill('other');
        await page.getByTestId('setup-admin-submit').click();
        await expect(page.locator('#setup-admin-password-error')).toBeVisible();

        await expectNoHorizontalScroll(page);
    });
});

test.describe('install wizard behind the setup token at 375px', () => {
    test.use({ scenario: 'fresh-token' });

    test('the token form fits', async ({ page }) => {
        await page.goto('/setup');
        await expectStep(page, 'welcome');
        await expect(page.getByTestId('setup-stepper-compact')).toBeVisible();

        await expectNoHorizontalScroll(page);
    });
});

test.describe('sign-in pages at 375px', () => {
    test.use({ scenario: 'installed' });

    test('login fits', async ({ page }) => {
        await page.goto('/login');
        await expect(page.locator('#email')).toBeVisible();

        await expectNoHorizontalScroll(page);
    });

    test('login with an error fits', async ({ page }) => {
        await page.goto('/login');
        await page.locator('#email').fill('nobody@example.test');
        await page.locator('#password').fill('wrong-password');
        await page.locator('[data-test="login-button"]').click();
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();

        await expectNoHorizontalScroll(page);
    });
});

test.describe('dashboards at 375px', () => {
    test.use({ scenario: 'installed' });

    test.describe('admin', () => {
        test.use({ role: 'admin' });

        test('dashboard fits and the sidebar opens as a drawer', async ({
            page,
        }) => {
            await page.goto('/dashboard');
            await expect(
                page.getByTestId('dashboard-admin-setup'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);

            // Off-canvas navigation instead of a permanent sidebar.
            await expect(page.getByRole('dialog')).toHaveCount(0);
            await page
                .getByRole('button', { name: 'Toggle Sidebar' })
                .first()
                .click();

            const drawer = page.getByRole('dialog');
            await expect(drawer).toBeVisible();
            await expect(drawer.getByText('Dashboard')).toBeVisible();
            await expectNoHorizontalScroll(page);
        });

        test('settings fit', async ({ page }) => {
            for (const path of ['/settings/profile', '/settings/appearance']) {
                await page.goto(path);
                await expect(
                    page.getByRole('heading', { level: 1 }),
                ).toBeAttached();
                await expectNoHorizontalScroll(page);
            }
        });
    });

    test.describe('agent', () => {
        test.use({ role: 'agent' });

        test('dashboard fits', async ({ page }) => {
            await page.goto('/dashboard');
            await expect(
                page.getByTestId('dashboard-agent-waiting'),
            ).toBeVisible();
            await expect(
                page.getByTestId('dashboard-availability-switch'),
            ).toBeVisible();

            await expectNoHorizontalScroll(page);
        });
    });
});

/** Mode 2 (Auth Portal) screens at 375px; they need the local pizzasys harness (docs/testing.md). */
test.describe(
    'install wizard, Auth Portal mode, at 375px',
    { tag: '@pizzasys' },
    () => {
        test.use({ scenario: 'wizard-views-pizzasys' });

        for (const step of [
            'mode',
            'pizzasys',
            'portal-admin',
            'basics',
            'run',
        ] as StepKey[]) {
            test(`${step} step fits and shows the compact stepper`, async ({
                page,
            }) => {
                await page.goto(`/setup?step=${step}`);
                await expectStep(page, step);

                const compact = page.getByTestId('setup-stepper-compact');
                await expect(compact).toBeVisible();
                await expect(compact).toHaveAttribute('data-step', step);
                await expect(compact).toContainText(/Step \d of 7/);
                await expect(page.getByTestId('setup-stepper')).toBeHidden();
                await expectNoHorizontalScroll(page);

                // The primary action is reachable without sideways scrolling.
                const action = page
                    .locator(
                        '[data-testid="setup-portal-continue"], [data-testid$="-submit"], [data-testid="setup-run-start"]',
                    )
                    .first();
                await action.scrollIntoViewIfNeeded();
                const box = await action.boundingBox();
                expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
                expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(
                    375,
                );
            });
        }

        test('the portal step with Testing open and a failed test does not break the layout', async ({
            page,
        }) => {
            await mockConnectionTest(page, FAILED_TEST);
            await page.goto('/setup?step=pizzasys');
            await expectStep(page, 'pizzasys');

            await page.getByTestId('setup-env-testing-toggle').click();
            await expect(
                page.getByTestId('setup-env-testing-base-url'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);

            await page.getByTestId('setup-env-test-production').click();
            await expect(
                page.getByTestId('setup-env-result-production'),
            ).toHaveAttribute('data-ok', 'false');
            await expectNoHorizontalScroll(page);

            await mockConnectionTest(page, PASSED_TEST);
            await page.getByTestId('setup-env-test-production').click();
            await expect(
                page.getByTestId('setup-env-result-production'),
            ).toHaveAttribute('data-ok', 'true');
            await expectNoHorizontalScroll(page);
        });

        test('long input and validation errors do not break the layout', async ({
            page,
        }) => {
            await page.goto('/setup?step=pizzasys');
            await expectStep(page, 'pizzasys');

            await page
                .getByTestId('setup-env-production-base-url')
                .fill(
                    `http://${'a-very-long-portal-host-name.'.repeat(6)}example.com`,
                );
            await page
                .getByTestId('setup-roles-agent-permission')
                .fill('chat.admin');
            await page.getByTestId('setup-pizzasys-submit').click();
            await expect(
                page.locator('#setup-env-production-base-url-error'),
            ).toBeVisible();

            await expectNoHorizontalScroll(page);
        });

        test('the refused portal account does not break the layout', async ({
            page,
        }) => {
            await page.goto('/setup?step=portal-admin');
            await expectStep(page, 'portal-admin');
            await page.getByTestId('setup-portal-change').click();

            await submitPortalAdmin(page, portalUsers().noRole);
            await expect(
                page.getByTestId('setup-portal-problem'),
            ).toHaveAttribute('data-code', 'no_chat_access');

            await expectNoHorizontalScroll(page);
        });
    },
);

test.describe(
    'sign-in and Settings > Auth, Auth Portal mode, at 375px',
    { tag: '@pizzasys' },
    () => {
        test.use({ scenario: 'installed-pizzasys' });

        test('the portal login fits, with and without an error', async ({
            page,
        }) => {
            await page.goto('/login');
            await expect(page.getByTestId('login-portal-hint')).toBeVisible();
            await expectNoHorizontalScroll(page);

            await page.locator('#email').fill('responsive.nobody@test.local');
            await page.locator('#password').fill('wrong-password');
            await page.locator('[data-test="login-button"]').click();
            await expect(
                page.getByText('These credentials do not match our records.'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);
        });

        test.describe('as an administrator', () => {
            test.use({ role: 'admin' });

            test('Settings > Auth fits, and so does the environment switch dialog', async ({
                page,
            }) => {
                await page.goto('/settings/auth');
                await expect(page.getByTestId('settings-auth')).toBeVisible();
                await expectNoHorizontalScroll(page);

                // Every card is as wide as the screen allows, never wider.
                for (const testId of [
                    'settings-auth-health',
                    'settings-auth-switch',
                    'settings-auth-env-production',
                    'settings-auth-env-testing',
                    'settings-auth-roles',
                ]) {
                    const box = await page.getByTestId(testId).boundingBox();

                    expect(box, testId).not.toBeNull();
                    expect(box!.x, testId).toBeGreaterThanOrEqual(0);
                    expect(box!.x + box!.width, testId).toBeLessThanOrEqual(
                        375,
                    );
                }

                await page.getByTestId('settings-auth-switch-open').click();
                const dialog = page.getByTestId('settings-auth-switch-dialog');
                await expect(dialog).toBeVisible();
                await expectNoHorizontalScroll(page);

                const box = await dialog.boundingBox();
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(375);

                // The submit button stays reachable inside the dialog (it scrolls, the page does not).
                await page
                    .getByTestId('settings-auth-switch-submit')
                    .scrollIntoViewIfNeeded();
                await expect(
                    page.getByTestId('settings-auth-switch-submit'),
                ).toBeVisible();
            });
        });
    },
);
