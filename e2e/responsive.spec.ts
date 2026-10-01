import { expectNoHorizontalScroll } from './support/helpers';
import { expect, test } from './support/test';
import { expectStep, type StepKey } from './support/wizard';

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
