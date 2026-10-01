import { hostOrigin } from '../support/host';
import { liveWidget } from '../support/loader';
import { expect, test } from '../support/test';

/**
 * Rate limits of the public widget endpoints (config.chat.rate_limits: 300 requests a minute per client address and widget, 60
 * lookups a minute of keys that do not exist). Hammers the endpoint on purpose, so it has a server of its own (`p3-limits`):
 * the limits are per client address and would otherwise starve the other specs.
 */
test.use({ scenario: 'p3-limits' });

// One server for both projects: only one of them may hammer it (the budgets are per client address).
test.beforeEach(({ scenario }, testInfo) => {
    test.skip(
        scenario !== undefined && testInfo.project.name === 'mobile',
        'the desktop project hammers the shared server',
    );
});

test("a flood from a listed origin ends in 429 that the visitor's page can still read, and an unlisted origin cannot spend the budget", async ({
    adminApi,
    request,
    instance,
}) => {
    test.setTimeout(120_000);

    const { key } = await liveWidget(adminApi, instance);
    const origin = hostOrigin(instance);
    const url = `/api/v1/public/widgets/${key}/config`;
    const call = (from: string) =>
        request.get(url, {
            headers: { Origin: from },
            failOnStatusCode: false,
        });

    // A flood from an unlisted origin is refused (403) and does not use up the widget's budget...
    for (let attempt = 0; attempt < 40; attempt += 1) {
        expect((await call('http://evil.example.net')).status()).toBe(403);
    }

    // ... the listed origin keeps getting 200 until its own budget is spent.
    let limited = -1;

    for (let attempt = 1; attempt <= 340; attempt += 1) {
        const response = await call(origin);

        if (response.status() === 429) {
            limited = attempt;

            // Readable by that origin's JavaScript: CORS headers, `Retry-After` exposed, a JSON error and no cookie.
            expect(response.headers()['access-control-allow-origin']).toBe(
                origin,
            );
            expect(
                response.headers()['access-control-expose-headers'],
            ).toContain('Retry-After');
            expect(
                Number(response.headers()['retry-after']),
            ).toBeGreaterThanOrEqual(1);
            expect(response.headers()['set-cookie']).toBeUndefined();
            expect(await response.json()).toMatchObject({
                error: { code: 'rate_limited' },
            });

            break;
        }

        expect(response.status()).toBe(200);
    }

    // About 300 (a minute's budget), not 40 + 300: the unlisted origin's 403s were not counted against the widget.
    expect(limited).toBeGreaterThan(280);
    expect(limited).toBeLessThanOrEqual(310);

    // An unlisted origin still gets its plain refusal (no CORS header: it could not read an error either).
    const evil = await call('http://evil.example.net');

    expect([403, 429]).toContain(evil.status());
    expect(evil.headers()['access-control-allow-origin']).toBeUndefined();
});

test('probing keys that do not exist is limited (and does not announce which keys exist)', async ({
    request,
}) => {
    test.setTimeout(120_000);

    let limited = -1;

    for (let attempt = 1; attempt <= 90; attempt += 1) {
        const response = await request.get(
            '/api/v1/public/widgets/wk_doesnotexist0000000/config',
            {
                headers: { Origin: 'http://probe.example.net' },
                failOnStatusCode: false,
            },
        );

        expect(
            response.headers()['access-control-allow-origin'],
        ).toBeUndefined();

        if (response.status() === 429) {
            limited = attempt;
            expect(response.headers()['retry-after']).toBeDefined();
            expect(response.headers()['set-cookie']).toBeUndefined();

            break;
        }

        expect(response.status()).toBe(404);
    }

    expect(limited).toBeGreaterThan(40);
    expect(limited).toBeLessThanOrEqual(75);
});
