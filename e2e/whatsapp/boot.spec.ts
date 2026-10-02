import { expect, test } from '../support/test';
import { tinker } from '../support/artisan';

/**
 * The boot check of the P6 WhatsApp scenario (`p6-wa`): it proves the infrastructure only, not the feature. The instance (app, Reverb,
 * customer site) is up, the stateful OpenWA mock that Playwright started next to it answers like OpenWA, the seed pointed the app at it,
 * and the control API drives a session and keeps a request log. The feature specs (`smoke.spec.ts`, then the 6A / 6B ones) build on it.
 */
test.use({ scenario: 'p6-wa' });

test.beforeEach(async ({ openWa }) => {
    await openWa.reset();
});

test('the instance is up and the OpenWA mock answers the API like OpenWA', async ({
    instance,
    openWa,
    request,
}) => {
    expect((await request.get(`${instance.url}/login`)).ok()).toBe(true);
    expect(await openWa.health()).toMatchObject({ ok: true });

    const valid = await openWa.api('POST', '/api/auth/validate');

    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({
        valid: true,
        role: 'admin',
        engineType: 'whatsapp-web.js',
    });

    // The shapes of the real image: a missing key and a wrong key are different 401s, an unknown route is a NestJS 404 even without a key.
    expect(
        (await openWa.api('POST', '/api/auth/validate', { key: null })).body,
    ).toEqual({
        message: 'API key is required',
        error: 'Unauthorized',
        statusCode: 401,
    });
    expect(
        (await openWa.api('POST', '/api/auth/validate', { key: 'nope' })).body,
    ).toEqual({
        message: 'Invalid API key',
        error: 'Unauthorized',
        statusCode: 401,
    });
    expect(
        (await openWa.api('GET', '/api/nothing-here', { key: null })).status,
    ).toBe(404);
});

test('the seed points the app at the mock (WhatsApp on, base URL and API key set)', async ({
    instance,
    openWa,
}) => {
    const output = await tinker(
        instance,
        `echo "E2E_SETTINGS=".json_encode([
    settings('whatsapp.enabled'),
    settings('whatsapp.openwa.base_url'),
    settings('whatsapp.openwa.api_key') === getenv('E2E_EXPECT_KEY'),
]);`,
        { E2E_EXPECT_KEY: openWa.apiKey },
    );
    const line = output
        .split('\n')
        .find((row) => row.startsWith('E2E_SETTINGS='));

    expect(line, output).toBeDefined();
    expect(JSON.parse(line!.slice('E2E_SETTINGS='.length))).toEqual([
        true,
        openWa.url,
        true,
    ]);
});

test('the control API drives a session, injects a message and keeps the request log', async ({
    openWa,
}) => {
    const created = await openWa.api('POST', '/api/sessions', {
        body: { name: 'boot-check' },
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
        name: 'boot-check',
        status: 'created',
        engineLoaded: false,
    });

    const started = await openWa.api(
        'POST',
        `/api/sessions/${created.body.id}/start`,
    );

    expect(started.body.status).toBe('qr_ready');

    const qr = await openWa.api('GET', `/api/sessions/${created.body.id}/qr`);

    expect(qr.body.qrCode).toMatch(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/);

    // The phone is scanned: ready, with a number.
    const ready = await openWa.connect('boot-check', '4915100000000');

    expect(ready).toMatchObject({ status: 'ready', phone: '4915100000000' });

    const inbound = await openWa.inboundText(
        'boot-check',
        '4915112345678',
        'hello',
    );

    expect(inbound.chatId).toBe('4915112345678@c.us');
    expect(inbound.message).toMatchObject({
        fromMe: false,
        kind: 'individual',
        body: 'hello',
    });

    const calls = await openWa.requests({ path: '/api/sessions' });

    expect(calls.map((call) => `${call.method} ${call.status}`)).toEqual([
        'POST 201',
        'POST 200',
        'GET 200',
    ]);
    // The mock logs which key the caller used, so a spec can prove the app sent the configured one.
    expect(calls.every((call) => call.apiKey === openWa.apiKey)).toBe(true);
});
