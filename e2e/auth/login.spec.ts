import { type Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { loginAccounts, PASSWORD, type TestUser } from '../support/users';

/**
 * Sign-in and the role-aware shell on an installed app (mode 1 = starter-kit auth).
 *
 * Fortify throttles the login form to 5 attempts a minute per email, so the tests that type
 * credentials use their own account per project (`loginAccounts`) and keep to one or two
 * attempts each; the tests that only need "a signed-in user" start from a saved session.
 */
test.use({ scenario: 'installed' });

function accountsFor(projectName: string) {
    return loginAccounts(projectName === 'mobile' ? 'mobile' : 'desktop');
}

async function signIn(page: Page, user: TestUser, password = user.password) {
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(password);
    await page.locator('[data-test="login-button"]').click();
}

/** On narrow screens the user menu lives in the off-canvas sidebar. */
async function openUserMenu(page: Page) {
    const menuButton = page.locator('[data-test="sidebar-menu-button"]');

    if (!(await menuButton.isVisible())) {
        await page
            .getByRole('button', { name: 'Toggle Sidebar' })
            .first()
            .click();
    }

    await menuButton.click();
}

test.describe('the login page', () => {
    test('shows the starter-kit form with the capabilities of mode 1', async ({
        page,
    }) => {
        await page.goto('/login');

        await expect(page).toHaveTitle(/Log in/);
        await expect(
            page.getByRole('heading', { name: 'Log in to your account' }),
        ).toBeVisible();
        await expect(page.locator('#email')).toBeVisible();
        await expect(page.locator('#password')).toBeVisible();
        await expect(page.locator('[data-test="login-button"]')).toBeEnabled();

        // Capabilities of the local driver: password reset yes, registration no, no portal hint.
        await expect(
            page.getByRole('link', { name: 'Forgot your password?' }),
        ).toBeVisible();
        await expect(page.getByRole('link', { name: 'Sign up' })).toHaveCount(
            0,
        );
        await expect(page.getByTestId('login-portal-hint')).toHaveCount(0);
        await expect(page.getByTestId('login-no-chat-access')).toHaveCount(0);
    });

    test('registration is not available', async ({ page, request }) => {
        const response = await page.goto('/register');

        expect(response?.status()).toBe(404);

        const post = await request.post('/register', {
            headers: { Accept: 'application/json' },
            data: {
                name: 'Intruder',
                email: 'intruder@example.test',
                password: PASSWORD,
                password_confirmation: PASSWORD,
            },
        });

        // Whatever the answer is (404, or 419 for the missing CSRF token), no account is created.
        expect([404, 419]).toContain(post.status());
    });

    test('the password reset link leads to the reset form', async ({
        page,
    }) => {
        await page.goto('/login');
        await page.getByRole('link', { name: 'Forgot your password?' }).click();

        await expect(page).toHaveURL(/\/forgot-password$/);
        await expect(page.locator('#email')).toBeVisible();
        await expect(
            page.locator('[data-test="email-password-reset-link-button"]'),
        ).toBeVisible();
    });

    test('a wrong password shows an error and keeps you out', async ({
        page,
    }, testInfo) => {
        const { admin } = accountsFor(testInfo.project.name);

        await signIn(page, admin, 'not-the-password');

        await expect(page).toHaveURL(/\/login$/);
        await expect(
            page.getByText('These credentials do not match our records.'),
        ).toBeVisible();
        await expect(page.getByTestId('login-no-chat-access')).toHaveCount(0);

        // Still a guest.
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login$/);
    });
});

test.describe('signing in and out', () => {
    test('an admin signs in, sees the admin dashboard and signs out again', async ({
        page,
    }, testInfo) => {
        const { admin } = accountsFor(testInfo.project.name);

        await signIn(page, admin);

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText(
            'Administrator',
        );
        await expect(page.getByTestId('dashboard-admin-setup')).toBeVisible();
        await expect(page.getByTestId('dashboard-agent-waiting')).toHaveCount(
            0,
        );
        await expect(page.getByRole('heading', { level: 1 })).toContainText(
            `Welcome back, ${admin.name.split(' ')[0]}`,
        );

        await openUserMenu(page);
        await page.locator('[data-test="logout-button"]').click();

        await expect(page).toHaveURL(/\/login$/);
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login$/);
    });

    test('an agent with an unverified email signs in to the agent dashboard', async ({
        page,
    }, testInfo) => {
        const { agent } = accountsFor(testInfo.project.name);
        expect(agent.unverified).toBe(true);

        await signIn(page, agent);

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText('Agent');
        await expect(page.getByTestId('dashboard-agent-waiting')).toBeVisible();
        await expect(
            page.getByTestId('dashboard-availability-switch'),
        ).toBeVisible();

        // Nothing of the admin view leaks into the agent view.
        await expect(page.getByTestId('dashboard-admin-setup')).toHaveCount(0);
        await expect(page.getByTestId('dashboard-queue')).toHaveCount(0);
        await expect(page.getByTestId('dashboard-team')).toHaveCount(0);
        await expect(page.getByText('Administration')).toHaveCount(0);
    });

    test('an account that is neither admin nor agent is turned away with an explanation', async ({
        page,
    }, testInfo) => {
        const { noAccess } = accountsFor(testInfo.project.name);

        await signIn(page, noAccess);

        await expect(page).toHaveURL(/\/login$/);
        const notice = page.getByTestId('login-no-chat-access');

        await expect(notice).toBeVisible();
        await expect(notice).toContainText('No chat access');
        await expect(notice).toContainText('not an admin or an agent');

        // The credentials were right, but there is no session to use.
        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/login$/);
    });

    test('the profile, security and appearance settings are reachable', async ({
        page,
    }, testInfo) => {
        // Its own session: the security page asks to confirm the password once per session.
        await signIn(page, accountsFor(testInfo.project.name).admin);
        await expect(page).toHaveURL(/\/dashboard$/);

        await page.goto('/settings');
        await expect(page).toHaveURL(/\/settings\/profile$/);
        await expect(page).toHaveTitle(/Profile settings/);
        await expect(page.locator('input[name=email]')).toBeVisible();

        // Security (password + two-factor) asks for the password once more.
        await page.goto('/settings/security');
        await expect(page).toHaveURL(/confirm-password/);
        await page.locator('#password').fill(PASSWORD);
        await page.locator('[data-test="confirm-password-button"]').click();
        await expect(page).toHaveURL(/\/settings\/security$/);
        await expect(page).toHaveTitle(/Security settings/);
        await expect(
            page.getByRole('heading', { name: 'Update password' }),
        ).toBeVisible();
        await expect(
            page.getByRole('heading', { name: /two-factor/i }),
        ).toBeVisible();

        await page.goto('/settings/appearance');
        await expect(page).toHaveTitle(/Appearance settings/);
        await expect(page.getByRole('button', { name: 'Dark' })).toBeVisible();
    });
});

test.describe('the dashboard of a saved admin session', () => {
    test.use({ role: 'admin' });

    test('`/` lands on the dashboard and the admin checklist is complete', async ({
        page,
    }) => {
        await page.goto('/');

        await expect(page).toHaveURL(/\/dashboard$/);
        await expect(page.getByTestId('header-role')).toHaveText(
            'Administrator',
        );

        for (const key of ['category', 'widget', 'agents', 'embed']) {
            await expect(
                page.getByTestId(`dashboard-admin-step-${key}`),
            ).toBeVisible();
        }

        await expect(page.getByTestId('dashboard-queue')).toBeVisible();
        await expect(page.getByTestId('dashboard-team')).toBeVisible();
    });

    test('the appearance choice is applied and remembered', async ({
        page,
    }) => {
        await page.goto('/settings/appearance');

        await page.getByRole('button', { name: 'Dark' }).click();
        await expect(page.locator('html')).toHaveClass(/dark/);

        await page.reload();
        await expect(page.locator('html')).toHaveClass(/dark/);

        await page.getByRole('button', { name: 'Light' }).click();
        await expect(page.locator('html')).not.toHaveClass(/dark/);
    });
});

test.describe('the dashboard of a saved agent session', () => {
    test.use({ role: 'agent' });

    test('shows the waiting-for-chats view only', async ({ page }) => {
        await page.goto('/dashboard');

        await expect(page.getByTestId('header-role')).toHaveText('Agent');
        await expect(page.getByTestId('dashboard-agent-waiting')).toBeVisible();
        await expect(page.getByTestId('dashboard-admin-setup')).toHaveCount(0);

        // The availability switch is a local preview for now (presence arrives in P5).
        const availability = page.getByTestId('dashboard-availability-switch');
        await expect(availability).not.toBeChecked();
        await availability.click();
        await expect(availability).toBeChecked();
        await expect(page.getByText('You are available')).toBeVisible();
    });
});
