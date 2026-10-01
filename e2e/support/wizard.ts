/**
 * Small driver for the install wizard UI (selectors: docs in the setup components,
 * `data-testid` contract in resources/js/components/setup/*).
 */
import { expect, type Page } from '@playwright/test';
import type { TestUser } from './users';

export type StepKey = 'welcome' | 'mode' | 'admin' | 'basics' | 'run' | 'done';

export const RUN_STEPS = [
    'run-migrations',
    'seed-defaults',
    'create-admin',
    'write-lock',
] as const;

/** Wait until the wizard shows `step` (the server picks it; Back/Continue can override it). */
export async function expectStep(page: Page, step: StepKey): Promise<void> {
    await expect(page.getByTestId('setup-wizard')).toHaveAttribute(
        'data-view',
        step,
    );
    await expect(page.getByTestId(`setup-step-${step}`)).toBeVisible();
}

/** The stepper that is visible for the viewport: the vertical rail on md+, the compact summary below. */
export function visibleStepper(page: Page) {
    const viewport = page.viewportSize();
    const compact = (viewport?.width ?? 1280) < 768;

    return page.getByTestId(
        compact ? 'setup-stepper-compact' : 'setup-stepper',
    );
}

export async function chooseFortifyMode(page: Page): Promise<void> {
    await expectStep(page, 'mode');
    await expect(page.locator('#setup-mode-fortify')).toBeChecked();
    await page.getByTestId('setup-mode-submit').click();
}

export async function fillAdmin(
    page: Page,
    admin: Pick<TestUser, 'name' | 'email' | 'password'>,
    confirmation = admin.password,
): Promise<void> {
    await page.locator('input[name=name]').fill(admin.name);
    await page.locator('input[name=email]').fill(admin.email);
    await page.locator('input[name=password]').fill(admin.password);
    await page.locator('input[name=password_confirmation]').fill(confirmation);
}

export async function submitAdmin(page: Page): Promise<void> {
    await page.getByTestId('setup-admin-submit').click();
}

/** Start the installation and wait for the `done` screen. */
export async function runInstall(page: Page): Promise<void> {
    await page.getByTestId('setup-run-start').click();
    await expectStep(page, 'done');
}
