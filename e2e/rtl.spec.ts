import { type Page } from '@playwright/test';
import { expectNoHorizontalScroll, settle } from './support/helpers';
import { expect, test } from './support/test';
import { expectStep, type StepKey } from './support/wizard';

/**
 * Right-to-left layout for Arabic (`ar`): <html dir="rtl">, translated UI, the wizard rail and the
 * sidebar on the right, and no sideways scrolling. The Arabic scenarios are started with
 * APP_LOCALE=ar (wizard) and INSTALL_LOCALE=ar (installed app), see e2e/support/scenarios.ts.
 */
const ARABIC = /[؀-ۿ]/;

async function expectRtlDocument(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect
        .poll(() =>
            page.evaluate(() => getComputedStyle(document.body).direction),
        )
        .toBe('rtl');
}

test.describe('install wizard in Arabic', () => {
    test.use({ scenario: 'wizard-views-rtl' });

    const steps: StepKey[] = ['welcome', 'mode', 'admin', 'basics', 'run'];

    for (const step of steps) {
        test(`${step} step renders right-to-left`, async ({ page }) => {
            await page.goto(`/setup?step=${step}`);
            await expectStep(page, step);
            await expectRtlDocument(page);

            await expectNoHorizontalScroll(page);
        });
    }

    test('the translated strings are Arabic (missing ones fall back to English)', async ({
        page,
    }) => {
        // lang/ar.json is a partial seed for now: the welcome and mode screens are fully translated.
        await page.goto('/setup?step=mode');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            'كيف سيسجّل الأشخاص دخولهم؟',
        );
        await expect(page.getByTestId('setup-back')).toContainText('رجوع');

        await page.goto('/setup?step=admin');
        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            'Create the first admin',
        );
    });

    test('the progress rail sits on the right of the card', async ({
        page,
    }) => {
        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto('/setup?step=mode');
        await expectStep(page, 'mode');

        const rail = await page.getByTestId('setup-stepper').boundingBox();
        const content = await page.getByTestId('setup-wizard').boundingBox();

        expect(rail).not.toBeNull();
        expect(content).not.toBeNull();
        expect(rail!.x).toBeGreaterThan(content!.x);
    });

    test('the Back arrow is mirrored', async ({ page }) => {
        await page.goto('/setup?step=basics');
        await expectStep(page, 'basics');

        const transform = await page
            .getByTestId('setup-back')
            .locator('svg')
            .evaluate((svg) => getComputedStyle(svg).rotate);

        expect(transform).toMatch(/180/);
    });

    test('it also fits a phone', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 });

        for (const step of steps) {
            await page.goto(`/setup?step=${step}`);
            await expectStep(page, step);
            await expect(
                page.getByTestId('setup-stepper-compact'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);
        }
    });
});

test.describe('signed-out and signed-in pages in Arabic', () => {
    test.use({ scenario: 'installed-rtl' });

    test('login renders right-to-left', async ({ page }) => {
        await page.goto('/login');
        await expectRtlDocument(page);

        await expect(page.getByRole('heading', { level: 1 })).toHaveText(
            'سجّل الدخول إلى حسابك',
        );
        // Latin text (the email address) keeps working inside the RTL form.
        await page.locator('#email').fill('someone@example.test');
        await expect(page.locator('#email')).toHaveValue(
            'someone@example.test',
        );

        await expectNoHorizontalScroll(page);
    });

    test('login fits a phone', async ({ page }) => {
        await page.setViewportSize({ width: 375, height: 812 });
        await page.goto('/login');
        await expectRtlDocument(page);

        await expectNoHorizontalScroll(page);
    });

    test.describe('admin dashboard', () => {
        test.use({ role: 'admin' });

        test('the sidebar is on the right and the page is translated', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto('/dashboard');
            await expectRtlDocument(page);
            await expect(
                page.getByTestId('dashboard-admin-setup'),
            ).toBeVisible();

            await expect(page.getByTestId('header-role')).toHaveText('مسؤول');
            await expect(page.getByRole('heading', { level: 1 })).toContainText(
                ARABIC,
            );

            const sidebar = page.locator('[data-slot="sidebar"]');
            await expect(sidebar).toHaveAttribute('data-side', 'right');

            const rail = await page
                .locator('[data-sidebar="sidebar"]')
                .first()
                .boundingBox();
            const main = await page
                .getByTestId('dashboard-admin-setup')
                .boundingBox();

            expect(rail).not.toBeNull();
            expect(main).not.toBeNull();
            expect(rail!.x).toBeGreaterThan(main!.x);
            expect(rail!.x + rail!.width).toBeLessThanOrEqual(1280);

            await expectNoHorizontalScroll(page);
        });

        test('on a phone the drawer opens from the right', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 812 });
            await page.goto('/dashboard');
            await expectRtlDocument(page);
            await expectNoHorizontalScroll(page);

            await page
                .getByRole('button', { name: 'Toggle Sidebar' })
                .first()
                .click();

            const drawer = page.getByRole('dialog');
            await expect(drawer).toBeVisible();
            await settle(page);

            const box = await drawer.boundingBox();
            expect(box).not.toBeNull();
            // Flush with the right edge of the screen.
            expect(box!.x + box!.width).toBeGreaterThanOrEqual(374);
            expect(box!.x).toBeGreaterThan(0);
            await expectNoHorizontalScroll(page);
        });

        test('the settings pages do not overflow', async ({ page }) => {
            for (const width of [1280, 375]) {
                await page.setViewportSize({ width, height: 800 });

                for (const path of [
                    '/settings/profile',
                    '/settings/appearance',
                ]) {
                    await page.goto(path);
                    await expectRtlDocument(page);
                    await expectNoHorizontalScroll(page);
                }
            }
        });
    });

    test.describe('agent dashboard', () => {
        test.use({ role: 'agent' });

        test('is right-to-left too', async ({ page }) => {
            await page.goto('/dashboard');
            await expectRtlDocument(page);
            await expect(
                page.getByTestId('dashboard-agent-waiting'),
            ).toBeVisible();
            await expect(page.getByTestId('header-role')).toHaveText(
                'موظف دعم',
            );

            await expectNoHorizontalScroll(page);
        });
    });
});

/**
 * Mode 2 (Auth Portal) in Arabic: <html dir="rtl">, no sideways scrolling on desktop or phone.
 * Needs the local pizzasys harness (docs/testing.md).
 */
test.describe(
    'install wizard in Arabic, Auth Portal mode',
    { tag: '@pizzasys' },
    () => {
        test.use({ scenario: 'wizard-views-pizzasys-rtl' });

        const steps: StepKey[] = [
            'mode',
            'pizzasys',
            'portal-admin',
            'basics',
            'run',
        ];

        for (const step of steps) {
            test(`${step} step renders right-to-left`, async ({ page }) => {
                await page.goto(`/setup?step=${step}`);
                await expectStep(page, step);
                await expectRtlDocument(page);

                await expectNoHorizontalScroll(page);
            });
        }

        test('the portal fields keep addresses and tokens left to right inside the mirrored form', async ({
            page,
        }) => {
            await page.setViewportSize({ width: 1280, height: 800 });
            await page.goto('/setup?step=pizzasys');
            await expectStep(page, 'pizzasys');
            await expectRtlDocument(page);

            for (const testId of [
                'setup-env-production-base-url',
                'setup-env-production-service-name',
                'setup-roles-admin-permission',
            ]) {
                await expect(page.getByTestId(testId), testId).toHaveAttribute(
                    'dir',
                    'ltr',
                );
            }

            // The progress rail sits on the right of the card.
            const rail = await page.getByTestId('setup-stepper').boundingBox();
            const content = await page
                .getByTestId('setup-wizard')
                .boundingBox();
            expect(rail!.x).toBeGreaterThan(content!.x);

            await page.getByTestId('setup-env-testing-toggle').click();
            await expect(
                page.getByTestId('setup-env-testing-base-url'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);
        });

        test('it also fits a phone', async ({ page }) => {
            await page.setViewportSize({ width: 375, height: 812 });

            for (const step of steps) {
                await page.goto(`/setup?step=${step}`);
                await expectStep(page, step);
                await expect(
                    page.getByTestId('setup-stepper-compact'),
                ).toBeVisible();
                await expectNoHorizontalScroll(page);
            }
        });
    },
);

test.describe(
    'sign-in and Settings > Auth in Arabic, Auth Portal mode',
    { tag: '@pizzasys' },
    () => {
        test.use({ scenario: 'installed-pizzasys-rtl' });

        test('the portal login renders right-to-left on desktop and phone', async ({
            page,
        }) => {
            for (const width of [1280, 375]) {
                await page.setViewportSize({ width, height: 800 });
                await page.goto('/login');
                await expectRtlDocument(page);
                await expect(
                    page.getByTestId('login-portal-hint'),
                ).toBeVisible();

                // The email address stays readable inside the RTL form.
                await page.locator('#email').fill('someone@example.test');
                await expect(page.locator('#email')).toHaveValue(
                    'someone@example.test',
                );
                await expectNoHorizontalScroll(page);
            }
        });

        test.describe('as an administrator', () => {
            test.use({ role: 'admin' });

            test('Settings > Auth is mirrored and does not overflow', async ({
                page,
            }) => {
                for (const width of [1280, 375]) {
                    await page.setViewportSize({ width, height: 800 });
                    await page.goto('/settings/auth');
                    await expectRtlDocument(page);
                    await expect(
                        page.getByTestId('settings-auth'),
                    ).toBeVisible();
                    await expect(
                        page.getByTestId('settings-auth-health'),
                    ).toBeVisible();

                    // The portal's technical values read left to right.
                    await expect(
                        page.getByTestId(
                            'settings-auth-env-production-base-url',
                        ),
                    ).toHaveAttribute('dir', 'ltr');
                    await expectNoHorizontalScroll(page);
                }
            });

            test('the environment switch dialog fits a phone in Arabic', async ({
                page,
            }) => {
                await page.setViewportSize({ width: 375, height: 812 });
                await page.goto('/settings/auth');
                await expectRtlDocument(page);

                await page.getByTestId('settings-auth-switch-open').click();
                const dialog = page.getByTestId('settings-auth-switch-dialog');
                await expect(dialog).toBeVisible();
                await settle(page);

                const box = await dialog.boundingBox();
                expect(box!.x).toBeGreaterThanOrEqual(0);
                expect(box!.x + box!.width).toBeLessThanOrEqual(375);
                await expectNoHorizontalScroll(page);
            });
        });
    },
);
