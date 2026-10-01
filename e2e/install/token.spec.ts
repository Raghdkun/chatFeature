import { existsSync, readFileSync } from 'node:fs';
import { type Page } from '@playwright/test';
import { SETUP_TOKEN } from '../support/scenarios';
import { expect, test } from '../support/test';
import { expectStep } from '../support/wizard';

/**
 * The one-time setup token (the takeover guard of a server that is reachable from the internet
 * before anyone installed it): APP_ENV=testing + APP_INSTALLED=false + SETUP_TOKEN.
 *
 * The token form is throttled to 5 attempts a minute per IP, and verification lives in the
 * browser session on the server, so the tests share one server state: they run in order and
 * the throttle test comes last.
 */
test.use({ scenario: 'fresh-token' });
test.describe.configure({ mode: 'serial', retries: 0 });

/** Every document/XHR response body seen by the tests below; the token must never be in one. */
const seenBodies: { url: string; status: number; body: string }[] = [];

test.beforeEach(({ page }) => {
    page.on('response', async (response) => {
        const type = response.request().resourceType();

        if (type !== 'document' && type !== 'xhr' && type !== 'fetch') {
            return;
        }

        try {
            seenBodies.push({
                url: response.url(),
                status: response.status(),
                body: await response.text(),
            });
        } catch {
            // Redirects and aborted requests have no body.
        }
    });
});

async function submitToken(page: Page, token: string): Promise<void> {
    await page.locator('input[name=token]').fill(token);
    await page.getByTestId('setup-token-submit').click();
}

test('the environment check stays locked until the token is verified', async ({
    page,
    request,
}) => {
    await page.goto('/setup');
    await expectStep(page, 'welcome');

    await expect(page.getByTestId('setup-token')).toBeVisible();
    await expect(page.locator('input[name=token]')).toHaveAttribute(
        'type',
        'password',
    );
    await expect(page.getByTestId('setup-environment')).toHaveCount(0);
    await expect(page.getByTestId('setup-token-verified')).toHaveCount(0);
    await expect(
        page.getByText(
            'The environment check appears once the token is verified.',
        ),
    ).toBeVisible();
    await expect(page.getByTestId('setup-welcome-continue')).toBeDisabled();

    // Nothing else of the wizard answers without the token either.
    const state = await request.get('/setup/state', {
        headers: { Accept: 'application/json' },
    });
    expect(state.status()).toBe(403);

    // The server-side details (database errors, paths) are not in the page props.
    const html = await page.content();
    expect(html).not.toContain('Connected to');
});

test('a wrong token is refused and nothing unlocks', async ({
    page,
    request,
}) => {
    await page.goto('/setup');
    await submitToken(page, 'definitely-not-the-token');

    await expect(page.locator('#setup-token-input-error')).toHaveText(
        'That setup token is not correct.',
    );
    await expect(page.locator('input[name=token]')).toHaveAttribute(
        'aria-invalid',
        'true',
    );
    await expectStep(page, 'welcome');
    await expect(page.getByTestId('setup-environment')).toHaveCount(0);
    await expect(page.getByTestId('setup-token-verified')).toHaveCount(0);

    const state = await request.get('/setup/state', {
        headers: { Accept: 'application/json' },
    });
    expect(state.status()).toBe(403);
});

test('the correct token unlocks the wizard and the environment check', async ({
    page,
    instance,
}) => {
    await page.goto('/setup');
    await submitToken(page, SETUP_TOKEN);

    // The environment is healthy, so the server moves straight on to the sign-in method.
    await expectStep(page, 'mode');

    // The JSON snapshot answers for this session now...
    const state = await page.request.get('/setup/state', {
        headers: { Accept: 'application/json' },
    });
    expect(state.status()).toBe(200);
    expect((await state.json()).setup).toMatchObject({
        step: 'mode',
        needsToken: true,
        tokenVerified: true,
    });

    // ...and a reload keeps the session unlocked.
    await page.reload();
    await expectStep(page, 'mode');

    // The environment check is one Back away, with details now that the token is known.
    await page.getByTestId('setup-back').click();
    await expectStep(page, 'welcome');
    await expect(page.getByTestId('setup-token-verified')).toBeVisible();
    await expect(page.getByTestId('setup-token')).toHaveCount(0);
    await expect(page.getByTestId('setup-environment')).toHaveAttribute(
        'data-ok',
        'true',
    );
    await expect(page.getByTestId('setup-env-check-database')).toContainText(
        instance.database,
    );
    await expect(page.getByTestId('setup-welcome-continue')).toBeEnabled();

    await page.getByTestId('setup-welcome-continue').click();
    await expectStep(page, 'mode');
});

test('verification belongs to one browser session, not to the server', async ({
    browser,
    baseURL,
}) => {
    const stranger = await browser.newContext({ baseURL });

    try {
        const page = await stranger.newPage();

        await page.goto('/setup');
        await expectStep(page, 'welcome');
        await expect(page.getByTestId('setup-token')).toBeVisible();
        await expect(page.getByTestId('setup-environment')).toHaveCount(0);

        const state = await stranger.request.get('/setup/state', {
            headers: { Accept: 'application/json' },
        });
        expect(state.status()).toBe(403);
    } finally {
        await stranger.close();
    }
});

test('the token never appears in a page, a JSON answer or the install state', async ({
    instance,
}) => {
    expect(seenBodies.length).toBeGreaterThan(5);

    for (const { url, body } of seenBodies) {
        expect(body, url).not.toContain(SETUP_TOKEN);
    }

    const statePath = `${instance.stateDir}/install-state.json`;

    if (existsSync(statePath)) {
        expect(readFileSync(statePath, 'utf8')).not.toContain(SETUP_TOKEN);
    }
});

test('repeated wrong tokens are throttled, even for the right token afterwards', async ({
    page,
}) => {
    await page.goto('/setup');

    const attempt = (token: string) =>
        page.evaluate(async (value) => {
            const cookie = document.cookie
                .split('; ')
                .find((entry) => entry.startsWith('XSRF-TOKEN='));
            const response = await fetch('/setup/token', {
                method: 'POST',
                redirect: 'manual',
                headers: {
                    Accept: 'application/json',
                    'Content-Type': 'application/json',
                    'X-XSRF-TOKEN': decodeURIComponent(
                        cookie?.split('=')[1] ?? '',
                    ),
                },
                body: JSON.stringify({ token: value }),
            });

            return {
                status: response.status,
                retryAfter: response.headers.get('retry-after'),
            };
        }, token);

    // The limit is 5 a minute per client; the earlier tests already used some of it.
    const statuses: number[] = [];
    let throttled: Awaited<ReturnType<typeof attempt>> | undefined;

    for (let index = 0; index < 8 && !throttled; index++) {
        const result = await attempt(`wrong-token-${index}`);

        statuses.push(result.status);
        throttled = result.status === 429 ? result : undefined;
    }

    expect(statuses, 'wrong tokens are rejected, then throttled').toContain(
        429,
    );
    expect(statuses.filter((status) => status === 429).length).toBe(1);
    expect(Number(throttled?.retryAfter)).toBeGreaterThan(0);

    // Brute forcing is not possible by simply continuing: the correct token is refused too.
    const afterwards = await attempt(SETUP_TOKEN);
    expect(afterwards.status).toBe(429);

    // The wizard UI does not pretend it worked.
    await submitToken(page, SETUP_TOKEN);
    await expect(page.getByTestId('setup-token-verified')).toHaveCount(0);
});
