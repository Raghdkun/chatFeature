import { runArtisan } from '../support/chat-db';
import { readAppLog } from '../support/staff-db';
import {
    expect,
    restoreConnection,
    readySession,
    test,
    uniqueName,
    uniquePhone,
    waitForChat,
} from '../support/wa-test';
import { WaSettingsPage } from '../support/wa-ui';
import { data, eventually, type WaSession } from '../support/whatsapp';

/**
 * Settings > WhatsApp as the administrator, in the real dashboard: the connection card, a session created, started (the app registers ONE
 * webhook at OpenWA and the engine call runs inline on the `sync` queue), the QR dialog polling until the mock plays the phone and says
 * `ready`, then stop / delete, the webhook recovery and the per-session limits. Everything talks to the OpenWA mock
 * (`e2e/support/openwa-mock.mjs`); its request log proves what the app sent. Tests that only use their own session run next to the other
 * WhatsApp files (shared mode); the ones that change the connection, the mock's behaviour or count sessions run alone.
 */
test.use({ scenario: 'p6-wa' });

test('a session is created with a valid name, starts, shows its QR, becomes ready when the phone scans, and the webhook is registered once', async ({
    actors,
    instance,
    openWa,
    wa,
}) => {
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);
    const name = uniqueName('main');
    const phone = uniquePhone('4916');

    await settings.goto();
    await settings.createSession(name);

    // The new row appears (created, no webhook yet, the global limits) and the app made the session at OpenWA.
    const row = admin.page
        .getByTestId('wa-sessions-list')
        .locator('li', { hasText: name });

    await expect(row).toBeVisible();

    const ulid = (await row.getAttribute('data-testid'))!.replace(
        'wa-session-',
        '',
    );

    await settings.expectStatus(ulid, 'created');
    await expect(
        admin.page.getByTestId(`wa-session-webhook-${ulid}`),
    ).toHaveText('Not registered');
    await openWa.waitForSession(name);

    // Start: 202, the QR dialog opens at once with the picture the mock made.
    await settings.button('start', ulid).click();
    await expect(settings.qrDialog).toBeVisible();
    await expect(admin.page.getByTestId('wa-qr-image')).toHaveAttribute(
        'src',
        /^data:image\/png;base64,/,
    );
    await settings.expectStatus(ulid, 'qr');

    // Exactly ONE webhook was registered: the right URL, the events the app handles, a secret of at least 16 characters (write-only: the mock
    // only says that it has one).
    const hooks = await openWa.webhooksOf(name);

    expect(hooks).toHaveLength(1);
    expect(hooks[0].url).toBe(`${instance.url}/webhooks/openwa/${ulid}`);
    expect(hooks[0].hasSecret).toBe(true);
    expect(hooks[0].events).toEqual(
        expect.arrayContaining([
            'message.received',
            'message.sent',
            'message.ack',
            'message.failed',
            'session.status',
            'session.qr',
            'session.authenticated',
            'session.disconnected',
        ]),
    );

    const registrations = (
        await openWa.requests({ method: 'POST', path: '/webhooks' })
    ).filter((call) => call.path.includes(`/${hooks[0].sessionId}/`));

    expect(registrations).toHaveLength(1);
    expect(
        (registrations[0].body as { secret: string }).secret.length,
    ).toBeGreaterThanOrEqual(16);
    expect(registrations[0].apiKey).toBe(openWa.apiKey);

    // The phone scans: the dialog closes by itself, the badge turns ready and the number is masked until revealed.
    await openWa.connect(name, phone, 'Support Phone');
    await expect(settings.qrDialog).toBeHidden();
    await settings.expectStatus(ulid, 'ready');

    const shown = admin.page.getByTestId(`wa-session-phone-${ulid}`);

    await expect(shown).toHaveText(new RegExp(`^\\+49•+${phone.slice(-4)}$`));
    await admin.page.getByTestId(`wa-session-phone-${ulid}-toggle`).click();
    await expect(shown).toHaveText(`+${phone}`);
    await expect(row).toContainText('Support Phone');

    // The session is also ready for the API; a second start is refused (the engine is running) and the webhook is still registered once.
    const session = data<WaSession>(await wa.session(ulid), 'read the session');

    expect(session.status).toBe('ready');
    expect(session.webhookRegistered).toBe(true);
    expect((await wa.startSession(ulid)).error?.code).toBe(
        'session_not_startable',
    );
    expect(await openWa.webhooksOf(name)).toHaveLength(1);
});

test('the session name is checked on the spot and by the server (too short, bad characters, taken here, taken at OpenWA)', async ({
    actors,
    openWa,
    wa,
}) => {
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);
    const field = admin.page.getByTestId('wa-sessions-card');

    await settings.goto();

    // Client side: nothing is sent (the mock's log is shared with other specs: look for these two names only).
    await settings.createSession('ab');
    await expect(field).toContainText('Use 3 to 50 characters.');
    await settings.sessionName.fill('has space!');
    await settings.create.click();
    await expect(field).toContainText('Use letters, digits and hyphens only.');
    expect(
        (
            await openWa.requests({ method: 'POST', path: '/api/sessions' })
        ).filter((call) =>
            ['ab', 'has space!'].includes(
                (call.body as { name?: string } | null)?.name ?? '',
            ),
        ),
    ).toHaveLength(0);
    expect(
        (await wa.sessions()).data.map((row: WaSession) => row.name),
    ).not.toContain('ab');

    // The same name twice: the second is refused by the server and the message lands on the field.
    const name = uniqueName('dup');

    await settings.sessionName.fill(name);
    await settings.create.click();
    await expect(
        admin.page
            .getByTestId('wa-sessions-list')
            .locator('li', { hasText: name }),
    ).toBeVisible();
    await settings.createSession(name);
    await expect(field).toContainText(
        'A session with this name already exists.',
    );

    // A name OpenWA already has (made there, not by this app): its own conflict, mapped to a message, nothing created here.
    const foreign = uniqueName('foreign');

    await openWa.createSession({ name: foreign });
    await settings.sessionName.fill(foreign);
    await settings.create.click();
    await expect(field).toContainText(/already exists/i);

    const names = data<WaSession[]>(
        await wa.sessions(),
        'list the sessions',
    ).map((session) => session.name);

    expect(names).toContain(name);
    expect(names.filter((candidate) => candidate === name)).toHaveLength(1);
    expect(names).not.toContain(foreign);
});

test('stop disconnects after a confirmation, start reconnects a paired number without a scan, delete removes it from OpenWA and frees the name', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);

    await settings.goto();
    await settings.expectStatus(session.ulid, 'ready');

    // Stop: a confirmation first (Cancel changes nothing), then the engine is stopped at OpenWA.
    await settings.button('stop', session.ulid).click();
    await expect(admin.page.getByTestId('wa-stop-dialog')).toBeVisible();
    await admin.page.getByRole('button', { name: 'Cancel' }).click();
    await expect(admin.page.getByTestId('wa-stop-dialog')).toBeHidden();
    await settings.expectStatus(session.ulid, 'ready');
    await settings.button('stop', session.ulid).click();
    await admin.page.getByRole('button', { name: 'Stop session' }).click();
    await settings.expectStatus(session.ulid, 'disconnected');

    const stops = await openWa.requests({ method: 'POST', path: '/stop' });

    expect(stops.length).toBeGreaterThanOrEqual(1);

    // Start again: the number is still paired at OpenWA, so the engine reconnects by itself (no QR code to scan this time).
    await settings.button('start', session.ulid).click();
    await settings.expectStatus(session.ulid, 'ready');
    await expect(settings.qrDialog).toHaveCount(0);

    // Delete: confirm, gone from the page, deleted at OpenWA (its webhook and messages go with it), the name can be used again.
    await settings.button('delete', session.ulid).click();
    await expect(admin.page.getByTestId('wa-delete-dialog')).toBeVisible();
    await admin.page.getByRole('button', { name: 'Delete session' }).click();
    await expect(settings.row(session.ulid)).toHaveCount(0);

    const state = await openWa.state();

    expect(state.sessions.map((candidate) => candidate.name)).not.toContain(
        session.name,
    );
    expect(
        (await openWa.requests({ method: 'DELETE', path: '/api/sessions/' }))
            .length,
    ).toBeGreaterThanOrEqual(1);
    expect(
        (await wa.sessions()).data.map((row: WaSession) => row.ulid),
    ).not.toContain(session.ulid);

    const again = data<WaSession>(
        await wa.createSession(session.name),
        'create a session with the deleted name',
    );

    expect(again.ulid).not.toBe(session.ulid);
});

test('a session that is stopped or never started has no code to show: the QR dialog says so and offers Start', async ({
    actors,
    openWa,
    wa,
}) => {
    const name = uniqueName('idle');
    const created = data<WaSession>(await wa.createSession(name), 'create');
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);

    await settings.goto();
    await settings.expectStatus(created.ulid, 'created');

    // The page offers Start but no "Scan QR code" before it is running.
    await expect(settings.button('qr', created.ulid)).toHaveCount(0);
    await settings.button('start', created.ulid).click();
    await expect(settings.qrDialog).toBeVisible();
    await expect(admin.page.getByTestId('wa-qr-image')).toBeVisible();

    // Stop at OpenWA's side while the dialog is open: the poll learns the session is not running and stops asking for a picture.
    await openWa.setStatus(name, 'disconnected');
    await expect(admin.page.getByTestId('wa-qr-stopped')).toBeVisible();
    await expect(admin.page.getByTestId('wa-qr-restart')).toBeVisible();
    await admin.page.getByTestId('wa-qr-restart').click();
    await expect(admin.page.getByTestId('wa-qr-image')).toBeVisible();
    await openWa.connect(name, uniquePhone('4916'));
    await expect(settings.qrDialog).toBeHidden();
    await settings.expectStatus(created.ulid, 'ready');
});

test('the QR code follows OpenWA: a refreshed code replaces the picture, a QR window that ran out shows "starting" and then a new code', async ({
    actors,
    openWa,
    wa,
}) => {
    const name = uniqueName('qr');
    const created = data<WaSession>(await wa.createSession(name), 'create');

    expect((await wa.startSession(created.ulid)).status).toBe(202);

    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);

    await settings.goto();
    await settings.button('qr', created.ulid).click();

    const image = admin.page.getByTestId('wa-qr-image');

    await expect(image).toBeVisible();

    const first = await image.getAttribute('src');

    // OpenWA refreshes the code about every minute (`session.qr`): the dialog shows the new picture without a click.
    await openWa.newQr(name);
    await expect(image).not.toHaveAttribute('src', first!, { timeout: 15_000 });

    // The window ran out: the engine re-initialises (`initializing`, no code) and then offers a new one.
    const second = await image.getAttribute('src');

    await openWa.setStatus(name, 'initializing');
    await expect(admin.page.getByTestId('wa-qr-waiting')).toBeVisible({
        timeout: 15_000,
    });
    await openWa.setStatus(name, 'qr_ready');
    await expect(image).toBeVisible({ timeout: 15_000 });
    await expect(image).not.toHaveAttribute('src', second!);

    // The refresh button asks again at once (the picture stays until a new one comes).
    await admin.page.getByTestId('wa-qr-refresh').click();
    await expect(image).toBeVisible();
});

test('a code that is old is marked as possibly expired (the page clock moves two minutes)', async ({
    actors,
    openWa,
    wa,
}) => {
    const name = uniqueName('stale');
    const created = data<WaSession>(await wa.createSession(name), 'create');

    expect((await wa.startSession(created.ulid)).status).toBe(202);
    await openWa.waitForSession(name);

    const admin = await actors.staff('admin');

    await admin.page.clock.install();

    const settings = new WaSettingsPage(admin.page);

    await settings.goto();
    await settings.button('qr', created.ulid).click();
    await expect(admin.page.getByTestId('wa-qr-image')).toBeVisible();
    await expect(admin.page.getByTestId('wa-qr-stale')).toHaveCount(0);
    await admin.page.clock.fastForward(120_000);
    await expect(admin.page.getByTestId('wa-qr-stale')).toBeVisible();
});

// Exclusive: the reconciliation asks OpenWA about EVERY running session of the app, so no other spec may have a session in flight.
test.describe('the scheduled reconciliation', () => {
    test.use({ waMode: 'exclusive' });

    test('a disconnected session shows up at once (webhook), and a lost webhook is repaired by the scheduled reconciliation', async ({
        actors,
        instance,
        openWa,
        wa,
    }) => {
        const live = await readySession(wa, openWa);
        const lost = await readySession(wa, openWa);
        const admin = await actors.staff('admin');
        const settings = new WaSettingsPage(admin.page);

        await settings.goto();
        await settings.expectStatus(live.ulid, 'ready');
        await settings.expectStatus(lost.ulid, 'ready');

        // 1. The phone logs out: `session.status` + `session.disconnected` arrive, the badge and the error line follow without a reload.
        await openWa.setStatus(live.name, 'disconnected', { reason: 'LOGOUT' });
        await settings.expectStatus(live.ulid, 'disconnected');
        await expect(
            admin.page.getByTestId(`wa-session-error-${live.ulid}`),
        ).toContainText('LOGOUT');
        await expect(settings.button('start', live.ulid)).toBeVisible();

        // 2. The same, but OpenWA's webhook is gone (it was edited / deleted there): nothing is delivered, so the app still believes `ready`...
        const hook = (await openWa.webhooksOf(lost.name))[0];
        const mockSession = (await openWa.state()).sessions.find(
            (candidate) => candidate.name === lost.name,
        )!;
        const before = (await openWa.deliveries()).length;

        expect(
            (
                await openWa.api(
                    'DELETE',
                    `/api/sessions/${mockSession.id}/webhooks/${hook.id}`,
                )
            ).status,
        ).toBe(204);
        await openWa.setStatus(lost.name, 'disconnected', {
            reason: 'NAVIGATION',
        });
        expect((await openWa.deliveries()).length).toBe(before);
        expect(
            data<WaSession>(await wa.session(lost.ulid), 'read').status,
        ).toBe('ready');

        // ...until the reconciliation (every minute in production) asks OpenWA what it knows.
        await runArtisan(instance, 'whatsapp:reconcile-sessions');
        await eventually(async () => {
            const session = data<WaSession>(
                await wa.session(lost.ulid),
                'read',
            );

            return session.status === 'disconnected' ? session : undefined;
        }, 'the reconciliation to mark the session disconnected');
        await settings.expectStatus(lost.ulid, 'disconnected');
    });
});

test("the per-session limits dialog sets the session's own pause and daily cap, and 'use the global limits' takes them back", async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);
    const limits = admin.page.getByTestId(`wa-session-limits-${session.ulid}`);

    await settings.goto();
    // readySession() gave this session its own pause (0 s): the row says the limits are its own.
    await expect(limits).toContainText('At least 0 s between sends');
    await expect(limits).toContainText('set for this session');

    await admin.page.getByTestId(`wa-session-pacing-${session.ulid}`).click();

    const dialog = admin.page.getByTestId('wa-pacing-dialog');

    await expect(dialog).toBeVisible();

    // The global switch is off for a session with its own limits; type new ones.
    await expect(admin.page.getByTestId('wa-pacing-global')).not.toBeChecked();
    await dialog.getByLabel('Pause between messages').fill('2500');
    await dialog.getByLabel('Daily limit').fill('5');
    await admin.page.getByTestId('wa-pacing-save').click();
    await expect(dialog).toBeHidden();
    await expect(limits).toContainText('At least 2.5 s between sends, 5 a day');
    await expect(limits).toContainText('set for this session');

    const stored = data<WaSession & Record<string, unknown>>(
        await wa.session(session.ulid),
        'read the session',
    );

    expect(stored.sendMinIntervalMs).toBe(2500);
    expect(stored.dailySendCap).toBe(5);
    expect(stored.pacingOverridden).toBe(true);

    // The server's range is enforced on the API as well (60000 ms at most, a cap of at least 1).
    const refused = await wa.updateSession(session.ulid, {
        send_min_interval_ms: 60_001,
    });

    expect(refused.status).toBe(422);
    expect(refused.error?.details).toHaveProperty('send_min_interval_ms');
    expect(
        (await wa.updateSession(session.ulid, { daily_send_cap: 0 })).status,
    ).toBe(422);

    // Back to the global limits.
    await admin.page.getByTestId(`wa-session-pacing-${session.ulid}`).click();
    await admin.page.getByTestId('wa-pacing-global').click();
    await expect(dialog.getByLabel('Pause between messages')).toBeDisabled();
    await admin.page.getByTestId('wa-pacing-save').click();
    await expect(dialog).toBeHidden();
    await expect(limits).not.toContainText('set for this session');

    const global = data<WaSession & Record<string, unknown>>(
        await wa.session(session.ulid),
        'read the session',
    );

    expect(global.pacingOverridden).toBe(false);
});

test('registering the webhook again swaps it at OpenWA (one webhook, a new secret) and messages keep arriving', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);
    const [old] = await openWa.webhooksOf(session.name);

    await settings.goto();
    await settings.button('webhook-reregister', session.ulid).click();
    await expect(admin.page.getByTestId('wa-webhook-dialog')).toBeVisible();
    await admin.page.getByRole('button', { name: 'Register again' }).click();
    await expect(admin.page.getByTestId('wa-webhook-dialog')).toBeHidden();

    // One webhook, not two: the old one was removed at OpenWA and the new one has a different id.
    await eventually(async () => {
        const hooks = await openWa.webhooksOf(session.name);

        return hooks.length === 1 && hooks[0].id !== old.id ? hooks : undefined;
    }, 'the old webhook to be replaced');

    // Messages still verify: the mock signs with the NEW secret and the app accepts.
    const customer = uniquePhone();
    const sent = await openWa.inboundText(
        session.name,
        customer,
        'Hello after the re-registration',
    );
    const delivery = await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.received' &&
            attempt.idempotencyKey.includes(sent.messageId),
    );

    expect(delivery.status).toBe(200);
    await waitForChat(wa, session, customer);
});

test.describe('the connection to OpenWA', () => {
    test.use({ waMode: 'exclusive' });

    test('the address and key are saved write-only, the connection test says what is wrong, and the key never reaches the page', async ({
        actors,
        instance,
        openWa,
        wa,
    }) => {
        // The wrong key makes the session creation answer 502 `openwa_unauthorized`: the product's way of saying "your gateway said no".
        const admin = await actors.staff('admin', { allow: [/HTTP 502/] });
        const settings = new WaSettingsPage(admin.page);
        const test = admin.page.getByTestId('wa-connection-test');
        const result = admin.page.getByTestId('wa-test-result');

        try {
            await settings.goto();
            await expect(admin.page.getByTestId('wa-base-url')).toHaveValue(
                openWa.url,
            );
            await expect(admin.page.getByTestId('wa-api-key')).toHaveValue('');
            await expect(
                admin.page.getByTestId('wa-api-key-saved'),
            ).toBeVisible();

            // The good connection: the key's role and the engine come back.
            await test.click();
            await expect(result).toHaveAttribute('data-status', 'ok');
            await expect(result).toContainText(
                'The key has the admin role and OpenWA runs the whatsapp-web.js engine.',
            );

            // The key is not in the page, in the props, in the API or in the application log.
            const html = await admin.page.content();
            const props = await admin.page.evaluate(
                () =>
                    document.getElementById('app')?.getAttribute('data-page') ??
                    '',
            );

            expect(html).not.toContain(openWa.apiKey);
            expect(props).not.toContain(openWa.apiKey);
            expect(JSON.stringify((await wa.settings()).body)).not.toContain(
                openWa.apiKey,
            );
            expect((await wa.settings()).data.hasApiKey).toBe(true);
            expect((await wa.settings()).data).not.toHaveProperty('apiKey');

            // A wrong key (same address: the key alone may change). Saved settings reach the other PHP workers within 2 s: the test retries.
            await admin.page.getByTestId('wa-api-key').fill('owa_k1_wrong-key');
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(admin.page.getByTestId('wa-api-key')).toHaveValue('');
            await expect(async () => {
                await test.click();
                await expect(result).toHaveAttribute(
                    'data-reason',
                    'unauthorized',
                    {
                        timeout: 3_000,
                    },
                );
            }).toPass({ timeout: 15_000 });
            await expect(result).toContainText('OpenWA refused the API key');

            // The wrong key also stops session creation with the matching message.
            await admin.page
                .getByTestId('wa-session-name')
                .fill(uniqueName('nokey'));
            await admin.page.getByTestId('wa-session-create').click();
            await expect(
                admin.page.getByTestId('wa-sessions-card'),
            ).toContainText('OpenWA did not accept the API key.');

            // A read-only (viewer) key connects but cannot operate: the warning says so.
            const viewer = await openWa.createKey('viewer');

            await admin.page.getByTestId('wa-api-key').fill(viewer.key);
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(async () => {
                await test.click();
                await expect(result).toHaveAttribute('data-status', 'ok', {
                    timeout: 3_000,
                });
            }).toPass({ timeout: 15_000 });
            await expect(result).toContainText('has the viewer role');
            await expect(
                admin.page.getByTestId('wa-test-cannot-operate'),
            ).toBeVisible();

            // An address nothing listens on: unreachable (a new address needs the key again, and says so).
            await admin.page
                .getByTestId('wa-base-url')
                .fill('http://127.0.0.1:8368');
            await expect(
                admin.page.getByTestId('wa-api-key-hint'),
            ).toContainText('A new address needs the key entered again.');
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(admin.page.getByTestId('wa-api-key')).toHaveAttribute(
                'aria-invalid',
                'true',
            );
            await admin.page.getByTestId('wa-api-key').fill(openWa.apiKey);
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(admin.page.getByTestId('wa-api-key')).toHaveValue('');
            await expect(async () => {
                await test.click();
                await expect(result).toHaveAttribute(
                    'data-reason',
                    'unreachable',
                    {
                        timeout: 3_000,
                    },
                );
            }).toPass({ timeout: 15_000 });
            await expect(result).toContainText('OpenWA could not be reached');

            // An address the SSRF guard refuses (cloud metadata) is rejected at save, with the server's message under the field.
            await admin.page
                .getByTestId('wa-base-url')
                .fill('http://169.254.169.254:2785');
            await admin.page.getByTestId('wa-api-key').fill(openWa.apiKey);
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(admin.page.getByTestId('wa-base-url')).toHaveAttribute(
                'aria-invalid',
                'true',
            );
        } finally {
            await restoreConnection(wa, openWa);
        }

        expect(await readAppLog(instance)).not.toContain(openWa.apiKey);
    });
});

test.describe('OpenWA refusing or throttling', () => {
    test.use({ waMode: 'exclusive' });

    test('OpenWA refusing the webhook address (SSRF) fails the start with the explanation and the host to allow, and nothing is left half-started', async ({
        actors,
        openWa,
        wa,
    }) => {
        const name = uniqueName('ssrf');
        const created = data<WaSession>(await wa.createSession(name), 'create');
        const admin = await actors.staff('admin');
        const settings = new WaSettingsPage(admin.page);

        await openWa.config({ ssrf: 'strict' });
        await settings.goto();
        await settings.button('start', created.ulid).click();

        const problem = admin.page.getByTestId(
            `wa-session-problem-${created.ulid}`,
        );

        await expect(problem).toBeVisible();
        await expect(problem).toContainText('SSRF_ALLOWED_HOSTS');
        await expect(problem).toContainText('127.0.0.1');
        await expect(problem).toContainText(/redirect|final/i);

        // Nothing started: still `created`, no webhook at OpenWA, the engine never asked to start.
        await settings.expectStatus(created.ulid, 'created');
        expect(await openWa.webhooksOf(name)).toHaveLength(0);
        expect(
            await openWa.requests({ method: 'POST', path: '/start' }),
        ).toHaveLength(0);
        expect((await wa.startSession(created.ulid)).error?.code).toBe(
            'webhook_rejected',
        );

        // The same refusal with a verbose OpenWA (VALIDATION_ERROR_DETAIL): the app recognises it by its text too.
        await openWa.config({ ssrf: 'strict', validationDetail: true });
        expect((await wa.startSession(created.ulid)).error?.code).toBe(
            'webhook_rejected',
        );

        // The administrator allows the host at OpenWA (here: the mock stops being strict) and starts again from the same page.
        await openWa.config({
            ssrf: 'allow-loopback',
            validationDetail: false,
        });
        await settings.button('start', created.ulid).click();
        await expect(settings.qrDialog).toBeVisible();
        await settings.expectStatus(created.ulid, 'qr');
        expect(await openWa.webhooksOf(name)).toHaveLength(1);
        await expect(
            admin.page.getByTestId(`wa-session-problem-${created.ulid}`),
        ).toHaveCount(0);
    });

    test("OpenWA's global throttler (429) is told as 'try again', not as a failure, and the next start goes through", async ({
        actors,
        openWa,
        wa,
    }) => {
        const name = uniqueName('busy');
        const created = data<WaSession>(await wa.createSession(name), 'create');
        const admin = await actors.staff('admin');
        const settings = new WaSettingsPage(admin.page);

        await settings.goto();
        await openWa.throttle(1);
        await settings.button('start', created.ulid).click();

        const problem = admin.page.getByTestId(
            `wa-session-problem-${created.ulid}`,
        );

        await expect(problem).toBeVisible();
        await expect(problem).toContainText(/moment|too many|busy|again/i);
        // The session was not damaged by it: still startable, no last error.
        await settings.expectStatus(created.ulid, 'created');
        await expect(
            admin.page.getByTestId(`wa-session-error-${created.ulid}`),
        ).toHaveCount(0);

        await settings.button('start', created.ulid).click();
        await expect(settings.qrDialog).toBeVisible();
        await settings.expectStatus(created.ulid, 'qr');
    });
});

test.describe('an OpenWA that cannot be asked', () => {
    test.use({ waMode: 'exclusive' });

    test('deleting a session while OpenWA is unreachable offers "Delete here anyway"', async ({
        actors,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        // Not asking OpenWA answers 503 `openwa_unavailable` (the delete call is then retried with `?force=1`).
        const admin = await actors.staff('admin', { allow: [/HTTP 503/] });
        const settings = new WaSettingsPage(admin.page);

        await settings.goto();
        // A gateway that answers 502 on every call.
        await openWa.script({
            status: 502,
            body: { message: 'Bad gateway' },
            times: 5,
        });
        await settings.button('delete', session.ulid).click();
        await admin.page
            .getByRole('button', { name: 'Delete session' })
            .click();
        await expect(admin.page.getByTestId('wa-delete-force')).toBeVisible();
        await admin.page.getByTestId('wa-delete-force-confirm').click();
        await expect(settings.row(session.ulid)).toHaveCount(0);
        expect(
            (await wa.sessions()).data.map((row: WaSession) => row.ulid),
        ).not.toContain(session.ulid);
    });
});
