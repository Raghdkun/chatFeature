import {
    expectNoHorizontalScroll,
    expectNoSeriousA11yViolations,
    setTheme,
} from '../support/helpers';
import { harnessIsUp, startHarness, stopHarness } from '../support/harness';
import { tinker } from '../support/artisan';
import {
    flushVerifiedIdentities,
    resetCircuitBreaker,
    signIn,
} from '../support/portal';
import { expect, test } from '../support/test';
import { portalUsers } from '../support/users';

/**
 * The Auth Portal goes away in the middle of a session. This is the only spec that STOPS the shared
 * pizzasys harness, which is why it runs on its own, last (the `pizzasys-outage` project of
 * playwright.config.ts) and always starts the harness again.
 *
 *   - people who are signed in keep working inside the grace window (the portal is only needed to
 *     re-verify them);
 *   - beyond the grace window the app answers a friendly 503 page but KEEPS the session;
 *   - a new sign-in says the Auth Portal is unreachable (not "wrong password");
 *   - Settings > Auth shows the portal as down or degraded;
 *   - when the portal is back, the same session works again without signing in, and so do new logins.
 */
test.use({ scenario: 'installed-pizzasys' });
test.describe.configure({ mode: 'serial', retries: 0 });

const users = portalUsers();

test.afterAll(async () => {
    if (!(await harnessIsUp())) {
        await startHarness();
    }
});

test(
    'a portal outage degrades gracefully and recovers without anyone signing in again',
    { tag: '@pizzasys' },
    async ({ page, browser, instance }, testInfo) => {
        test.setTimeout(240_000);

        // Nothing of an earlier run may influence the circuit breaker.
        await resetCircuitBreaker(instance);

        // A fresh, signed-out browser for the "new sign-in" attempts (`browser.newContext()` inherits no session here).
        const guest = await browser.newContext({
            baseURL: instance.url,
            storageState: { cookies: [], origins: [] },
            viewport: page.viewportSize() ?? undefined,
        });

        try {
            const guestPage = await guest.newPage();

            await test.step('an administrator is signed in and the portal is healthy', async () => {
                await signIn(page, users.admin);
                await expect(page).toHaveURL(/\/dashboard$/);
                await expect(page.getByTestId('header-role')).toHaveText(
                    'Administrator',
                );

                await page.goto('/settings/auth');
                await expect(
                    page.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', 'ok');
            });

            await test.step('the portal stops; the signed-in administrator keeps working', async () => {
                await stopHarness();
                expect(await harnessIsUp()).toBe(false);

                // What a NATS "something changed" event does: the next request re-verifies against the (dead) portal.
                await flushVerifiedIdentities(instance);

                await page.goto('/dashboard');
                await expect(page).toHaveURL(/\/dashboard$/);
                await expect(page.getByTestId('header-role')).toHaveText(
                    'Administrator',
                );
                await expect(
                    page.getByTestId('dashboard-admin-setup'),
                ).toBeVisible();

                // The health card tells the administrator what is going on.
                await page.goto('/settings/auth');
                await expect(
                    page.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', /^(degraded|down)$/);
                await expect(
                    page.getByTestId('settings-auth-health-status'),
                ).toHaveText(/Degraded|Down/);
            });

            await test.step('a new sign-in says the Auth Portal is unreachable, not that the password is wrong', async () => {
                await signIn(guestPage, users.chatAdmin);

                await expect(guestPage).toHaveURL(/\/login$/);
                const notice = guestPage.getByTestId(
                    'login-portal-unavailable',
                );

                await expect(notice).toBeVisible();
                await expect(notice).toContainText('Auth Portal unreachable');
                await expect(
                    guestPage.getByText(
                        'These credentials do not match our records.',
                    ),
                ).toHaveCount(0);
                await expect(
                    guestPage.getByTestId('login-no-chat-access'),
                ).toHaveCount(0);
                await expect(
                    guestPage.getByTestId('login-portal-hint'),
                ).toBeVisible();
                await expectNoHorizontalScroll(guestPage);

                // The notice is accessible in both themes.
                await expectNoSeriousA11yViolations(
                    guestPage,
                    testInfo,
                    'login-portal-unavailable-light',
                );
                await setTheme(guestPage, 'dark');
                await expectNoSeriousA11yViolations(
                    guestPage,
                    testInfo,
                    'login-portal-unavailable-dark',
                );
                await setTheme(guestPage, 'light');

                // Still signed out, of course.
                await guestPage.goto('/dashboard');
                await expect(guestPage).toHaveURL(/\/login$/);
            });

            await test.step('repeated failures open the circuit breaker and the portal shows as down', async () => {
                // Five transport failures within 30 s pause every call to the portal (one account per attempt: our own
                // login throttle counts per email).
                for (const account of [
                    users.agent,
                    users.roleAgent,
                    users.noRole,
                    users.storeUser,
                    users.chatAdmin,
                ]) {
                    await signIn(guestPage, account);
                    await expect(
                        guestPage.getByTestId('login-portal-unavailable'),
                    ).toBeVisible();
                }

                await page.goto('/settings/auth');
                await expect(
                    page.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', 'down');
                await expect(
                    page.getByTestId('settings-auth-health-status'),
                ).toHaveText('Down');
                await expect(
                    page.getByTestId('settings-auth-health-circuit'),
                ).toContainText('Open');
            });

            await test.step('beyond the grace window the app answers a friendly 503 and keeps the session', async () => {
                // The last successful check of every portal session is older than the 30 minute grace window.
                await tinker(
                    instance,
                    `\\App\\Models\\ExternalSession::query()->update(['last_verified_at' => now()->subMinutes(45)]);`,
                );

                const response = await page.goto('/dashboard');

                expect(response?.status()).toBe(503);
                expect(response?.headers()['retry-after']).toBeDefined();
                await expect(
                    page
                        .getByRole('alert')
                        .getByText('Sign-in service unavailable'),
                ).toBeVisible();
                await expect(page.getByRole('alert')).toContainText(
                    'You are still signed in',
                );
            });

            await test.step('the portal is back: the same session works again, and new sign-ins too', async () => {
                await startHarness();

                // The circuit breaker may keep requests away for up to 30 seconds after repeated failures.
                await expect(async () => {
                    const response = await page.goto('/dashboard');

                    expect(response?.status()).toBe(200);
                    await expect(page.getByTestId('header-role')).toHaveText(
                        'Administrator',
                    );
                }).toPass({ intervals: [2_000, 3_000], timeout: 90_000 });

                await page.goto('/settings/auth');
                await expect(
                    page.getByTestId('settings-auth-health'),
                ).toHaveAttribute('data-status', 'ok');
                await expect(
                    page.getByTestId('settings-auth-health-circuit'),
                ).toContainText('Closed');

                await signIn(guestPage, users.chatAdmin);
                await expect(guestPage).toHaveURL(/\/dashboard$/);
                await expect(guestPage.getByTestId('header-role')).toHaveText(
                    'Administrator',
                );
            });
        } finally {
            await guest.close();

            if (!(await harnessIsUp())) {
                await startHarness();
            }
        }
    },
);
