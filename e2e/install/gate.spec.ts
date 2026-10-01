import { expect, test } from '../support/test';

/**
 * The install gate (docs/contracts/setup-wizard.md "Invariants"): before the install everything
 * except /up, the wizard and built assets is sent to /setup. Read-only, so both projects can
 * run it against the same server.
 */
test.use({ scenario: 'fresh-token' });

test.describe('install gate (not installed)', () => {
    test('web pages redirect to the wizard', async ({ page }) => {
        await page.goto('/');
        await expect(page).toHaveURL(/\/setup$/);
        await expect(page.getByTestId('setup-wizard')).toBeVisible();

        await page.goto('/login');
        await expect(page).toHaveURL(/\/setup$/);

        await page.goto('/dashboard');
        await expect(page).toHaveURL(/\/setup$/);
    });

    test('API requests get 503 not_installed', async ({ request }) => {
        for (const path of ['/api/anything', '/api/v1/conversations']) {
            const response = await request.get(path, {
                headers: { Accept: 'application/json' },
            });

            expect(response.status(), path).toBe(503);
            expect(await response.json()).toEqual({ error: 'not_installed' });
        }

        // Any JSON caller is treated like an API caller, not only /api/*.
        const dashboard = await request.get('/dashboard', {
            headers: { Accept: 'application/json' },
        });
        expect(dashboard.status()).toBe(503);
        expect(await dashboard.json()).toEqual({ error: 'not_installed' });
    });

    test('/up stays reachable', async ({ request }) => {
        const response = await request.get('/up');

        expect(response.status()).toBe(200);
    });

    test('built assets are reachable', async ({ page, request }) => {
        await page.goto('/setup');

        const assets = await page
            .locator(
                'link[rel="stylesheet"][href*="/build/"], script[src*="/build/"]',
            )
            .evaluateAll((nodes) =>
                nodes.map(
                    (node) =>
                        node.getAttribute('href') ?? node.getAttribute('src'),
                ),
            );

        expect(assets.length).toBeGreaterThan(0);

        for (const asset of assets) {
            const response = await request.get(asset as string);

            expect(response.status(), String(asset)).toBe(200);
        }
    });
});
