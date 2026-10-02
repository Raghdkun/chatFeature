/**
 * Playwright e2e configuration (docs/testing.md).
 *
 * - Real Google Chrome (`channel: 'chrome'`), headless; no browser download needed.
 * - Two projects: `desktop` (1280x800) and `mobile` (Pixel 7 profile).
 * - One throwaway Laravel server per scenario (see e2e/support/scenarios.ts). The install wizard
 *   locks itself after the last step, so scenarios cannot be shared between tests that install.
 *   Servers are started and stopped by Playwright only (`webServer`); `e2e/global-setup.ts`
 *   resets their databases and state before the suite and installs the `installed` ones.
 * - Mode 2 (Auth Portal): the scenarios with `auth: 'pizzasys'` talk to the local pizzasys harness
 *   (`../chatFeature.harness`, port 8200), which `e2e/global-setup.ts` starts and stops.
 *   `auth/portal-outage.spec.ts` STOPS that harness mid-test, so it runs alone in the last project
 *   (`pizzasys-outage`), after every other project finished.
 * - P3: scenarios with a `hostPort` also start a static "customer site" on another origin (e2e/support/host-server.mjs).
 * - P4: scenarios with a `reverbPort` also start a real Reverb server (`php artisan reverb:start`) with the instance's environment,
 *   waited for on its `/up` route; the queue stays `sync` (docs/testing.md, "Realtime and the queue").
 * - P6: scenarios with an `openWaPort` also start the stateful OpenWA mock (`node e2e/support/openwa-mock.mjs`, waited for on its `/__mock/health`);
 *   the seed points the app at it (settings `whatsapp.openwa.*`), `e2e/support/openwa.ts` drives it from the specs. Ports 8360-8379.
 * - `E2E_SCREENSHOTS=1` additionally starts the screenshot scenarios and runs
 *   e2e/screenshots/p1.spec.ts, p2.spec.ts and p3.spec.ts (write docs/screenshots/p1|p2|p3/*.png).
 */
import { defineConfig, devices } from '@playwright/test';
import { ACTIVE_INSTANCES } from './e2e/support/scenarios';

const screenshots = process.env.E2E_SCREENSHOTS === '1';
/** Stops the shared pizzasys harness: runs on its own, last. */
const PORTAL_OUTAGE = '**/auth/portal-outage.spec.ts';

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
    // Stop (and shut the servers down cleanly) instead of hanging forever. The whole suite (P1-P4, about 1000 tests on
    // two projects) takes 1-1.5 h on a quiet laptop with four workers; 2.5 h leaves room for a loaded one. The
    // `pizzasys-outage` project depends on `desktop` and `mobile`, so it starts last and its time is inside this budget.
    globalTimeout: 2.5 * 60 * 60_000,
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
            // A project-level `testIgnore` replaces the top-level one: repeat the screenshot rule here.
            testIgnore: [
                PORTAL_OUTAGE,
                ...(screenshots ? [] : ['**/screenshots/**']),
            ],
        },
        {
            name: 'mobile',
            use: { ...devices['Pixel 7'] },
            // One run is enough for the specs that render both viewports themselves.
            testIgnore: ['**/screenshots/**', PORTAL_OUTAGE],
        },
        {
            name: 'pizzasys-outage',
            use: { viewport: { width: 1280, height: 800 } },
            testMatch: PORTAL_OUTAGE,
            dependencies: ['desktop', 'mobile'],
        },
    ],

    webServer: [
        ...ACTIVE_INSTANCES.map((instance) => ({
            // --no-reload lets artisan pass the whole environment on (and honour PHP_CLI_SERVER_WORKERS).
            command: `php artisan serve --no-reload --host=127.0.0.1 --port=${instance.port}`,
            // A static file: answers without booting Laravel, so it works before the instance is prepared.
            url: `${instance.url}/favicon.svg`,
            env: instance.env,
            reuseExistingServer: false,
            timeout: 60_000,
            stdout: 'ignore' as const,
            stderr: 'ignore' as const,
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
        })),
        // The realtime server of the chat specs (one per instance that has a `reverbPort`), next to the app it belongs to.
        ...ACTIVE_INSTANCES.flatMap((instance) =>
            instance.reverb === null
                ? []
                : [
                      {
                          command: `php artisan reverb:start --host=127.0.0.1 --port=${instance.reverb.port}`,
                          // Reverb's own health route: answers once the socket server is accepting connections.
                          url: `${instance.reverb.url}/up`,
                          env: instance.env,
                          reuseExistingServer: false,
                          timeout: 60_000,
                          stdout: 'ignore' as const,
                          stderr: 'ignore' as const,
                          gracefulShutdown: {
                              signal: 'SIGTERM' as const,
                              timeout: 5_000,
                          },
                      },
                  ],
        ),
        // The OpenWA mock of the WhatsApp specs (one per instance that has an `openWa`): the app's HTTP client talks to it, and it delivers
        // its signed webhooks to the app. A short retry back-off keeps the delivery-retry specs fast (the real image waits 5 s, doubling); a start takes
        // 250 ms (the real one 5-25 s) so `initializing` and `qr_ready` are not delivered within milliseconds of each other to parallel PHP workers.
        ...ACTIVE_INSTANCES.flatMap((instance) =>
            instance.openWa === null
                ? []
                : [
                      {
                          command: `node e2e/support/openwa-mock.mjs --port=${instance.openWa.port} --key=${instance.openWa.apiKey} --retry-base-ms=300 --start-delay-ms=250`,
                          url: `${instance.openWa.url}/__mock/health`,
                          reuseExistingServer: false,
                          timeout: 30_000,
                          stdout: 'ignore' as const,
                          stderr: 'ignore' as const,
                          gracefulShutdown: {
                              signal: 'SIGTERM' as const,
                              timeout: 5_000,
                          },
                      },
                  ],
        ),
        // The cross-origin "customer site" of the embed specs (one per instance that has a `hostPort`).
        ...ACTIVE_INSTANCES.filter(
            (instance) => instance.hostPort !== null,
        ).map((instance) => ({
            command: `node e2e/support/host-server.mjs --port=${instance.hostPort} --app=${instance.url}`,
            url: `${instance.hostUrl}/__health`,
            reuseExistingServer: false,
            timeout: 30_000,
            stdout: 'ignore' as const,
            stderr: 'ignore' as const,
            gracefulShutdown: { signal: 'SIGTERM' as const, timeout: 5_000 },
        })),
    ],
});
