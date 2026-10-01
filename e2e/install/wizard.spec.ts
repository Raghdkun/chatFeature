import { existsSync, readFileSync } from 'node:fs';
import {
    expectNoHorizontalScroll,
    expectNoSeriousA11yViolations,
    setTheme,
} from '../support/helpers';
import { expect, test } from '../support/test';
import { ADMIN } from '../support/users';
import {
    chooseFortifyMode,
    expectStep,
    fillAdmin,
    INSTALL_TIMEOUT,
    RUN_STEPS,
    submitAdmin,
    visibleStepper,
} from '../support/wizard';

/**
 * The complete first-run experience on an empty database (APP_ENV=local, so no setup token):
 * environment check, sign-in method, first admin, app basics, install, sign in, dashboard.
 *
 * It is ONE test with steps on purpose: the wizard locks itself at the end, so the steps share
 * one server state and must run in order (and never be retried half way: retries = 0).
 */
test.use({ scenario: 'fresh-local' });
test.describe.configure({ retries: 0 });

test('walks the whole wizard, installs, signs in and locks the wizard', async ({
    page,
    request,
    instance,
}, testInfo) => {
    test.setTimeout(180_000);

    const wizard = page.getByTestId('setup-wizard');
    let loginGateRelease: () => void = () => undefined;

    await test.step('starts at the mode step because the environment is healthy', async () => {
        await page.goto('/');
        await expect(page).toHaveURL(/\/setup$/);
        await expectStep(page, 'mode');
        await expect(page).toHaveTitle(/Installation/);
        await expect(visibleStepper(page)).toBeVisible();

        // There is no token step in APP_ENV=local.
        await expect(page.getByTestId('setup-token')).toHaveCount(0);
        await expectNoHorizontalScroll(page);
    });

    await test.step('Back shows the environment checks, all green', async () => {
        await page.getByTestId('setup-back').click();
        await expectStep(page, 'welcome');

        await expect(page.getByTestId('setup-environment')).toHaveAttribute(
            'data-ok',
            'true',
        );
        await expect(page.getByTestId('setup-env-summary')).toContainText(
            'Everything this server needs is in place',
        );

        const checks = page.locator('[data-testid^="setup-env-check-"]');
        expect(await checks.count()).toBeGreaterThanOrEqual(10);

        for (const key of [
            'php_version',
            'ext_pdo',
            'ext_pdo_driver',
            'ext_mbstring',
            'ext_openssl',
            'ext_fileinfo',
            'ext_image',
            'ext_intl',
            'storage_writable',
            'app_key',
            'database',
        ]) {
            await expect(
                page.getByTestId(`setup-env-check-${key}`),
                key,
            ).toHaveAttribute('data-ok', 'true');
        }

        // The database check names the dedicated e2e database (details are visible: no token needed here).
        await expect(
            page.getByTestId('setup-env-check-database'),
        ).toContainText(instance.database);

        // "Check again" re-runs the checks without leaving the screen.
        await page.getByTestId('setup-env-retry').click();
        await expect(page.getByTestId('setup-env-retry')).toBeEnabled();
        await expect(page.getByTestId('setup-environment')).toHaveAttribute(
            'data-ok',
            'true',
        );

        await page.getByTestId('setup-welcome-continue').click();
        await expectStep(page, 'mode');
    });

    await test.step('mode: starter-kit auth is preselected, the Auth Portal is selectable and leads to its own screen', async () => {
        await expect(page.locator('#setup-mode-fortify')).toBeEnabled();
        await expect(page.locator('#setup-mode-fortify')).toBeChecked();
        await expect(page.locator('#setup-mode-pizzasys')).toBeEnabled();
        await expect(page.locator('#setup-mode-pizzasys')).not.toBeChecked();
        // Mode 2 exists since P2: no "Coming soon" badge on either option.
        await expect(page.getByTestId('setup-mode-badge-pizzasys')).toHaveCount(
            0,
        );
        await expect(page.getByTestId('setup-mode-badge-fortify')).toHaveCount(
            0,
        );
        await expect(
            page.getByTestId('setup-mode-option-pizzasys'),
        ).toHaveAttribute('data-disabled', 'false');

        // Choosing the Auth Portal routes to the portal screen (the full mode-2 flow: wizard-pizzasys.spec.ts) ...
        await page.getByTestId('setup-mode-option-pizzasys').click();
        await expect(page.locator('#setup-mode-pizzasys')).toBeChecked();
        await page.getByTestId('setup-mode-submit').click();
        await expectStep(page, 'pizzasys');

        // ... and Back with the starter kit returns to the mode-1 flow below.
        await page.getByTestId('setup-back').click();
        await expectStep(page, 'mode');
        await expect(page.locator('#setup-mode-pizzasys')).toBeChecked();
        await page.getByTestId('setup-mode-option-fortify').click();

        await chooseFortifyMode(page);
        await expectStep(page, 'admin');
    });

    await test.step('admin: a short password is rejected by the server', async () => {
        await fillAdmin(page, { ...ADMIN, password: 'short' });
        await submitAdmin(page);

        // Still on the admin step, with the error next to the field.
        await expectStep(page, 'admin');
        await expect(page.locator('#setup-admin-password-error')).toContainText(
            /at least 8 characters/i,
        );
        await expect(page.locator('input[name=password]')).toHaveAttribute(
            'aria-invalid',
            'true',
        );
        // What was typed (except passwords) is kept so nobody has to start over.
        await expect(page.locator('input[name=name]')).toHaveValue(ADMIN.name);
        await expect(page.locator('input[name=email]')).toHaveValue(
            ADMIN.email,
        );
        await expectNoHorizontalScroll(page);
    });

    await test.step('admin: a mismatched confirmation is rejected too', async () => {
        await fillAdmin(page, ADMIN, `${ADMIN.password}-different`);
        await submitAdmin(page);

        await expectStep(page, 'admin');
        await expect(page.locator('#setup-admin-password-error')).toContainText(
            /confirmation does not match/i,
        );
    });

    await test.step('admin: a valid admin moves on to the basics', async () => {
        await fillAdmin(page, ADMIN);
        await submitAdmin(page);
        await expectStep(page, 'basics');
    });

    await test.step('basics: sensible defaults and the supported locales', async () => {
        await expect(page.locator('input[name=app_name]')).toHaveValue(
            'PNE Chat',
        );
        await expect(page.locator('input[name=app_url]')).toHaveValue(
            instance.url,
        );
        await expect(page.locator('select[name=locale]')).toHaveValue('en');
        await expect(page.locator('select[name=timezone]')).toHaveValue('UTC');
        await expect(
            page.locator('input[name=idle_timeout_minutes]'),
        ).toHaveValue('120');

        const locales = await page
            .locator('select[name=locale] option')
            .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
            );
        expect(locales).toEqual(['ar', 'en']);

        const zones = await page
            .locator('select[name=timezone] option')
            .evaluateAll((options) =>
                options.map((option) => (option as HTMLOptionElement).value),
            );
        expect(zones).toContain('Europe/Berlin');
        expect(zones).toContain('Asia/Riyadh');

        // An out-of-range idle timeout is flagged before anything is sent.
        await page.locator('input[name=idle_timeout_minutes]').fill('0');
        await expect(page.locator('#setup-idle-timeout-error')).toContainText(
            /whole number from \d+ to \d+/i,
        );
        await expect(
            page.locator('input[name=idle_timeout_minutes]'),
        ).toHaveAttribute('aria-invalid', 'true');
    });

    await test.step('basics: the server only accepts http(s) URLs', async () => {
        await page.locator('input[name=idle_timeout_minutes]').fill('90');
        // A valid URL for the browser, but not for the server (http/https only).
        await page
            .locator('input[name=app_url]')
            .fill('ftp://chat.example.com');
        await page.getByTestId('setup-basics-submit').click();

        await expectStep(page, 'basics');
        await expect(page.locator('input[name=app_url]')).toHaveAttribute(
            'aria-invalid',
            'true',
        );
        await expect(page.locator('#setup-app-url-error')).toBeVisible();
    });

    await test.step('a reload in the middle of the wizard resumes at the same step', async () => {
        await page.reload();
        await expectStep(page, 'basics');
    });

    await test.step('Back returns to the admin step with the earlier answers, then forward again', async () => {
        await page.getByTestId('setup-back').click();
        await expectStep(page, 'admin');
        await expect(page.locator('input[name=name]')).toHaveValue(ADMIN.name);
        await expect(page.locator('input[name=email]')).toHaveValue(
            ADMIN.email,
        );
        // The password is never sent back to the browser.
        await expect(page.locator('input[name=password]')).toHaveValue('');

        await fillAdmin(page, ADMIN);
        await submitAdmin(page);
        await expectStep(page, 'basics');
    });

    await test.step('basics: saving moves on to the install step', async () => {
        await page.locator('input[name=app_url]').fill(instance.url);
        await page.locator('input[name=idle_timeout_minutes]').fill('90');
        await page.getByTestId('setup-basics-submit').click();
        await expectStep(page, 'run');

        const summary = page.getByTestId('setup-run-summary');
        await expect(summary).toContainText('Starter kit auth');
        await expect(summary).toContainText(ADMIN.name);
        await expect(summary).toContainText(ADMIN.email);
        await expect(summary).toContainText(instance.url);
        await expect(summary).not.toContainText(ADMIN.password);

        await expectNoHorizontalScroll(page);
    });

    await test.step('install: the four steps go from waiting to done', async () => {
        await page.reload();
        await expectStep(page, 'run');

        const progress = page.getByTestId('setup-run-progress');
        await expect(progress).toHaveAttribute('data-phase', 'idle');

        for (const key of RUN_STEPS) {
            await expect(
                page.getByTestId(`setup-run-row-${key}`),
            ).toHaveAttribute('data-status', 'pending');
        }

        // Hold the first request so the "running" state can be observed deterministically.
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        await page.route('**/setup/run/run-migrations', async (route) => {
            await gate;
            await route.continue();
        });

        await page.getByTestId('setup-run-start').click();

        await expect(progress).toHaveAttribute('data-phase', 'running');
        await expect(
            page.getByTestId('setup-run-row-run-migrations'),
        ).toHaveAttribute('data-status', 'running');
        await expect(
            page.getByTestId('setup-run-row-seed-defaults'),
        ).toHaveAttribute('data-status', 'pending');
        await expect(page.getByTestId('setup-run-live')).toContainText(
            'Running: Create the database tables',
        );

        // The success screen moves on to /login by itself after a moment; keep the page where it is
        // (the navigation stays pending) while it is being inspected.
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
        loginGateRelease = releaseLogin;

        release();
        await page.unroute('**/setup/run/run-migrations');

        await expectStep(page, 'done', INSTALL_TIMEOUT);
    });

    await test.step('done: success screen, accessible in both themes, then on to sign-in', async () => {
        await expect(page.getByTestId('setup-done-login')).toHaveAttribute(
            'href',
            '/login',
        );
        await expect(page.getByTestId('setup-done-redirecting')).toBeVisible();
        await expectNoHorizontalScroll(page);

        await expectNoSeriousA11yViolations(
            page,
            testInfo,
            'wizard-done-light',
        );
        await setTheme(page, 'dark');
        await expectNoSeriousA11yViolations(page, testInfo, 'wizard-done-dark');
        await setTheme(page, 'light');

        // Let the automatic redirect through.
        loginGateRelease();
        await expect(page).toHaveURL(/\/login$/);
        await expect(wizard).toHaveCount(0);
    });

    await test.step('signs in as the new admin and lands on the dashboard', async () => {
        await page.locator('#email').fill(ADMIN.email);
        await page.locator('#password').fill(ADMIN.password);
        await page.locator('[data-test="login-button"]').click();

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText(
            'Administrator',
        );
        await expect(page.getByTestId('dashboard-admin-setup')).toBeVisible();

        for (const key of ['category', 'widget', 'agents', 'embed']) {
            await expect(
                page.getByTestId(`dashboard-admin-step-${key}`),
            ).toBeVisible();
        }

        await expect(page.getByTestId('dashboard-queue')).toBeVisible();
        await expect(page.getByTestId('dashboard-agent-waiting')).toHaveCount(
            0,
        );
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
            `Welcome back, ${ADMIN.name.split(' ')[0]}`,
        );
    });

    await test.step('the wizard is gone for good', async () => {
        const html = await request.get('/setup');
        expect(html.status()).toBe(404);

        const state = await request.get('/setup/state', {
            headers: { Accept: 'application/json' },
        });
        expect(state.status()).toBe(404);
        expect(await state.json()).toEqual({ status: 'installed' });

        const stateHtml = await request.get('/setup/state');
        expect(stateHtml.status()).toBe(404);

        // The run endpoint (called with the page's XSRF token) answers with the "installed" marker.
        const run = await page.evaluate(async () => {
            const cookie = document.cookie
                .split('; ')
                .find((entry) => entry.startsWith('XSRF-TOKEN='));
            const response = await fetch('/setup/run/write-lock', {
                method: 'POST',
                headers: {
                    Accept: 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(
                        cookie?.split('=')[1] ?? '',
                    ),
                },
            });

            return { status: response.status, body: await response.json() };
        });
        expect(run).toEqual({ status: 404, body: { status: 'installed' } });

        // `/` now means "the dashboard" for a signed-in user.
        await page.goto('/');
        await expect(page).toHaveURL(/\/dashboard$/);

        await page.goto('/setup');
        await expect(page.getByTestId('setup-wizard')).toHaveCount(0);
    });

    await test.step('the lock file exists and no secret was left behind in the state', async () => {
        const lockPath = `${instance.stateDir}/installed.lock`;
        expect(existsSync(lockPath), 'installed.lock').toBe(true);

        const lock = JSON.parse(readFileSync(lockPath, 'utf8')) as {
            mode: string;
            installed_at: string;
        };
        expect(lock.mode).toBe('fortify');
        expect(Date.parse(lock.installed_at)).not.toBeNaN();

        const statePath = `${instance.stateDir}/install-state.json`;

        if (existsSync(statePath)) {
            const raw = readFileSync(statePath, 'utf8');

            expect(raw).not.toContain(ADMIN.password);
            expect(raw).not.toContain('$2y$');
        }
    });
});
