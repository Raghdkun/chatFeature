import { existsSync, readFileSync } from 'node:fs';
import { tinker } from '../support/artisan';
import { harnessSecrets } from '../support/harness';
import {
    expectNoHorizontalScroll,
    expectNoSeriousA11yViolations,
    setTheme,
} from '../support/helpers';
import { containsSecret, filesContainingSecret } from '../support/leaks';
import { expect, test } from '../support/test';
import { portalUsers } from '../support/users';
import {
    choosePizzasysMode,
    expectStep,
    fillEnvironment,
    RUN_STEPS,
    submitPortalAdmin,
    testEnvironment,
} from '../support/wizard';

/**
 * The complete first-run experience in mode 2 (Auth Portal) against the local pizzasys harness:
 * mode step -> portal environment + connection test -> roles -> a verified portal administrator ->
 * basics -> install -> sign in through the portal -> dashboard.
 *
 * Like the mode-1 wizard it is ONE test with steps (the wizard locks itself at the end) and is never
 * retried half way. It also proves the service token is never readable anywhere afterwards.
 */
test.use({ scenario: 'fresh-pizzasys' });
test.describe.configure({ retries: 0 });

const portal = harnessSecrets();
const users = portalUsers();
const WRONG_TOKEN = 'e2e-this-is-not-the-service-token';

/** Every document/XHR response body the browser saw: no secret may be in one. */
const seenBodies: { url: string; body: string }[] = [];

test.beforeEach(({ page }) => {
    page.on('response', async (response) => {
        const type = response.request().resourceType();

        if (type !== 'document' && type !== 'xhr' && type !== 'fetch') {
            return;
        }

        try {
            seenBodies.push({
                url: response.url(),
                body: await response.text(),
            });
        } catch {
            // Redirects and aborted requests have no body.
        }
    });
});

test(
    'walks the whole wizard in Auth Portal mode, installs and signs in through the portal',
    { tag: '@pizzasys' },
    async ({ page, request, instance }, testInfo) => {
        test.setTimeout(240_000);

        const wizard = page.getByTestId('setup-wizard');
        let loginGateRelease: () => void = () => undefined;
        const result = (check?: string) =>
            page.getByTestId(
                check
                    ? `setup-env-result-production-${check}`
                    : 'setup-env-result-production',
            );

        await test.step('mode: the Auth Portal is selectable now', async () => {
            await page.goto('/');
            await expect(page).toHaveURL(/\/setup$/);
            await expectStep(page, 'mode');

            await expect(page.locator('#setup-mode-fortify')).toBeEnabled();
            await expect(page.locator('#setup-mode-fortify')).toBeChecked();
            await expect(page.locator('#setup-mode-pizzasys')).toBeEnabled();
            await expect(
                page.locator('#setup-mode-pizzasys'),
            ).not.toBeChecked();
            await expect(
                page.getByTestId('setup-mode-badge-pizzasys'),
            ).toHaveCount(0);

            await choosePizzasysMode(page);
            await expectStep(page, 'pizzasys');
            await expect(
                page.getByTestId('setup-env-production'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);
        });

        await test.step('environment: empty and insecure input is refused before anything is sent', async () => {
            await page.getByTestId('setup-pizzasys-submit').click();

            await expectStep(page, 'pizzasys');
            await expect(
                page.locator('#setup-env-production-base-url-error'),
            ).toContainText('required');
            await expect(
                page.getByTestId('setup-env-production-base-url'),
            ).toHaveAttribute('aria-invalid', 'true');

            // Plain http is only for localhost and .test hosts.
            await fillEnvironment(page, 'production', {
                baseUrl: 'http://auth.example.com',
                serviceName: portal.service.name,
                serviceToken: portal.service.token,
            });
            await page.getByTestId('setup-pizzasys-submit').click();
            await expect(
                page.locator('#setup-env-production-base-url-error'),
            ).toContainText('Use https');
        });

        await test.step('environment: a valid connection passes every check', async () => {
            await fillEnvironment(page, 'production', {
                baseUrl: portal.baseUrl,
                serviceName: portal.service.name,
                serviceToken: portal.service.token,
            });
            await testEnvironment(page, 'production');

            await expect(result()).toHaveAttribute('data-ok', 'true');
            for (const check of [
                'reachable',
                'service_credential',
                'latency',
            ]) {
                await expect(result(check), check).toHaveAttribute(
                    'data-ok',
                    'true',
                );
            }
            await expect(result('summary')).toContainText('Every check passed');
            await expect(
                page.getByTestId('setup-env-verified-production'),
            ).toBeVisible();

            // The token was saved (encrypted) and is never shown again: the field is empty, a note says it is stored.
            await expect(
                page.getByTestId('setup-env-production-service-token-saved'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-env-production-service-token'),
            ).toHaveValue('');
            await expectNoHorizontalScroll(page);
        });

        await test.step('environment: a wrong service token fails the credential check with a fix hint', async () => {
            await fillEnvironment(page, 'production', {
                serviceToken: WRONG_TOKEN,
            });
            // Editing clears the earlier verdict.
            await expect(result()).toHaveAttribute('data-state', 'idle');
            await expect(
                page.getByTestId('setup-env-verified-production'),
            ).toHaveCount(0);

            await testEnvironment(page, 'production');

            await expect(result()).toHaveAttribute('data-ok', 'false');
            await expect(result('reachable')).toHaveAttribute(
                'data-ok',
                'true',
            );
            await expect(result('service_credential')).toHaveAttribute(
                'data-ok',
                'false',
            );
            await expect(result('service_credential-hint')).toContainText(
                "rejected this app's service credential",
            );
            await expect(result('summary')).toContainText('does not work yet');
            await expect(
                page.getByTestId('setup-env-verified-production'),
            ).toHaveCount(0);
        });

        await test.step('environment: the right token again, then repeated posts keep it', async () => {
            await fillEnvironment(page, 'production', {
                serviceToken: portal.service.token,
            });
            await testEnvironment(page, 'production');
            await expect(result()).toHaveAttribute('data-ok', 'true');

            // Nothing typed this time: the form is posted again and the server keeps the stored token.
            await testEnvironment(page, 'production');
            await expect(result()).toHaveAttribute('data-ok', 'true');
            await expect(
                page.getByTestId('setup-env-production-service-token-saved'),
            ).toBeVisible();
        });

        await test.step('environment: a server-side rejection never flashes the token into the session', async () => {
            // The browser form validates first, so post the rejected input straight at the server (same cookies).
            const cookies = await page.context().cookies();
            const xsrf = cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
            const response = await page.request.post('/setup/pizzasys', {
                headers: {
                    Accept: 'text/html',
                    'X-XSRF-TOKEN': decodeURIComponent(xsrf?.value ?? ''),
                },
                maxRedirects: 0,
                form: {
                    'environments[production][base_url]':
                        'ftp://not-allowed.example',
                    'environments[production][service_name]':
                        portal.service.name,
                    'environments[production][service_token]':
                        portal.service.token,
                    active_env: 'production',
                },
            });
            expect([302, 303, 422]).toContain(response.status());

            // Right now the session still holds the "old input" of the rejected request.
            expect(
                filesContainingSecret(
                    `${instance.dir}/framework/sessions`,
                    portal.service.token,
                ),
                'session files that hold the service token after a rejected save',
            ).toEqual([]);

            // The earlier, valid answers were not touched: a reload resumes at the next step, Back shows them.
            await page.reload();
            await expectStep(page, 'portal-admin');
            await page.getByTestId('setup-back').click();
            await expectStep(page, 'pizzasys');
            await expect(
                page.getByTestId('setup-env-production-service-token-saved'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-env-production-base-url'),
            ).toHaveValue(portal.baseUrl);
        });

        await test.step('roles: sensible defaults, Testing is optional', async () => {
            await expect(
                page.getByTestId('setup-roles-admin-permission'),
            ).toHaveValue('chat.admin');
            await expect(
                page.getByTestId('setup-roles-agent-permission'),
            ).toHaveValue('chat.agent');
            await expect(
                page.getByTestId('setup-roles-super-roles-tag'),
            ).toHaveText(['super-admin']);

            await expect(
                page.getByTestId('setup-active-env-production'),
            ).toBeChecked();
            await expect(
                page.getByTestId('setup-active-env-testing'),
            ).toBeDisabled();

            // The optional Testing environment opens, but cannot be tested while it is empty.
            await page.getByTestId('setup-env-testing-toggle').click();
            await expect(
                page.getByTestId('setup-env-testing-base-url'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-env-test-testing'),
            ).toBeDisabled();
            await page.getByTestId('setup-env-testing-toggle').click();

            // The agent permission must differ from the admin one.
            await page
                .getByTestId('setup-roles-agent-permission')
                .fill('chat.admin');
            await page.getByTestId('setup-pizzasys-submit').click();
            await expect(
                page.locator('#setup-roles-agent-permission-error'),
            ).toContainText('must differ');
            await page
                .getByTestId('setup-roles-agent-permission')
                .fill('chat.agent');
        });

        await test.step('Back and Continue: the saved token survives another post of the form', async () => {
            await page.getByTestId('setup-pizzasys-submit').click();
            await expectStep(page, 'portal-admin');
            await expect(page.getByTestId('setup-portal-target')).toContainText(
                new URL(portal.baseUrl).host,
            );

            await page.getByTestId('setup-back').click();
            await expectStep(page, 'pizzasys');
            await expect(
                page.getByTestId('setup-env-production-service-token-saved'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-env-production-base-url'),
            ).toHaveValue(portal.baseUrl);
            await expect(
                page.getByTestId('setup-env-production-service-token'),
            ).toHaveValue('');

            // Continue without typing the token again: the stored one is kept (and still works).
            await page.getByTestId('setup-pizzasys-submit').click();
            await expectStep(page, 'portal-admin');
        });

        await test.step('portal admin: wrong password, an account without chat access, an agent, then an admin', async () => {
            const problem = page.getByTestId('setup-portal-problem');

            await submitPortalAdmin(page, {
                email: users.admin.email,
                password: 'not-the-portal-password',
            });
            await expect(problem).toHaveAttribute('data-code', 'invalid');
            await expect(problem).toContainText(
                'The portal did not accept those details',
            );

            await submitPortalAdmin(page, users.noRole);
            await expect(problem).toHaveAttribute(
                'data-code',
                'no_chat_access',
            );
            await expect(problem).toContainText('No chat permission');

            await submitPortalAdmin(page, users.agent);
            await expect(problem).toHaveAttribute('data-code', 'not_admin');
            await expect(problem).toContainText('not an administrator');

            // None of the failures verified anybody.
            await expect(page.getByTestId('setup-portal-verified')).toHaveCount(
                0,
            );
            await expect(page.getByTestId('setup-portal-continue')).toHaveCount(
                0,
            );
            await expectNoHorizontalScroll(page);

            await submitPortalAdmin(page, users.admin);
            await expect(
                page.getByTestId('setup-portal-verified'),
            ).toBeVisible();
            await expect(
                page.getByTestId('setup-portal-verified-name'),
            ).toHaveText(users.admin.name);
            await expect(
                page.getByTestId('setup-portal-verified-email'),
            ).toHaveText(users.admin.email);
            await expect(problem).toHaveCount(0);
        });

        await test.step('basics: continue to the app basics', async () => {
            await page.getByTestId('setup-portal-continue').click();
            await expectStep(page, 'basics');

            await page.locator('input[name=app_url]').fill(instance.url);
            await page.getByTestId('setup-basics-submit').click();
            await expectStep(page, 'run');

            const summary = page.getByTestId('setup-run-summary');
            await expect(summary).toContainText('Auth Portal');
            await expect(
                page.getByTestId('setup-run-summary-portal'),
            ).toContainText(portal.baseUrl);
            await expect(summary).toContainText(users.admin.name);
            await expect(summary).toContainText(users.admin.email);
            await expect(summary).not.toContainText(portal.service.token);
            await expect(summary).not.toContainText(users.admin.password);
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

            // Keep the success screen where it is while it is inspected: the redirect to /login stays pending.
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

            await page.getByTestId('setup-run-start').click();
            await expectStep(page, 'done');
        });

        await test.step('done: the success screen talks about the portal and is accessible in both themes', async () => {
            await expect(page.getByTestId('setup-done-login')).toHaveAttribute(
                'href',
                '/login',
            );
            await expect(
                page.getByText('Sign in with your Auth Portal account'),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);

            await expectNoSeriousA11yViolations(
                page,
                testInfo,
                'wizard-pizzasys-done-light',
            );
            await setTheme(page, 'dark');
            await expectNoSeriousA11yViolations(
                page,
                testInfo,
                'wizard-pizzasys-done-dark',
            );
            await setTheme(page, 'light');

            loginGateRelease();
            await expect(page).toHaveURL(/\/login$/);
            await expect(wizard).toHaveCount(0);
        });

        await test.step('signs in as the portal admin and lands on the admin dashboard', async () => {
            await expect(page.getByTestId('login-portal-hint')).toBeVisible();
            // A loopback portal is never named on the sign-in page.
            await expect(page.getByTestId('login-portal-host')).toHaveCount(0);

            await page.locator('#email').fill(users.admin.email);
            await page.locator('#password').fill(users.admin.password);
            await page.locator('[data-test="login-button"]').click();

            await expect(page).toHaveURL(/\/dashboard$/);
            await expect(page.getByTestId('header-role')).toHaveText(
                'Administrator',
            );
            await expect(
                page.getByTestId('dashboard-admin-setup'),
            ).toBeVisible();
            await expect(page.getByRole('heading', { level: 1 })).toContainText(
                `Welcome back, ${users.admin.name.split(' ')[0]}`,
            );
        });

        await test.step('the wizard is gone for good', async () => {
            for (const path of ['/setup', '/setup/state']) {
                expect((await request.get(path)).status(), path).toBe(404);
            }

            const posts = await page.evaluate(async () => {
                const cookie = document.cookie
                    .split('; ')
                    .find((entry) => entry.startsWith('XSRF-TOKEN='));
                const headers = {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(
                        cookie?.split('=')[1] ?? '',
                    ),
                };
                const post = async (path: string, body: object) => {
                    const response = await fetch(path, {
                        method: 'POST',
                        headers,
                        body: JSON.stringify(body),
                    });

                    return { path, status: response.status };
                };

                return [
                    await post('/setup/pizzasys', {}),
                    await post('/setup/pizzasys/test', { env: 'production' }),
                    await post('/setup/portal-admin', {
                        email: 'admin@test.local',
                        password: 'x',
                    }),
                    await post('/setup/run/write-lock', {}),
                ];
            });

            for (const attempt of posts) {
                expect(attempt.status, attempt.path).toBe(404);
            }

            await page.goto('/setup');
            await expect(page.getByTestId('setup-wizard')).toHaveCount(0);
        });

        await test.step('the lock records the mode, and the service token is nowhere in plain text', async () => {
            const lockPath = `${instance.stateDir}/installed.lock`;
            expect(existsSync(lockPath), 'installed.lock').toBe(true);
            expect(
                (JSON.parse(readFileSync(lockPath, 'utf8')) as { mode: string })
                    .mode,
            ).toBe('pizzasys');

            // Not in anything the browser was ever sent ...
            const leaking = seenBodies.filter(
                (seen) =>
                    containsSecret(seen.body, portal.service.token) ||
                    containsSecret(seen.body, WRONG_TOKEN) ||
                    seen.body.includes(users.admin.password),
            );
            expect(
                leaking.map((seen) => seen.url),
                'responses that contain a secret',
            ).toEqual([]);
            expect(seenBodies.length).toBeGreaterThan(10);

            // ... nor in anything the server wrote down (state, sessions, cache, logs, compiled views).
            for (const secret of [portal.service.token, WRONG_TOKEN]) {
                expect(
                    filesContainingSecret(instance.dir, secret),
                    'files under the instance storage that contain a service token',
                ).toEqual([]);
            }

            // In the database it is encrypted: the stored value is not the token and does not contain it.
            const stored = await tinker(
                instance,
                `$row = \\App\\Models\\AuthEnvironment::query()->where('key', 'production')->firstOrFail();
$raw = (string) $row->getRawOriginal('service_token_encrypted');
echo 'STORED:'.($raw !== '' && ! str_contains($raw, getenv('E2E_SERVICE_TOKEN')) ? 'encrypted' : 'PLAIN');
echo '|ROWS:'.\\App\\Models\\AuthEnvironment::query()->count();`,
                { E2E_SERVICE_TOKEN: portal.service.token },
            );
            expect(stored).toContain('STORED:encrypted');
        });
    },
);
