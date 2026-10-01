/**
 * Playwright e2e configuration (docs/testing.md).
 *
 * - Real Google Chrome (`channel: 'chrome'`), headless; no browser download needed.
 * - Two projects: `desktop` (1280x800) and `mobile` (Pixel 7 profile).
 * - One throwaway Laravel server per scenario (see e2e/support/scenarios.ts). The install wizard
 *   locks itself after the last step, so scenarios cannot be shared between tests that install.
 *   Servers are started and stopped by Playwright only (`webServer`); `e2e/global-setup.ts`
 *   resets their databases and state before the suite and installs the `installed` ones.
 * - `E2E_SCREENSHOTS=1` additionally starts the screenshot scenarios and runs
 *   e2e/screenshots/p1.spec.ts (writes docs/screenshots/p1/*.png).
 */
import { defineConfig, devices } from '@playwright/test';
import { ACTIVE_INSTANCES } from './e2e/support/scenarios';

const screenshots = process.env.E2E_SCREENSHOTS === '1';

export default defineConfig({
    testDir: './e2e',
    testMatch: '**/*.spec.ts',
    // The screenshot spec only runs on request (it rewrites files under docs/).
    testIgnore: screenshots ? [] : ['**/screenshots/**'],
    globalSetup: './e2e/global-setup.ts',

    // Tests inside a file run in order; files run in parallel (each scenario has its own server).
    fullyParallel: false,
    workers: process.env.CI ? 2 : 4,
    retries: 1,
    // Stop (and shut the servers down cleanly) instead of hanging forever.
    globalTimeout: 15 * 60_000,
    timeout: 60_000,
    expect: { timeout: 10_000 },
    forbidOnly: !!process.env.CI,
    reporter: process.env.CI
        ? [['github'], ['html', { open: 'never' }]]
        : [['list'], ['html', { open: 'never' }]],

    use: {
        channel: 'chrome',
        headless: true,
        trace: 'retain-on-failure',
        screenshot: 'only-on-failure',
        // `data-testid` is the contract with the frontend; the login button is `data-test`.
        testIdAttribute: 'data-testid',
    },

    projects: [
        {
            name: 'desktop',
            use: { viewport: { width: 1280, height: 800 } },
        },
        {
            name: 'mobile',
            use: { ...devices['Pixel 7'] },
            // One run is enough for the spec that renders both viewports itself.
            testIgnore: ['**/screenshots/**'],
        },
    ],

    webServer: ACTIVE_INSTANCES.map((instance) => ({
        // --no-reload lets artisan pass the whole environment on (and honour PHP_CLI_SERVER_WORKERS).
        command: `php artisan serve --no-reload --host=127.0.0.1 --port=${instance.port}`,
        // A static file: answers without booting Laravel, so it works before the instance is prepared.
        url: `${instance.url}/favicon.svg`,
        env: instance.env,
        reuseExistingServer: false,
        timeout: 60_000,
        stdout: 'ignore',
        stderr: 'ignore',
        gracefulShutdown: { signal: 'SIGTERM', timeout: 5_000 },
    })),
});
