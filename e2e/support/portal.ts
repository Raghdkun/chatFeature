/**
 * Mode-2 helpers shared by the Auth Portal specs: sign in through the UI, and the few things a spec
 * has to do to the app's own server (lower the verify TTL, drop cached verdicts, read the session's
 * upstream token) through `php artisan tinker` against ONE e2e instance.
 */
import { type Page } from '@playwright/test';
import { tinker } from './artisan';
import type { Instance } from './scenarios';

export type Credentials = { email: string; password: string };

export async function signIn(
    page: Page,
    user: Credentials,
    password = user.password,
): Promise<void> {
    await page.goto('/login');
    await page.locator('#email').fill(user.email);
    await page.locator('#password').fill(password);
    await page.locator('[data-test="login-button"]').click();
}

/** On narrow screens the user menu lives in the off-canvas sidebar. */
export async function openUserMenu(page: Page): Promise<void> {
    const menuButton = page.locator('[data-test="sidebar-menu-button"]');

    if (!(await menuButton.isVisible())) {
        await page
            .getByRole('button', { name: 'Toggle Sidebar' })
            .first()
            .click();
    }

    await menuButton.click();
}

/** The registry minimum is 15 s: revocations and role changes show up that fast. */
export const MIN_VERIFY_TTL_SECONDS = 15;

export async function setVerifyTtl(
    instance: Instance,
    seconds: number,
): Promise<void> {
    await tinker(
        instance,
        `app(\\App\\Domain\\Settings\\SettingsRepository::class)->set('auth.pizzasys.verify_ttl_seconds', (int) getenv('E2E_TTL'));`,
        { E2E_TTL: String(seconds) },
    );
}

/** What a NATS `user.updated` event would do: mark every identity stale and drop every cached verify answer. */
export async function flushVerifiedIdentities(
    instance: Instance,
): Promise<void> {
    await tinker(
        instance,
        `app(\\App\\Auth\\Pizzasys\\Contracts\\IdentityInvalidator::class)->flushAll();`,
    );
}

/** Close the circuit breaker of the production environment (it stays open for 30 s after repeated failures). */
export async function resetCircuitBreaker(instance: Instance): Promise<void> {
    await tinker(
        instance,
        `app(\\App\\Auth\\Pizzasys\\PizzasysCircuitBreaker::class)->reset('production');`,
    );
}

/**
 * The upstream (portal) token of the newest live session of an account. It only ever lives in this
 * process's memory: the test hands it to the portal's own logout endpoint and drops it.
 */
export async function upstreamTokenOf(
    instance: Instance,
    email: string,
): Promise<string> {
    const out = await tinker(
        instance,
        `
$user = \\App\\Models\\User::where('email', getenv('E2E_EMAIL'))->firstOrFail();
$session = \\App\\Models\\ExternalSession::where('user_id', $user->id)->whereNull('revoked_at')->orderByDesc('id')->firstOrFail();
echo 'UPSTREAM:'.$session->token;
`,
        { E2E_EMAIL: email },
    );
    const token = /UPSTREAM:(\S+)/.exec(out)?.[1];

    if (!token) {
        throw new Error(`No live portal session found for ${email}.`);
    }

    return token;
}

/**
 * `fetch` from inside the page, so the signed-in user's session cookie and XSRF header are used.
 * Resolves with the HTTP status.
 */
export async function sendFromPage(
    page: Page,
    method: string,
    path: string,
    body: Record<string, unknown> = {},
): Promise<number> {
    return page.evaluate(
        async ({ method, path, body }) => {
            const cookie = document.cookie
                .split('; ')
                .find((entry) => entry.startsWith('XSRF-TOKEN='));
            const response = await fetch(path, {
                method,
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(
                        cookie?.split('=')[1] ?? '',
                    ),
                },
                ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
            });

            return response.status;
        },
        { method, path, body },
    );
}
