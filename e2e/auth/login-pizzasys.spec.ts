import { type Page } from '@playwright/test';
import { revokePortalToken, setPortalPermissions } from '../support/harness';
import {
    MIN_VERIFY_TTL_SECONDS,
    openUserMenu,
    sendFromPage,
    setVerifyTtl,
    signIn,
    upstreamTokenOf,
} from '../support/portal';
import { expect, test } from '../support/test';
import { portalUsers, roleChangeAccount } from '../support/users';

/**
 * Sign-in and the role-aware shell in mode 2: staff sign in with their account in the external Auth
 * Portal (the local pizzasys harness). Roles come ONLY from the portal's roles/permissions:
 *
 *   admin@          role `super-admin` (no `chat.*` permission)    -> administrator
 *   chatadmin@      permission `chat.admin`                        -> administrator
 *   agent@          permission `chat.agent`                        -> agent
 *   roleagent@      `chat.agent` through the role chat-agent-role  -> agent
 *   norole@         nothing                                        -> no chat access
 *   storeuser@      only a store-scoped role                       -> no chat access
 *
 * Every test that types credentials uses its own account (our login throttle: 5 attempts a minute
 * per IP + email); the server of each project is separate, so desktop and mobile never share counters.
 */
test.use({ scenario: 'installed-pizzasys' });

const users = portalUsers();
const WRONG_PASSWORD = 'not-the-password';

/**
 * Waits until the session is over, asking `/dashboard` the way a navigation does (the redirect is not followed) until it answers with
 * the redirect to the login page, and then opens the login page, where the notice "Your session has ended" waits.
 *
 * The browser rests on a blank page meanwhile. A signed-in page reads the staff state (presence, queue, conversations) in the
 * background, and when one of those requests is the first to find the session revoked it ends the session with a JSON 401: the page then
 * reloads onto a login page without the notice, which only the navigation that finds the session revoked can flash (and the 401s
 * of the requests still in flight replace the session cookie again). What the person sees on the login page is therefore only
 * deterministic when the navigation is the one to find out.
 */
async function waitUntilSessionEnds(page: Page): Promise<void> {
    await page.goto('about:blank');
    await expect(async () => {
        const response = await page.request.get('/dashboard', {
            maxRedirects: 0,
        });

        expect(response.status()).toBe(302);
        expect(new URL(response.headers().location!).pathname).toBe('/login');
    }).toPass({
        intervals: [1_000, 2_000],
        timeout: (MIN_VERIFY_TTL_SECONDS + 25) * 1_000,
    });
    await page.goto('/login');
}

async function expectSignedOutAt(page: Page, path: string): Promise<void> {
    await page.goto(path);
    await expect(page).toHaveURL(/\/login$/);
}

test.describe('the login page', { tag: '@pizzasys' }, () => {
    test('is the Auth Portal variant of the sign-in form', async ({ page }) => {
        await page.goto('/login');

        await expect(page).toHaveTitle(/Sign in with Auth Portal/);
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('[data-test="login-button"]')).toBeEnabled();

        // Where the accounts live, and nothing this app cannot do in mode 2.
        await expect(page.getByTestId('login-portal-hint')).toBeVisible();
        // The harness is a loopback address: the page never discloses a non-public portal host or links to it.
        await expect(page.getByTestId('login-portal-host')).toHaveCount(0);
        await expect(
            page.getByTestId('login-portal-hint').locator('a'),
        ).toHaveCount(0);
        await expect(
            page.getByRole('link', { name: 'Forgot your password?' }),
        ).toHaveCount(0);
        await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(
            0,
        );
        await expect(page.getByTestId('login-portal-unavailable')).toHaveCount(
            0,
        );
        await expect(page.getByTestId('login-no-chat-access')).toHaveCount(0);
    });

    test('a wrong password and an unknown email get the same generic error', async ({
        page,
    }) => {
        await signIn(page, users.admin, WRONG_PASSWORD);

        await expect(page).toHaveURL(/\/login$/);
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();
        await expect(page.getByTestId('login-no-chat-access')).toHaveCount(0);
        await expect(page.getByTestId('login-portal-unavailable')).toHaveCount(
            0,
        );
        await expectSignedOutAt(page, '/dashboard');

        // No account enumeration: an address the portal does not know says exactly the same.
        await signIn(
            page,
            { ...users.admin, email: 'nobody.at.all@test.local' },
            WRONG_PASSWORD,
        );
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();
    });
});

test.describe('signing in and out', { tag: '@pizzasys' }, () => {
    test('a portal super-admin becomes an administrator and can sign out again', async ({
        page,
    }) => {
        await signIn(page, users.admin);

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText(
            'Administrator',
        );
        await expect(page.getByTestId('dashboard-admin-setup')).toBeVisible();
        await expect(page.getByTestId('dashboard-agent-waiting')).toHaveCount(
            0,
        );
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
            `Welcome back, ${users.admin.name.split(' ')[0]}`,
        );

        // Settings carry the admin-only "Auth portal" entry.
        await page.goto('/settings/profile');
        await expect(
            page
                .getByRole('navigation', { name: 'Settings' })
                .getByRole('link', { name: 'Auth portal', exact: true }),
        ).toBeVisible();

        await openUserMenu(page);
        await page.locator('[data-test="logout-button"]').click();

        await expect(page).toHaveURL(/\/login$/);
        await expectSignedOutAt(page, '/dashboard');
    });

    test('the permission chat.admin makes an administrator too', async ({
        page,
    }) => {
        await signIn(page, users.chatAdmin);

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText(
            'Administrator',
        );
        await expect(page.getByTestId('dashboard-admin-setup')).toBeVisible();
    });

    for (const key of ['agent', 'roleAgent'] as const) {
        test(`${users[key].email} lands on the agent dashboard and nothing of the admin view`, async ({
            page,
        }) => {
            await signIn(page, users[key]);

            await expect(page).toHaveURL(/\/dashboard$/);
            await expect(page.getByTestId('header-role')).toHaveText('Agent');
            await expect(
                page.getByTestId('dashboard-agent-waiting'),
            ).toBeVisible();
            await expect(
                page.getByTestId('dashboard-availability-switch'),
            ).toBeVisible();

            await expect(page.getByTestId('dashboard-admin-setup')).toHaveCount(
                0,
            );
            await expect(page.getByTestId('dashboard-queue')).toHaveCount(0);
            await expect(page.getByTestId('dashboard-team')).toHaveCount(0);
            await expect(page.getByText('Administration')).toHaveCount(0);

            // No "Auth portal" entry in settings, and the page itself is closed.
            await page.goto('/settings/profile');
            await expect(
                page.getByRole('navigation', { name: 'Settings' }),
            ).toBeVisible();
            await expect(
                page.getByRole('link', { name: 'Auth portal', exact: true }),
            ).toHaveCount(0);

            const response = await page.goto('/settings/auth');
            expect(response?.status()).toBe(403);
        });
    }

    for (const key of ['noRole', 'storeUser'] as const) {
        test(`${users[key].email} is turned away with the no-chat-access notice`, async ({
            page,
        }) => {
            await signIn(page, users[key]);

            await expect(page).toHaveURL(/\/login$/);
            const notice = page.getByTestId('login-no-chat-access');

            await expect(notice).toBeVisible();
            await expect(notice).toContainText('No chat access');
            await expect(
                page.getByTestId('login-portal-unavailable'),
            ).toHaveCount(0);

            // The credentials were right, but there is no session to use.
            await expectSignedOutAt(page, '/dashboard');
        });
    }
});

test.describe(
    'what the portal manages, this app does not offer',
    { tag: '@pizzasys' },
    () => {
        test.use({ role: 'admin' });

        test('registration, password reset, two-factor and profile edits are unavailable', async ({
            page,
        }) => {
            for (const path of [
                '/register',
                '/forgot-password',
                '/reset-password/some-token',
                '/settings/security',
            ]) {
                const response = await page.goto(path);
                expect(response?.status(), path).toBe(404);
            }

            await page.goto('/dashboard');

            const attempts: [string, string][] = [
                ['PATCH', '/settings/profile'],
                ['DELETE', '/settings/profile'],
                ['PUT', '/settings/password'],
                ['POST', '/user/two-factor-authentication'],
                ['POST', '/user/confirmed-two-factor-authentication'],
                ['POST', '/forgot-password'],
                ['POST', '/register'],
            ];

            for (const [method, path] of attempts) {
                expect(
                    await sendFromPage(page, method, path, {
                        name: 'Mallory',
                        email: 'mallory@test.local',
                    }),
                    `${method} ${path}`,
                ).toBe(404);
            }
        });
    },
);

test.describe('the profile in Auth Portal mode', { tag: '@pizzasys' }, () => {
    test.use({ role: 'admin' });

    test('is read-only, points to the portal and offers no Security page or account deletion', async ({
        page,
    }) => {
        await page.goto('/settings/profile');

        await expect(page.getByTestId('profile-managed')).toBeVisible();
        await expect(page.locator('#name')).toHaveValue(users.admin.name);
        await expect(page.locator('#name')).toHaveJSProperty('readOnly', true);
        await expect(page.locator('#email')).toHaveValue(users.admin.email);
        await expect(page.locator('#email')).toHaveJSProperty('readOnly', true);
        // No link either: the harness portal is not a public host, so the server gives the page no address.
        await expect(
            page.getByRole('link', { name: 'Open the Auth Portal' }),
        ).toHaveCount(0);

        // Nothing to save, nothing to delete, and no link to the Security page (it is a 404 in this mode).
        await expect(
            page.locator('[data-test="update-profile-button"]'),
        ).toHaveCount(0);
        await expect(page.getByText('Delete account')).toHaveCount(0);
        const settingsNav = page.getByRole('navigation', { name: 'Settings' });
        await expect(
            settingsNav.getByRole('link', { name: 'Security' }),
        ).toHaveCount(0);
        await expect(
            settingsNav.getByRole('link', { name: 'Appearance' }),
        ).toBeVisible();
    });
});

test.describe(
    'the portal decides how long a session lives',
    { tag: '@pizzasys' },
    () => {
        // These two wait for the verify cache to run out (15 s at least): one account per project, one run each.
        test.describe.configure({ mode: 'serial', retries: 0 });

        test.beforeAll(async ({ instance }) => {
            await setVerifyTtl(instance, MIN_VERIFY_TTL_SECONDS);
        });

        test('a token revoked in the portal ends the session within the verify TTL', async ({
            page,
            instance,
        }) => {
            test.setTimeout(120_000);

            await signIn(page, users.agent);
            await expect(page).toHaveURL(/\/dashboard$/);
            await expect(
                page.getByTestId('dashboard-agent-waiting'),
            ).toBeVisible();

            // The portal revokes exactly this session's token (its own logout endpoint with that token).
            await revokePortalToken(
                await upstreamTokenOf(instance, users.agent.email),
            );

            // The session may keep working until the cached verification runs out, never longer.
            await waitUntilSessionEnds(page);

            await expect(
                page
                    .getByText('Your session has ended. Please sign in again.')
                    .first(),
            ).toBeVisible();

            // The account itself is fine: signing in again starts a new portal session.
            await signIn(page, users.agent);
            await expect(page).toHaveURL(/\/dashboard$/);
            await expect(page.getByTestId('header-role')).toHaveText('Agent');
        });

        test('a role changed in the portal is picked up after the verify TTL', async ({
            page,
        }, testInfo) => {
            test.setTimeout(180_000);

            const account = roleChangeAccount(
                testInfo.project.name === 'mobile' ? 'mobile' : 'desktop',
            );

            try {
                await signIn(page, account);
                await expect(page.getByTestId('header-role')).toHaveText(
                    'Agent',
                );

                // The portal grants chat.admin: the next verification after the TTL promotes the same session.
                await setPortalPermissions(account.email, [
                    'chat.agent',
                    'chat.admin',
                ]);
                await expect(async () => {
                    await page.goto('/dashboard');
                    await expect(page.getByTestId('header-role')).toHaveText(
                        'Administrator',
                    );
                }).toPass({
                    intervals: [1_000, 2_000],
                    timeout: (MIN_VERIFY_TTL_SECONDS + 25) * 1_000,
                });
                await expect(
                    page.getByTestId('dashboard-admin-setup'),
                ).toBeVisible();

                // ... and removing every chat permission takes the access away again: the session ends.
                await setPortalPermissions(account.email, []);
                await waitUntilSessionEnds(page);
                await expect(
                    page
                        .getByText(
                            'Your session has ended. Please sign in again.',
                        )
                        .first(),
                ).toBeVisible();

                // Signing in again says why: the portal account has no chat role any more.
                await signIn(page, account);
                await expect(
                    page.getByTestId('login-no-chat-access'),
                ).toBeVisible();

                // Granting the agent permission again lets the same person back in as an agent.
                await setPortalPermissions(account.email, ['chat.agent']);
                await signIn(page, account);
                await expect(page.getByTestId('header-role')).toHaveText(
                    'Agent',
                );
            } finally {
                await setPortalPermissions(account.email, ['chat.agent']);
            }
        });
    },
);
