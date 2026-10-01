/**
 * Small driver for the install wizard UI (selectors: docs in the setup components,
 * `data-testid` contract in resources/js/components/setup/*).
 */
import { expect, type Page } from '@playwright/test';
import type { TestUser } from './users';

export type StepKey =
    | 'welcome'
    | 'mode'
    | 'admin'
    | 'pizzasys'
    | 'portal-admin'
    | 'basics'
    | 'run'
    | 'done';

export const RUN_STEPS = [
    'run-migrations',
    'seed-defaults',
    'create-admin',
    'write-lock',
] as const;

/** The installation runs every migration, the seeds and the administrator through the web server: well over 10 s on a loaded machine. */
export const INSTALL_TIMEOUT = 90_000;

/** Wait until the wizard shows `step` (the server picks it; Back/Continue can override it). */
export async function expectStep(
    page: Page,
    step: StepKey,
    timeout?: number,
): Promise<void> {
    await expect(page.getByTestId('setup-wizard')).toHaveAttribute(
        'data-view',
        step,
        { timeout },
    );
    await expect(page.getByTestId(`setup-step-${step}`)).toBeVisible({
        timeout,
    });
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
    await expectStep(page, 'done', INSTALL_TIMEOUT);
}

/** Mode 2: pick the Auth Portal on the mode step and continue to the portal screen. */
export async function choosePizzasysMode(page: Page): Promise<void> {
    await expectStep(page, 'mode');
    await page.getByTestId('setup-mode-option-pizzasys').click();
    await expect(page.locator('#setup-mode-pizzasys')).toBeChecked();
    await page.getByTestId('setup-mode-submit').click();
}

export type EnvKey = 'production' | 'testing';

/** Type the connection details of one portal environment (the token field is write-only). */
export async function fillEnvironment(
    page: Page,
    env: EnvKey,
    values: { baseUrl?: string; serviceName?: string; serviceToken?: string },
): Promise<void> {
    const field = (name: string) =>
        page.getByTestId(`setup-env-${env}-${name}`);

    if (values.baseUrl !== undefined) {
        await field('base-url').fill(values.baseUrl);
    }

    if (values.serviceName !== undefined) {
        await field('service-name').fill(values.serviceName);
    }

    if (values.serviceToken !== undefined) {
        await field('service-token').fill(values.serviceToken);
    }
}

/** Click "Test connection" and wait for the outcome panel to settle. */
export async function testEnvironment(page: Page, env: EnvKey): Promise<void> {
    // The panel may still show the previous verdict: wait for the server's answer to THIS click.
    await Promise.all([
        page.waitForResponse(
            (response) =>
                response.url().endsWith('/setup/pizzasys/test') &&
                response.request().method() === 'POST',
        ),
        page.getByTestId(`setup-env-test-${env}`).click(),
    ]);
    await expect(page.getByTestId(`setup-env-result-${env}`)).toHaveAttribute(
        'data-state',
        'done',
    );
}

/** The portal-admin form: type credentials and submit once. */
export async function submitPortalAdmin(
    page: Page,
    credentials: { email: string; password: string },
): Promise<void> {
    await page.getByTestId('setup-portal-email').fill(credentials.email);
    await page.getByTestId('setup-portal-password').fill(credentials.password);
    await page.getByTestId('setup-portal-submit').click();
}

/** A connection-test answer the wizard can render (see `PortalTestResult` in docs/contracts/auth-pizzasys.md). */
export type CannedTestResult = {
    ok: boolean;
    checks: { key: string; label: string; ok: boolean; message?: string }[];
};

export const PASSED_TEST: CannedTestResult = {
    ok: true,
    checks: [
        { key: 'reachable', label: 'Portal reachable', ok: true },
        {
            key: 'service_credential',
            label: 'Service credential accepted',
            ok: true,
        },
        { key: 'latency', label: 'Response time', ok: true, message: '11 ms' },
        {
            key: 'nats',
            label: 'NATS events',
            ok: true,
            message: 'Not configured (optional).',
        },
    ],
};

export const FAILED_TEST: CannedTestResult = {
    ok: false,
    checks: [
        { key: 'reachable', label: 'Portal reachable', ok: true },
        {
            key: 'service_credential',
            label: 'Service credential accepted',
            ok: false,
            message: 'Invalid service token.',
        },
        { key: 'latency', label: 'Response time', ok: true, message: '12 ms' },
        {
            key: 'nats',
            label: 'NATS events',
            ok: true,
            message: 'Not configured (optional).',
        },
    ],
};

/**
 * Read-only wizard scenarios are shared by several specs, and "Test connection" saves the form first
 * (which would reset the answers the other specs rely on). Answer both requests locally: the save with a
 * redirect back to the wizard, the test with a canned result. Nothing reaches the server.
 */
export async function mockConnectionTest(
    page: Page,
    result: CannedTestResult,
): Promise<void> {
    await page.route('**/setup/pizzasys', async (route) => {
        if (route.request().method() !== 'POST') {
            await route.fallback();

            return;
        }

        await route.fulfill({
            status: 303,
            headers: { Location: '/setup?step=pizzasys' },
        });
    });
    await page.route('**/setup/pizzasys/test', (route) =>
        route.fulfill({ json: result }),
    );
}
