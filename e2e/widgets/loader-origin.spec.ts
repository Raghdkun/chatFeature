import { type APIResponse, type Page } from '@playwright/test';
import {
    chatFeature,
    hostOrigin,
    hostPage,
    settleWidget,
    widget,
} from '../support/host';
import { collectConsole, liveWidget } from '../support/loader';
import { expect, test } from '../support/test';

/**
 * Who may use a widget, and how what the loader fetches is cached: origin whitelist (CORS on the config endpoint, CSP
 * `frame-ancestors` on the iframe page, wildcards), 304s, no cookies anywhere, disabled / deleted widgets, the generic loader,
 * RTL host pages and messages from hostile frames. The widget behaviour itself is in loader-host.spec.ts.
 */
test.use({ scenario: 'p3-host' });

const OTHER = 'http://evil.example.net';

/** `Cache-Control` as a sorted list of directives (the order Laravel writes them in is not part of the contract). */
const directives = (value: string | undefined) =>
    (value ?? '')
        .split(',')
        .map((part) => part.trim())
        .sort((a, b) => a.localeCompare(b));

const CACHEABLE = directives('public, max-age=60, stale-while-revalidate=300');

/** The public config endpoint as a visitor's browser calls it. */
function config(
    request: import('@playwright/test').APIRequestContext,
    key: string,
    origin: string | null,
    extra: Record<string, string> = {},
    query = '',
): Promise<APIResponse> {
    return request.get(`/api/v1/public/widgets/${key}/config${query}`, {
        headers: { ...(origin ? { Origin: origin } : {}), ...extra },
        failOnStatusCode: false,
    });
}

async function bubbleMounted(page: Page): Promise<boolean> {
    return (await page.locator('pne-chat-widget').count()) > 0;
}

test.describe('origin whitelist', () => {
    test('a site that is not on the list gets no bubble from the generic loader: 403 origin_not_allowed and no CORS header', async ({
        page,
        adminApi,
        request,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);
        const log = collectConsole(page);
        const failed: string[] = [];

        page.on('requestfailed', (failure) => {
            if (failure.url().includes(`/widgets/${key}/config`)) {
                failed.push(`${failure.url()} ${failure.failure()?.errorText}`);
            }
        });

        // 127.0.0.1:<host port> is not `localhost:<host port>`: another origin as far as the whitelist is concerned.
        await page.goto(
            hostPage(instance, { key, src: 'generic', hostname: '127.0.0.1' }),
        );

        // The browser blocks the answer (CORS), so the page never sees it and the widget never mounts.
        await expect.poll(() => failed.length).toBeGreaterThan(0);
        expect(failed[0]).toContain('ERR_FAILED');
        expect(
            log.errors.some((line) =>
                /blocked by CORS policy|No 'Access-Control-Allow-Origin'/i.test(
                    line,
                ),
            ),
        ).toBe(true);
        await page.waitForTimeout(800);
        expect(await bubbleMounted(page)).toBe(false);

        // What the server said to that request: 403 origin_not_allowed, no ACAO, no cookie.
        const answer = await config(
            request,
            key,
            hostOrigin(instance, '127.0.0.1'),
        );

        expect(answer.status()).toBe(403);
        expect(answer.headers()['access-control-allow-origin']).toBeUndefined();
        expect(answer.headers()['set-cookie']).toBeUndefined();
        expect(await answer.json()).toMatchObject({
            error: { code: 'origin_not_allowed' },
        });
    });

    test('the iframe page can only be framed by the listed sites (CSP frame-ancestors)', async ({
        page,
        adminApi,
        request,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);

        // The header lists exactly the widget's domains, as origins.
        const embed = await request.get(`/embed/${key}`);

        expect(embed.status()).toBe(200);
        const csp = embed.headers()['content-security-policy'];

        expect(csp).toMatch(/^frame-ancestors /);
        // Source expressions without a scheme: they match ancestors of the scheme the app itself is served over.
        expect(
            csp
                .split(' ')
                .slice(1)
                .sort((a, b) => a.localeCompare(b)),
        ).toEqual([
            `*.example.localhost:${instance.hostPort}`,
            `localhost:${instance.hostPort}`,
        ]);
        expect(csp).not.toContain('127.0.0.1');
        expect(csp).not.toContain('*;');
        expect(embed.headers()['x-content-type-options']).toBe('nosniff');
        expect(embed.headers()['x-frame-options']).toBeUndefined();

        // The hosted page may not be framed at all.
        const hosted = await request.get(`/c/${key}`);

        expect(hosted.status()).toBe(200);
        expect(hosted.headers()['content-security-policy']).toBe(
            "frame-ancestors 'none'",
        );

        // `?preview=1` (the builder's draft channel) is for a signed-in administrator only: an anonymous caller is refused outright,
        // never handed the page nor the unframable-by-others policy of the preview.
        const preview = await request.get(`/embed/${key}?preview=1`, {
            failOnStatusCode: false,
        });

        expect(preview.status()).toBe(403);
        expect(preview.headers()['content-security-policy']).toBeUndefined();
        expect(preview.headers()['set-cookie']).toBeUndefined();

        // In a browser: listed origin -> the page loads; unlisted origin -> the browser refuses to render it.
        const log = collectConsole(page);

        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(
            hostPage(instance, {
                key,
                hostname: '127.0.0.1',
                attrs: { greetings: 'off' },
            }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await widget(page).launcher.click();
        await expect(widget(page).iframe).toHaveCount(1);
        await expect
            .poll(
                () =>
                    page
                        .frames()
                        .some((frame) =>
                            frame.url().startsWith('chrome-error://'),
                        ),
                { timeout: 10_000 },
            )
            .toBe(true);
        expect(log.all.some((line) => /frame-ancestors/.test(line))).toBe(true);
        // No panel page, no text: the visitor never gets a chat UI on an unlisted site.
        expect(
            page
                .frames()
                .some(
                    (frame) => frame.url() === `${instance.url}/embed/${key}`,
                ),
        ).toBe(false);

        // Known behaviour, not a guarantee: `/w/<key>.js` carries the boot config, so the bubble itself still shows on an
        // unlisted site (only the generic loader asks the config endpoint, which refuses).
        test.info().annotations.push({
            type: 'known',
            description:
                'On an unlisted origin the inlined /w/<key>.js still mounts the bubble (and greeting); the chat iframe and every API call are refused.',
        });
    });

    test('wildcards: every sub-origin of *.example.localhost is welcome, the bare name is not', async ({
        page,
        adminApi,
        request,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);

        for (const hostname of ['a.example.localhost', 'b.example.localhost']) {
            const origin = hostOrigin(instance, hostname);
            const answer = await config(request, key, origin);

            expect(answer.status(), hostname).toBe(200);
            // The origin is echoed back exactly (never `*`), and caches are told it varies.
            expect(answer.headers()['access-control-allow-origin']).toBe(
                origin,
            );
            expect(answer.headers().vary).toMatch(/Origin/i);

            for (const src of ['w', 'generic'] as const) {
                await page.goto(
                    hostPage(instance, {
                        key,
                        hostname,
                        src,
                        attrs: { greetings: 'off' },
                    }),
                );
                await expect(
                    widget(page).launcher,
                    `${hostname} ${src}`,
                ).toBeVisible();
            }
        }

        // `*.example.localhost` does not cover `example.localhost` itself, nor a lookalike.
        for (const refused of [
            hostOrigin(instance, 'example.localhost'),
            hostOrigin(instance, 'evil-example.localhost'),
            `http://a.example.localhost.evil.net:${instance.hostPort}`,
            `http://a.example.localhost:${(instance.hostPort ?? 0) + 1}`,
        ]) {
            const answer = await config(request, key, refused);

            expect(answer.status(), refused).toBe(403);
            expect(
                answer.headers()['access-control-allow-origin'],
            ).toBeUndefined();
        }

        // https is always welcome on a listed host (the entry has no scheme prefix).
        expect(
            (
                await config(
                    request,
                    key,
                    `https://a.example.localhost:${instance.hostPort}`,
                )
            ).status(),
        ).toBe(200);

        await page.goto(
            hostPage(instance, {
                key,
                hostname: 'example.localhost',
                src: 'generic',
            }),
        );
        await page.waitForTimeout(1000);
        expect(await bubbleMounted(page)).toBe(false);
    });

    test('preflights, missing and null origins', async ({
        adminApi,
        request,
        instance,
    }) => {
        const { key, ulid } = await liveWidget(adminApi, instance);
        const origin = hostOrigin(instance);
        const url = `/api/v1/public/widgets/${key}/config`;

        // A preflight from a listed origin is answered by the middleware.
        const allowed = await request.fetch(url, {
            method: 'OPTIONS',
            headers: {
                Origin: origin,
                'Access-Control-Request-Method': 'GET',
                'Access-Control-Request-Headers': 'accept, if-none-match',
            },
            failOnStatusCode: false,
        });

        expect(allowed.status()).toBe(204);
        expect(allowed.headers()['access-control-allow-origin']).toBe(origin);
        expect(allowed.headers()['access-control-allow-methods']).toBe(
            'GET, OPTIONS',
        );
        expect(allowed.headers()['access-control-allow-headers']).toContain(
            'if-none-match',
        );
        expect(allowed.headers()['set-cookie']).toBeUndefined();

        const refused = await request.fetch(url, {
            method: 'OPTIONS',
            headers: { Origin: OTHER, 'Access-Control-Request-Method': 'GET' },
            failOnStatusCode: false,
        });

        expect(refused.status()).toBe(403);
        expect(
            refused.headers()['access-control-allow-origin'],
        ).toBeUndefined();

        // No Origin at all (a server, a mobile app): refused unless the widget allows non-browser clients.
        const without = await config(request, key, null);

        expect(without.status()).toBe(403);
        expect((await without.json()).error.code).toBe('origin_not_allowed');
        expect((await config(request, key, 'null')).status()).toBe(403);

        await adminApi.ok('PATCH', `/api/v1/widgets/${ulid}`, {
            allow_non_browser_clients: true,
        });
        const allowedNow = await config(request, key, null);

        expect(allowedNow.status()).toBe(200);
        expect(
            allowedNow.headers()['access-control-allow-origin'],
        ).toBeUndefined();
        // A listed origin keeps working and an unlisted browser origin is still refused.
        expect((await config(request, key, origin)).status()).toBe(200);
        expect((await config(request, key, OTHER)).status()).toBe(403);
    });

    test('changing the domains takes effect at once, also for the cached config', async ({
        adminApi,
        request,
        instance,
    }) => {
        const { key, ulid } = await liveWidget(adminApi, instance, {
            domains: [`localhost:${instance.hostPort}`],
        });
        const other = hostOrigin(instance, '127.0.0.1');

        expect((await config(request, key, other)).status()).toBe(403);

        await adminApi.ok('PUT', `/api/v1/widgets/${ulid}/domains`, {
            domains: [
                `localhost:${instance.hostPort}`,
                `127.0.0.1:${instance.hostPort}`,
            ],
        });
        const added = await config(request, key, other);

        expect(added.status()).toBe(200);
        expect(added.headers()['access-control-allow-origin']).toBe(other);

        await adminApi.ok('PUT', `/api/v1/widgets/${ulid}/domains`, {
            domains: [`localhost:${instance.hostPort}`],
        });
        expect((await config(request, key, other)).status()).toBe(403);
        // And the embed policy follows the list.
        expect(
            (await request.get(`/embed/${key}`)).headers()[
                'content-security-policy'
            ],
        ).not.toContain('127.0.0.1');
    });
});

test.describe('delivery and caching', () => {
    test('the config endpoint: shape, cache headers and 304 on If-None-Match, with CORS on the 304', async ({
        adminApi,
        request,
        instance,
    }) => {
        const {
            key,
            ulid,
            widget: created,
        } = await liveWidget(adminApi, instance);
        const origin = hostOrigin(instance);
        const version = created.config_version as number;

        const first = await config(request, key, origin, {}, '?locale=en');

        expect(first.status()).toBe(200);
        expect(first.headers()['content-type']).toContain('application/json');
        expect(directives(first.headers()['cache-control'])).toEqual(CACHEABLE);
        expect(first.headers().vary).toMatch(/Origin/i);
        expect(first.headers()['set-cookie']).toBeUndefined();
        const etag = first.headers().etag;

        expect(etag).toMatch(/^"?[0-9a-f]{20,}"?$/);

        const body = await first.json();

        expect(Object.keys(body)).toEqual(['data']);
        expect(
            Object.keys(body.data).sort((a, b) => a.localeCompare(b)),
        ).toEqual(
            [
                'api',
                'availability',
                'categories',
                'config',
                'configVersion',
                'generatedAt',
                'greetings',
                'key',
                'locale',
                'v',
            ].sort((a, b) => a.localeCompare(b)),
        );
        expect(body.data).toMatchObject({
            v: 1,
            key,
            configVersion: version,
            api: {
                base: `${instance.url}/api/v1/public`,
                embed: `${instance.url}/embed/${key}`,
                appOrigin: instance.url,
            },
        });
        // Policy-only parts never reach the visitor's browser.
        expect(body.data.config).not.toHaveProperty('routing');
        expect(body.data.config).not.toHaveProperty('session');
        expect(
            body.data.categories.map(
                (category: { slug: string }) => category.slug,
            ),
        ).toEqual(['general', 'billing', 'sales']);
        expect(body.data.greetings).toHaveLength(3);
        expect(JSON.stringify(body)).not.toMatch(/identity|secret|"id":\d/i);

        // Same ETag back: 304, still with the CORS headers a browser needs to accept it.
        const again = await config(
            request,
            key,
            origin,
            { 'If-None-Match': etag },
            '?locale=en',
        );

        expect(again.status()).toBe(304);
        expect(again.headers()['access-control-allow-origin']).toBe(origin);
        expect(await again.text()).toBe('');

        // Publishing busts it: a new ETag, a bumped version, and the old validator no longer matches.
        await adminApi.ok('PUT', `/api/v1/widgets/${ulid}/draft`, {
            config: {
                launcher: { label: 'Changed label' },
                theme: { primary: '#0ea5e9' },
            },
        });
        await adminApi.ok('POST', `/api/v1/widgets/${ulid}/publish`);
        const after = await config(
            request,
            key,
            origin,
            { 'If-None-Match': etag },
            '?locale=en',
        );

        expect(after.status()).toBe(200);
        expect(after.headers().etag).not.toBe(etag);
        expect((await after.json()).data).toMatchObject({
            configVersion: version + 1,
            config: { launcher: { label: 'Changed label' } },
        });
        expect(
            (
                await config(
                    request,
                    key,
                    origin,
                    { 'If-None-Match': after.headers().etag },
                    '?locale=en',
                )
            ).status(),
        ).toBe(304);
    });

    test('/w/<key>.js: boot config + loader in one cacheable, cookie-free script that follows every change', async ({
        adminApi,
        request,
        instance,
    }) => {
        const { key, ulid } = await liveWidget(adminApi, instance);

        const first = await request.get(`/w/${key}.js`);

        expect(first.status()).toBe(200);
        expect(first.headers()['content-type']).toContain(
            'application/javascript',
        );
        expect(first.headers()['x-content-type-options']).toBe('nosniff');
        expect(directives(first.headers()['cache-control'])).toEqual(CACHEABLE);
        expect(first.headers()['set-cookie']).toBeUndefined();
        const etag = first.headers().etag;
        const script = await first.text();

        // The convention of the contract: a prelude that registers the boot config, then the loader.
        expect(script).toContain('window.__PNE_CHAT_BOOT__');
        // (JSON may escape the slashes of the URLs.)
        expect(script.replaceAll('\\/', '/')).toContain(
            `"appOrigin":"${instance.url}"`,
        );
        expect(script).toContain('/*! pne-chat-loader v1 */');
        expect(script).toContain('Hi! Need a hand choosing the right pair?');

        expect(
            (
                await request.get(`/w/${key}.js`, {
                    headers: { 'If-None-Match': etag },
                    failOnStatusCode: false,
                })
            ).status(),
        ).toBe(304);

        // The pool is live (no Publish): the very next request already carries it, whatever the browser cache says.
        await adminApi.ok('PUT', `/api/v1/widgets/${ulid}/greetings`, {
            greetings: [
                {
                    body: 'Brand new greeting',
                    agent_name: 'Nadia',
                    weight: 1,
                    is_active: true,
                    sort_order: 0,
                },
            ],
        });
        const live = await request.get(`/w/${key}.js`, {
            headers: { 'If-None-Match': etag },
            failOnStatusCode: false,
        });

        expect(live.status()).toBe(200);
        expect(live.headers().etag).not.toBe(etag);
        expect(await live.text()).toContain('Brand new greeting');

        // The design only after Publish.
        const before = live.headers().etag;

        await adminApi.ok('PUT', `/api/v1/widgets/${ulid}/draft`, {
            config: { launcher: { label: 'Script label' } },
        });
        expect(await (await request.get(`/w/${key}.js`)).text()).not.toContain(
            'Script label',
        );
        await adminApi.ok('POST', `/api/v1/widgets/${ulid}/publish`);
        const published = await request.get(`/w/${key}.js`);

        expect(published.headers().etag).not.toBe(before);
        expect(await published.text()).toContain('Script label');

        // The generic loader is the same bundle without any boot config (a plain static file: the web server decides its caching).
        const generic = await request.get('/widget/v1/loader.js');

        expect(generic.status()).toBe(200);
        expect(generic.headers()['set-cookie']).toBeUndefined();
        expect(generic.headers()['content-type']).toContain('javascript');
        const bundle = await generic.text();

        expect(bundle).toContain('/*! pne-chat-loader v1 */');
        expect(bundle).not.toContain('window.__PNE_CHAT_BOOT__=');
        expect(script).toContain(bundle.trim().slice(0, 200));
    });

    test('no cookies: not from the script, the iframe page, the config, the hosted page, nor from using the widget', async ({
        page,
        adminApi,
        request,
        instance,
        context,
    }) => {
        const { key } = await liveWidget(adminApi, instance);
        const origin = hostOrigin(instance);

        for (const path of [
            `/w/${key}.js`,
            `/embed/${key}`,
            `/embed/${key}?mode=inline`,
            `/c/${key}`,
            '/widget/v1/loader.js',
            `/api/v1/public/widgets/${key}/config`,
            `/api/v1/public/widgets/${key}/availability`,
            // And the failures.
            '/w/wk_doesnotexist00000.js',
            '/embed/wk_doesnotexist00000',
            '/api/v1/public/widgets/wk_doesnotexist00000/config',
        ]) {
            const response = await request.get(path, {
                headers: { Origin: origin },
                failOnStatusCode: false,
            });

            expect(response.headers()['set-cookie'], path).toBeUndefined();
        }

        // A whole visit: the page, the widget, an opened chat. The browser ends up with no cookie of the app.
        await page.goto(
            hostPage(instance, { key, attrs: { greetings: 'off' } }),
        );
        await widget(page).launcher.click();
        await expect(widget(page).iframe).toHaveCount(1);
        await expect(
            widget(page)
                .iframe.contentFrame()
                .getByText('Chat panel (coming in P4)'),
        ).toBeVisible();

        expect(
            (await context.cookies()).filter((cookie) =>
                cookie.domain.includes('127.0.0.1'),
            ),
        ).toEqual([]);
        expect(await page.evaluate(() => document.cookie)).toBe('');
    });

    test('availability endpoint: same origin rules, no cookies, a small stable shape', async ({
        adminApi,
        request,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance);
        const origin = hostOrigin(instance);

        const answer = await request.get(
            `/api/v1/public/widgets/${key}/availability`,
            {
                headers: { Origin: origin },
            },
        );

        expect(answer.status()).toBe(200);
        expect(answer.headers()['access-control-allow-origin']).toBe(origin);
        const { data } = await answer.json();

        expect(Object.keys(data).sort((a, b) => a.localeCompare(b))).toEqual(
            ['categories', 'nextOpenAt', 'online', 'openNow', 'whatsapp'].sort(
                (a, b) => a.localeCompare(b),
            ),
        );
        expect(data.whatsapp).toEqual({ enabled: false });
        expect(
            (
                await request.get(
                    `/api/v1/public/widgets/${key}/availability`,
                    { headers: { Origin: OTHER }, failOnStatusCode: false },
                )
            ).status(),
        ).toBe(403);
    });
});

test.describe('widgets that are off or gone', () => {
    test('a disabled widget answers 404 everywhere and its bubble never mounts', async ({
        page,
        adminApi,
        request,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            enabled: false,
        });
        const origin = hostOrigin(instance);

        for (const path of [`/w/${key}.js`, `/embed/${key}`, `/c/${key}`]) {
            const response = await request.get(path, {
                failOnStatusCode: false,
            });

            expect(response.status(), path).toBe(404);
            expect(response.headers()['set-cookie'], path).toBeUndefined();
        }

        const refused = await config(request, key, origin);

        expect(refused.status()).toBe(404);
        expect((await refused.json()).error.code).toBe('widget_not_found');
        // The script is a 404 with a harmless body, not HTML and not cacheable.
        const script = await request.get(`/w/${key}.js`, {
            failOnStatusCode: false,
        });

        expect(script.headers()['content-type']).toContain(
            'application/javascript',
        );
        expect(script.headers()['cache-control']).toContain('no-store');

        await page.goto(hostPage(instance, { key }));
        await page.waitForTimeout(1500);
        expect(await bubbleMounted(page)).toBe(false);
        // The page still works, the stub is all that is left of the widget.
        await expect(page.getByTestId('host-heading')).toBeVisible();
        expect(
            await page.evaluate(
                () =>
                    (window as unknown as { ChatFeature: { loaded?: boolean } })
                        .ChatFeature.loaded,
            ),
        ).toBe(undefined);

        // The generic loader fails the same way (404 on the config).
        await page.goto(hostPage(instance, { key, src: 'generic' }));
        await page.waitForTimeout(1500);
        expect(await bubbleMounted(page)).toBe(false);
    });

    test('a deleted widget stops being served at once, and a live one going offline takes the bubble with it', async ({
        page,
        browser,
        adminApi,
        request,
        instance,
    }) => {
        const gone = await liveWidget(adminApi, instance);
        const toggled = await liveWidget(adminApi, instance);
        const origin = hostOrigin(instance);

        expect((await config(request, gone.key, origin)).status()).toBe(200);
        expect((await request.get(`/w/${gone.key}.js`)).status()).toBe(200);
        await adminApi.ok('DELETE', `/api/v1/widgets/${gone.ulid}`);

        for (const path of [
            `/w/${gone.key}.js`,
            `/embed/${gone.key}`,
            `/c/${gone.key}`,
        ]) {
            expect(
                (await request.get(path, { failOnStatusCode: false })).status(),
                path,
            ).toBe(404);
        }

        expect((await config(request, gone.key, origin)).status()).toBe(404);

        // Online -> bubble; take it offline; a new page view has no bubble.
        await page.goto(
            hostPage(instance, {
                key: toggled.key,
                attrs: { greetings: 'off' },
            }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await adminApi.ok('PATCH', `/api/v1/widgets/${toggled.ulid}`, {
            is_enabled: false,
        });
        // The server stops serving it at once. (A browser that already has the script may keep using its cached copy for up to
        // `max-age` + `stale-while-revalidate`: a visitor with a cold cache is the one that shows the server's answer.)
        const visitor = await browser.newContext({
            storageState: { cookies: [], origins: [] },
        });
        const fresh = await visitor.newPage();

        await fresh.goto(hostPage(instance, { key: toggled.key }));
        await fresh.waitForTimeout(1200);
        expect(await bubbleMounted(fresh)).toBe(false);
        await visitor.close();

        // An unknown or malformed key is a plain 404 too, with the same shape.
        for (const bad of ['wk_unknownunknown00000', 'x', '../etc/passwd']) {
            const response = await config(request, bad, origin);

            expect([404, 400]).toContain(response.status());
            expect(
                response.headers()['access-control-allow-origin'],
            ).toBeUndefined();
        }
    });
});

test.describe('how the loader gets its config', () => {
    test('the generic loader reads data-widget-key and fetches the config itself, cross-origin and without credentials', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { launcher: { label: 'Fetched label' } },
        });
        const configRequests: {
            url: string;
            headers: Record<string, string>;
        }[] = [];
        const requested: string[] = [];

        page.on('request', (request) => {
            requested.push(request.url());

            if (request.url().includes('/config')) {
                // The headers the browser adds itself (Origin, Cookie) are only in the raw set.
                void request
                    .allHeaders()
                    .then((headers) =>
                        configRequests.push({ url: request.url(), headers }),
                    );
            }
        });

        await page.goto(
            hostPage(instance, {
                key,
                src: 'generic',
                attrs: { position: 'left' },
                settings: { launcher: { style: 'bubble' } },
            }),
        );
        await expect(widget(page).launcher).toBeVisible();
        await expect(widget(page).launcher).toHaveAccessibleName(
            'Fetched label',
        );
        await expect(widget(page).root).toHaveAttribute(
            'data-pos',
            'bottom-left',
        );

        // One config request, to the app's API, with the page's origin and nothing that identifies the visitor.
        await expect.poll(() => configRequests.length).toBe(1);
        expect(configRequests[0].url).toMatch(
            new RegExp(
                `^${instance.url}/api/v1/public/widgets/${key}/config\\?locale=`,
            ),
        );
        expect(configRequests[0].headers.origin).toBe(hostOrigin(instance));
        expect(configRequests[0].headers.cookie).toBeUndefined();
        expect(configRequests[0].headers.accept).toContain('application/json');
        expect(
            requested.some(
                (url) => url === `${instance.url}/widget/v1/loader.js`,
            ),
        ).toBe(true);

        // `/w/<key>.js` does not need that request: the config is inside the script.
        configRequests.length = 0;
        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).launcher).toBeVisible();
        await expect(widget(page).launcher).toHaveAccessibleName(
            'Fetched label',
        );
        expect(configRequests).toEqual([]);
    });

    test('a script added late, or a boot config not from the app, is handled', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        // Added half a second after load (a tag manager, a consent banner): the widget boots then.
        await page.goto(hostPage(instance, { key, late: 500 }));
        await expect(widget(page).launcher).toBeVisible({ timeout: 10_000 });

        // A hostile page script pre-registering its own boot config (another app origin, an embed URL somewhere else) is ignored:
        // the widget only trusts a boot config for the origin the loader script itself came from.
        await page.addInitScript(
            (boot) => {
                (
                    window as unknown as { __PNE_CHAT_BOOT__: unknown }
                ).__PNE_CHAT_BOOT__ = boot;
            },
            {
                [key]: {
                    v: 1,
                    key,
                    configVersion: 1,
                    api: {
                        base: 'https://evil.example/api',
                        embed: `https://evil.example/embed/${key}`,
                        appOrigin: 'https://evil.example',
                    },
                    config: {},
                    greetings: [],
                    categories: [],
                },
            },
        );
        await page.goto(hostPage(instance, { key, src: 'generic' }));
        await expect(widget(page).launcher).toBeVisible();
        await page.setViewportSize({ width: 1280, height: 800 });
        await widget(page).launcher.click();
        // The panel frame points at the real app, never at the injected origin.
        await expect(widget(page).iframe).toHaveAttribute(
            'src',
            `${instance.url}/embed/${key}`,
        );
    });

    test('messages from anything but the panel iframe are ignored', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: { greetings: { enabled: false } },
        });

        await page.setViewportSize({ width: 1280, height: 800 });
        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).launcher).toBeVisible();
        await chatFeature(page, 'open');
        await expect(widget(page).panel).toHaveAttribute('data-open', 'true');

        // The host page itself (or a script of it, or any other window) speaks the protocol: wrong source, so nothing happens.
        await page.evaluate(() => {
            for (const message of [
                {
                    type: 'state',
                    payload: {
                        status: 'active',
                        unread: 5,
                        agent: { name: 'Mallory' },
                    },
                },
                { type: 'unread', payload: { count: 9 } },
                { type: 'close', payload: {} },
                { type: 'resize', payload: { mode: 'fullscreen' } },
                {
                    type: 'event',
                    payload: { name: 'chat-started', data: { body: 'secret' } },
                },
            ]) {
                window.postMessage(
                    { ns: 'chatfeature', v: 1, ...message },
                    '*',
                );
            }
        });
        await page.waitForTimeout(500);

        await expect(widget(page).panel).toHaveAttribute('data-open', 'true');
        await expect(widget(page).panel).toHaveAttribute('data-mode', 'panel');
        expect(
            await chatFeature<Record<string, unknown>>(page, 'getState'),
        ).toMatchObject({
            status: 'idle',
            unread: 0,
            open: true,
        });
        expect(
            (
                await page.evaluate(
                    () =>
                        (window as unknown as { __events: { name: string }[] })
                            .__events,
                )
            ).map((event) => event.name),
        ).not.toContain('chat-started');
    });
});

test.describe('right-to-left host pages', () => {
    for (const position of ['bottom-right', 'bottom-left'] as const) {
        test(`the launcher keeps its physical corner (${position}) on a dir="rtl" page`, async ({
            page,
            adminApi,
            instance,
        }) => {
            const { key } = await liveWidget(adminApi, instance, {
                config: {
                    theme: { position, offsetX: 20, offsetY: 20 },
                    greetings: { autoHideSeconds: 60 },
                },
            });

            await page.goto(hostPage(instance, { key, rtl: true }));
            await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
            const ui = widget(page);

            await expect(ui.launcher).toBeVisible();
            await expect(ui.root).toHaveAttribute('data-pos', position);
            await settleWidget(page);
            const box = (await ui.launcher.boundingBox())!;
            const view = await page.evaluate(() => ({
                width: window.innerWidth,
                height: window.innerHeight,
            }));

            if (position === 'bottom-right') {
                expect(Math.round(view.width - (box.x + box.width))).toBe(20);
            } else {
                expect(Math.round(box.x)).toBe(20);
            }

            // The popup opens towards the page, inside the viewport, whichever way the page reads.
            await expect(ui.greeting).toBeVisible({ timeout: 10_000 });
            const popup = (await ui.greeting.boundingBox())!;

            expect(popup.x).toBeGreaterThanOrEqual(0);
            expect(popup.x + popup.width).toBeLessThanOrEqual(view.width);
        });
    }

    test('the widget text direction follows its own language, not the host page', async ({
        page,
        adminApi,
        instance,
    }) => {
        const { key } = await liveWidget(adminApi, instance, {
            config: {
                defaultLocale: 'ar',
                localeDetect: false,
                texts: { ar: { title: 'الدعم' } },
            },
        });

        // An English page, an Arabic widget: the widget mirrors itself; an Arabic page with an English widget does not.
        await page.goto(hostPage(instance, { key }));
        await expect(widget(page).root).toHaveAttribute('dir', 'rtl');

        const english = await liveWidget(adminApi, instance);

        await page.goto(hostPage(instance, { key: english.key, rtl: true }));
        await expect(widget(page).root).toHaveAttribute('dir', 'ltr');
    });
});
