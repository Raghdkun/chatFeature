import { type BrowserContext, type Page } from '@playwright/test';
import { harnessSecrets } from '../support/harness';
import { sendFromPage, signIn } from '../support/portal';
import { expect, test } from '../support/test';
import { authStatePath, portalUsers } from '../support/users';

/**
 * Settings > Auth: the administrator's view of the Auth Portal in mode 2 (health, the two environments,
 * the guarded active-environment switch, the role mapping), the 403 for agents, and the "managed by this
 * app" notice in mode 1.
 *
 * The mode-2 flow edits and switches the portal environment of its own server (one per project), in
 * order, and is never retried half way: an environment switch signs everybody out.
 */
const portal = harnessSecrets();
const users = portalUsers();

const card = (page: Page, env: 'production' | 'testing') => ({
    root: page.getByTestId(`settings-auth-env-${env}`),
    field: (name: string) =>
        page.getByTestId(`settings-auth-env-${env}-${name}`),
});

/** Click something that sends a request and wait for the server's answer to it (toasts of earlier saves may still be up). */
async function clickAndWait(
    page: Page,
    method: 'PUT' | 'POST',
    path: string,
    click: () => Promise<void>,
): Promise<void> {
    await Promise.all([
        page.waitForResponse(
            (response) =>
                response.request().method() === method &&
                new URL(response.url()).pathname === path,
        ),
        click(),
    ]);
}

test.describe('mode 2, as an agent', { tag: '@pizzasys' }, () => {
    test.use({ scenario: 'settings-pizzasys', role: 'agent' });

    test('agents see no Auth portal entry and every endpoint answers 403', async ({
        page,
    }) => {
        await page.goto('/settings/profile');
        await expect(
            page.getByRole('navigation', { name: 'Settings' }),
        ).toBeVisible();
        await expect(
            page.getByRole('link', { name: 'Auth portal', exact: true }),
        ).toHaveCount(0);

        const page403 = await page.goto('/settings/auth');
        expect(page403?.status()).toBe(403);

        await page.goto('/dashboard');
        const writes: [string, string, Record<string, unknown>][] = [
            ['GET', '/settings/auth', {}],
            [
                'PUT',
                '/settings/auth/environments/production',
                {
                    base_url: 'https://auth.example.com',
                    service_name: 'pne-chat',
                },
            ],
            ['POST', '/settings/auth/environments/production/test', {}],
            [
                'POST',
                '/settings/auth/active-environment',
                {
                    env: 'testing',
                    email: 'a@b.test',
                    password: 'x',
                    confirm: true,
                },
            ],
            [
                'PUT',
                '/settings/auth/roles',
                {
                    admin_permission: 'chat.admin',
                    agent_permission: 'chat.agent',
                    super_roles: [],
                },
            ],
        ];

        for (const [method, path, body] of writes) {
            expect(
                await sendFromPage(page, method, path, body),
                `${method} ${path}`,
            ).toBe(403);
        }
    });
});

test.describe('mode 2, as an administrator', { tag: '@pizzasys' }, () => {
    test.use({ scenario: 'settings-pizzasys', role: 'admin' });
    test.describe.configure({ mode: 'serial', retries: 0 });

    test.beforeEach(async ({ page }) => {
        await page.goto('/settings/auth');
        await expect(page.getByTestId('settings-auth')).toBeVisible();
    });

    test('the page shows a healthy portal and the current setup', async ({
        page,
    }) => {
        await expect(page).toHaveTitle(/Authentication/);
        await expect(page.getByTestId('settings-auth')).toHaveAttribute(
            'data-mode',
            'pizzasys',
        );
        await expect(page.getByTestId('settings-auth-mode')).toHaveText(
            'Auth Portal (pizzasys)',
        );

        // The settings navigation carries the entry and marks it current.
        await expect(
            page
                .getByRole('navigation', { name: 'Settings' })
                .getByRole('link', { name: 'Auth portal', exact: true }),
        ).toBeVisible();

        const health = page.getByTestId('settings-auth-health');
        await expect(health).toHaveAttribute('data-status', 'ok');
        await expect(
            page.getByTestId('settings-auth-health-status'),
        ).toHaveText('Healthy');
        await expect(
            page.getByTestId('settings-auth-health-circuit'),
        ).toContainText('Closed');
        await expect(
            page.getByTestId('settings-auth-health-credential-rejected'),
        ).toHaveCount(0);
        await expect(
            page.getByTestId('settings-auth-health-last-verify'),
        ).not.toHaveText('Never');

        await page.getByTestId('settings-auth-health-refresh').click();
        await expect(
            page.getByTestId('settings-auth-health-refresh'),
        ).toBeEnabled();
        await expect(health).toHaveAttribute('data-status', 'ok');

        // Production is the live environment; Testing is not set up yet.
        await expect(card(page, 'production').root).toHaveAttribute(
            'data-active',
            'true',
        );
        await expect(
            page.getByTestId('settings-auth-env-production-active'),
        ).toBeVisible();
        await expect(
            page.getByTestId('settings-auth-env-testing-unconfigured'),
        ).toBeVisible();
        await expect(
            page.getByTestId('settings-auth-switch-current'),
        ).toHaveText('Production');
        await expect(
            page.getByTestId('settings-auth-switch-open'),
        ).toBeDisabled();
        await expect(
            page.getByTestId('settings-auth-switch-unavailable'),
        ).toBeVisible();
    });

    test('an environment is edited and saved; the token may stay empty only while address, service name and TLS stay as they are', async ({
        page,
    }) => {
        const production = card(page, 'production');
        const result = page.getByTestId('settings-auth-env-production-result');

        // What is saved is shown, but the token never is.
        await expect(production.field('base-url')).toHaveValue(portal.baseUrl);
        await expect(production.field('service-name')).toHaveValue(
            portal.service.name,
        );
        await expect(production.field('service-token')).toHaveValue('');
        await expect(production.field('service-token-saved')).toBeVisible();
        await expect(production.field('save')).toBeDisabled();
        await expect(production.field('test')).toBeEnabled();

        // A connection test checks what is saved, and the verdict survives a reload.
        await production.field('test').click();
        await expect(result).toHaveAttribute('data-ok', 'true');
        for (const check of ['reachable', 'service_credential', 'latency']) {
            await expect(
                page.getByTestId(
                    `settings-auth-env-production-result-${check}`,
                ),
                check,
            ).toHaveAttribute('data-ok', 'true');
        }
        await expect(production.field('last-check')).toHaveAttribute(
            'data-status',
            'ok',
        );

        await page.reload();
        await expect(production.field('last-check')).toHaveAttribute(
            'data-status',
            'ok',
        );
        await expect(production.field('last-check')).toContainText(
            'Last test passed',
        );

        // Validation happens before anything is sent.
        await production.field('base-url').fill('ftp://not-a-portal.example');
        await expect(production.field('save')).toBeEnabled();
        await expect(production.field('test')).toBeDisabled();
        await production.field('save').click();
        await expect(
            page.locator('#settings-auth-env-production-base-url-error'),
        ).toBeVisible();
        await production.field('base-url').fill(portal.baseUrl);

        // Only the display name changes: the stored token stays, and no token is asked for.
        await production.field('label').fill('Live portal');
        await clickAndWait(
            page,
            'PUT',
            '/settings/auth/environments/production',
            () => production.field('save').click(),
        );
        await expect(
            page.getByText('Production settings saved.'),
        ).toBeVisible();
        await expect(production.field('service-token-saved')).toBeVisible();
        await production.field('test').click();
        await expect(result).toHaveAttribute('data-ok', 'true');

        // The token is optional only while the address, service name and TLS setting stay as they are: a stored
        // token must not be sent to another service or host, so renaming without it is refused before any request.
        await production.field('service-name').fill(portal.other.name);
        await expect(production.field('save')).toBeEnabled();
        await production.field('save').click();
        await expect(
            page.locator('#settings-auth-env-production-service-token-error'),
        ).toBeVisible();
        await expect(production.field('service-token')).toHaveAttribute(
            'aria-invalid',
            'true',
        );

        // Re-entered, the token goes along with the new name. The live environment is checked against the portal
        // first, and the portal refuses a name that does not belong to this token: nothing is saved, nobody is locked out.
        await production.field('service-token').fill(portal.service.token);
        await clickAndWait(
            page,
            'PUT',
            '/settings/auth/environments/production',
            () => production.field('save').click(),
        );
        await expect(
            page.getByText('These details could not be saved'),
        ).toBeVisible();
        await page.reload();
        await expect(production.field('service-name')).toHaveValue(
            portal.service.name,
        );
        await expect(production.field('last-check')).toHaveAttribute(
            'data-status',
            'ok',
        );

        // A pair the portal accepts is saved, and the stored token is the new one.
        await production.field('service-name').fill(portal.other.name);
        await production.field('service-token').fill(portal.other.token);
        await clickAndWait(
            page,
            'PUT',
            '/settings/auth/environments/production',
            () => production.field('save').click(),
        );
        await expect(
            page.getByText('Production settings saved.'),
        ).toBeVisible();
        await expect(production.field('save')).toBeDisabled();
        await expect(production.field('service-token')).toHaveValue('');
        await production.field('test').click();
        await expect(result).toHaveAttribute('data-ok', 'true');

        // And back to the original service with its token.
        await production.field('service-name').fill(portal.service.name);
        await production.field('service-token').fill(portal.service.token);
        await clickAndWait(
            page,
            'PUT',
            '/settings/auth/environments/production',
            () => production.field('save').click(),
        );
        await expect(production.field('save')).toBeDisabled();
        await production.field('test').click();
        await expect(result).toHaveAttribute('data-ok', 'true');
        await expect(production.field('last-check')).toHaveAttribute(
            'data-status',
            'ok',
        );
        await expect(production.field('service-token-saved')).toBeVisible();
    });

    test('a Testing environment can be added and tested', async ({ page }) => {
        const testing = card(page, 'testing');

        await expect(
            page.getByTestId('settings-auth-env-testing-unconfigured'),
        ).toBeVisible();
        await expect(testing.field('test')).toBeDisabled();
        await expect(testing.field('service-token-saved')).toHaveCount(0);

        await testing.field('base-url').fill(portal.baseUrl);
        await testing.field('service-name').fill(portal.other.name);
        await testing.field('service-token').fill(portal.other.token);
        await clickAndWait(
            page,
            'PUT',
            '/settings/auth/environments/testing',
            () => testing.field('save').click(),
        );
        await expect(page.getByText('Testing settings saved.')).toBeVisible();

        await expect(
            page.getByTestId('settings-auth-env-testing-unconfigured'),
        ).toHaveCount(0);
        await expect(testing.field('service-token')).toHaveValue('');
        await expect(testing.field('service-token-saved')).toBeVisible();

        await testing.field('test').click();
        await expect(
            page.getByTestId('settings-auth-env-testing-result'),
        ).toHaveAttribute('data-ok', 'true');
        await expect(testing.field('last-check')).toHaveAttribute(
            'data-status',
            'ok',
        );

        // Production stays the active one; the switch is available now.
        await expect(
            page.getByTestId('settings-auth-switch-current'),
        ).toHaveText('Production');
        await expect(
            page.getByTestId('settings-auth-switch-open'),
        ).toBeEnabled();

        // The secrets of both environments are nowhere in the page.
        const html = await page.content();
        expect(html).not.toContain(portal.other.token);
        expect(html).not.toContain(portal.service.token);
    });

    test('the role mapping can be edited, and saving re-checks everybody on their next request', async ({
        page,
        browser,
        instance,
    }) => {
        const agent: BrowserContext = await browser.newContext({
            baseURL: instance.url,
            storageState: authStatePath(instance, 'agent'),
            viewport: page.viewportSize() ?? undefined,
        });

        try {
            const agentPage = await agent.newPage();
            await agentPage.goto('/dashboard');
            await expect(agentPage.getByTestId('header-role')).toHaveText(
                'Agent',
            );

            const roles = page.getByTestId('settings-auth-roles');
            const save = page.getByTestId('settings-auth-roles-save');
            const saveRoles = () =>
                clickAndWait(page, 'PUT', '/settings/auth/roles', () =>
                    save.click(),
                );

            await expect(
                page.getByTestId('settings-auth-roles-admin-permission'),
            ).toHaveValue('chat.admin');
            await expect(
                page.getByTestId('settings-auth-roles-agent-permission'),
            ).toHaveValue('chat.agent');
            await expect(
                page.getByTestId('settings-auth-roles-super-roles-tag'),
            ).toHaveText(['super-admin']);
            await expect(save).toBeDisabled();

            // Validation: the two permissions must differ.
            await page
                .getByTestId('settings-auth-roles-agent-permission')
                .fill('chat.admin');
            await save.click();
            await expect(
                page.locator('#settings-auth-roles-agent-permission-error'),
            ).toContainText('must differ');

            // Nobody gets the agent permission any more: the agent's very next request ends their session.
            await page
                .getByTestId('settings-auth-roles-agent-permission')
                .fill('chat.nobody-has-this');
            await saveRoles();
            await expect(page.getByText('Role mapping saved.')).toBeVisible();

            await agentPage.goto('/dashboard');
            await expect(agentPage).toHaveURL(/\/login$/);

            // Restore the mapping and add a super role; both survive a reload.
            await page
                .getByTestId('settings-auth-roles-agent-permission')
                .fill('chat.agent');
            await page
                .locator('#settings-auth-roles-super-roles')
                .fill('ops-lead');
            await page
                .locator('#settings-auth-roles-super-roles')
                .press('Enter');
            await expect(
                page.getByTestId('settings-auth-roles-super-roles-tag'),
            ).toHaveText(['super-admin', 'ops-lead']);
            await saveRoles();

            await page.reload();
            await expect(
                page.getByTestId('settings-auth-roles-super-roles-tag'),
            ).toHaveText(['super-admin', 'ops-lead']);
            await expect(roles).toBeVisible();

            // The agent can sign in again now that the mapping is back.
            await signIn(agentPage, users.agent);
            await expect(agentPage).toHaveURL(/\/dashboard$/);
            await expect(agentPage.getByTestId('header-role')).toHaveText(
                'Agent',
            );

            // Remove the extra super role again.
            await page.getByRole('button', { name: 'Remove ops-lead' }).click();
            await saveRoles();
            await page.reload();
            await expect(
                page.getByTestId('settings-auth-roles-super-roles-tag'),
            ).toHaveText(['super-admin']);
        } finally {
            await agent.close();
        }
    });

    test('switching the active environment needs admin credentials on the target and signs everybody out; a refused switch signs nobody out', async ({
        page,
        browser,
        instance,
    }) => {
        test.setTimeout(120_000);

        // A second person is signed in while the administrator switches.
        const agent: BrowserContext = await browser.newContext({
            baseURL: instance.url,
            // `browser.newContext()` inherits the saved administrator session of this describe: start signed out.
            storageState: { cookies: [], origins: [] },
            viewport: page.viewportSize() ?? undefined,
        });

        try {
            const agentPage = await agent.newPage();
            await signIn(agentPage, users.agent);
            await expect(agentPage.getByTestId('header-role')).toHaveText(
                'Agent',
            );

            const open = page.getByTestId('settings-auth-switch-open');
            const dialog = page.getByTestId('settings-auth-switch-dialog');
            const submit = page.getByTestId('settings-auth-switch-submit');
            const problem = page.getByTestId('settings-auth-switch-problem');
            const fill = async (email: string, password: string) => {
                await page
                    .getByTestId('settings-auth-switch-email')
                    .fill(email);
                await page
                    .getByTestId('settings-auth-switch-password')
                    .fill(password);
            };

            await expect(
                page.getByTestId('settings-auth-switch-current'),
            ).toHaveText('Production');
            await open.click();
            await expect(dialog).toBeVisible();
            await expect(dialog).toContainText('Switch to Testing?');
            await expect(dialog).toContainText(
                'Everyone is signed out, including you.',
            );

            // Credentials AND the acknowledgement are required.
            await expect(submit).toBeDisabled();
            await fill(users.admin.email, users.admin.password);
            await expect(submit).toBeDisabled();
            await page.getByTestId('settings-auth-switch-ack').click();
            await expect(submit).toBeEnabled();

            // 1. An agent of the target portal is not good enough.
            await fill(users.agent.email, users.agent.password);
            await submit.click();
            await expect(problem).toContainText('not an administrator');
            await expect(dialog).toBeVisible();

            // 2. A wrong password is refused.
            await fill(users.admin.email, 'not-the-portal-password');
            await submit.click();
            await expect(problem).toContainText(
                'did not accept those credentials',
            );

            // Nobody was signed out by the refused attempts: not the person who tried, not anyone else.
            await page.goto('/dashboard');
            await expect(page.getByTestId('header-role')).toHaveText(
                'Administrator',
            );
            await agentPage.goto('/dashboard');
            await expect(agentPage.getByTestId('header-role')).toHaveText(
                'Agent',
            );
            await page.goto('/settings/auth');
            await expect(
                page.getByTestId('settings-auth-switch-current'),
            ).toHaveText('Production');

            // 3. An administrator of the target portal switches it: everybody is signed out.
            await open.click();
            await fill(users.admin.email, users.admin.password);
            await page.getByTestId('settings-auth-switch-ack').click();
            await submit.click();

            await expect(page).toHaveURL(/\/login$/);
            await page.goto('/dashboard');
            await expect(page).toHaveURL(/\/login$/);
            await agentPage.goto('/dashboard');
            await expect(agentPage).toHaveURL(/\/login$/);

            // Signing in works again, now through the Testing environment.
            await signIn(page, users.admin);
            await expect(page).toHaveURL(/\/dashboard$/);
            await expect(page.getByTestId('header-role')).toHaveText(
                'Administrator',
            );
            await page.goto('/settings/auth');
            await expect(
                page.getByTestId('settings-auth-switch-current'),
            ).toHaveText('Testing');
            await expect(card(page, 'testing').root).toHaveAttribute(
                'data-active',
                'true',
            );
            await expect(card(page, 'production').root).toHaveAttribute(
                'data-active',
                'false',
            );

            // The agent signs in on Testing too (same accounts in this harness).
            await signIn(agentPage, users.agent);
            await expect(agentPage.getByTestId('header-role')).toHaveText(
                'Agent',
            );

            // And back to Production, so the server ends the way it started.
            await open.click();
            await expect(dialog).toContainText('Switch to Production?');
            await fill(users.admin.email, users.admin.password);
            await page.getByTestId('settings-auth-switch-ack').click();
            await submit.click();
            await expect(page).toHaveURL(/\/login$/);
            await agentPage.goto('/dashboard');
            await expect(agentPage).toHaveURL(/\/login$/);

            await signIn(page, users.admin);
            await expect(page.getByTestId('header-role')).toHaveText(
                'Administrator',
            );
            await page.goto('/settings/auth');
            await expect(
                page.getByTestId('settings-auth-switch-current'),
            ).toHaveText('Production');
        } finally {
            await agent.close();
        }
    });
});

test.describe('mode 1 (starter kit auth)', () => {
    test.use({ scenario: 'installed', role: 'admin' });

    test('the page only says that sign-in is managed by this app', async ({
        page,
    }) => {
        await page.goto('/settings/profile');
        await expect(
            page
                .getByRole('navigation', { name: 'Settings' })
                .getByRole('link', { name: 'Sign-in method' }),
        ).toBeVisible();
        await page
            .getByRole('navigation', { name: 'Settings' })
            .getByRole('link', { name: 'Sign-in method' })
            .click();

        await expect(page).toHaveURL(/\/settings\/auth$/);
        await expect(page.getByTestId('settings-auth')).toHaveAttribute(
            'data-mode',
            'fortify',
        );
        await expect(page.getByTestId('settings-auth-managed')).toBeVisible();
        await expect(page.getByTestId('settings-auth-mode')).toHaveText(
            'Starter kit auth',
        );

        // Nothing of the portal UI, and every write endpoint is gone.
        for (const testId of [
            'settings-auth-health',
            'settings-auth-switch',
            'settings-auth-env-production',
            'settings-auth-roles',
        ]) {
            await expect(page.getByTestId(testId), testId).toHaveCount(0);
        }

        for (const [method, path] of [
            ['PUT', '/settings/auth/environments/production'],
            ['POST', '/settings/auth/environments/production/test'],
            ['POST', '/settings/auth/active-environment'],
            ['PUT', '/settings/auth/roles'],
        ]) {
            expect(
                await sendFromPage(page, method, path, {
                    base_url: 'https://auth.example.com',
                    service_name: 'pne-chat',
                    admin_permission: 'chat.admin',
                    agent_permission: 'chat.agent',
                    super_roles: [],
                    env: 'testing',
                    email: 'a@b.test',
                    password: 'x',
                    confirm: true,
                }),
                `${method} ${path}`,
            ).toBe(404);
        }
    });

    test.describe('as an agent', () => {
        test.use({ role: 'agent' });

        test('agents are turned away in mode 1 too', async ({ page }) => {
            await page.goto('/settings/profile');
            await expect(
                page.getByRole('link', { name: 'Sign-in method' }),
            ).toHaveCount(0);

            const response = await page.goto('/settings/auth');
            expect(response?.status()).toBe(403);
        });
    });
});
