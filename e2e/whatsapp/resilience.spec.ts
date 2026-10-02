import { runArtisan } from '../support/chat-db';
import { SocketGate } from '../support/realtime';
import {
    envelope,
    readLedger,
    readWebhookSecret,
    startRelay,
    WebhookClient,
} from '../support/wa-webhook';
import {
    expect,
    readySession,
    restoreConnection,
    settleSettings,
    test,
    transcript,
    uniquePhone,
    waitForChat,
    waitForMessage,
} from '../support/wa-test';
import { WaInboxPage } from '../support/wa-ui';
import {
    data,
    eventually,
    type WaChat,
    type WaSession,
} from '../support/whatsapp';

/**
 * When things go wrong around the inbox: Reverb cut for the administrator's browser (REST polling keeps it working), OpenWA unreachable or
 * answering errors, deliveries that OpenWA has to retry (the same delivery id and idempotency key, an answer that was lost), session events that
 * arrive out of order or all at once, a burst of messages, and two administrator tabs at the same time.
 */
test.use({ scenario: 'p6-wa' });

const SOCKET_NOISE = [/WebSocket/i];

test("Reverb is cut for the administrator's browser: the page says so, polls for what it missed (messages, unread, replies keep working over REST), and goes live again", async ({
    actors,
    instance,
    openWa,
    wa,
}) => {
    test.setTimeout(120_000);

    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, 'Before the outage', {
        pushName: 'Olivia Outage',
    });

    const chat = await waitForChat(wa, session, customer);
    const admin = await actors.staff('admin', { allow: SOCKET_NOISE });
    const gate = await SocketGate.install(admin.context, instance);

    await admin.page.clock.install();

    const inbox = new WaInboxPage(admin.page);
    // The list column's banner, or on a phone (where an open chat hides the list) the compact one of the conversation: the visible one.
    const banner = admin.page.locator(
        '[data-testid^="connection-banner"]:visible',
    );

    await inbox.goto(chat.ulid);
    await expect(banner).toHaveCount(0);
    expect(gate.attempts).toBeGreaterThan(0);

    // Connected: live.
    await openWa.inboundText(session.name, customer, 'Live while connected', {
        pushName: 'Olivia Outage',
    });
    await expect(inbox.bubble('Live while connected')).toBeVisible();

    // The socket is cut and cannot come back: the banner says the page now checks every 15 seconds.
    await gate.block();
    await admin.page.clock.fastForward(3_000);
    await expect(banner).toBeVisible();
    await expect(banner).toContainText('every 15 seconds');

    // A message arrives meanwhile: nothing live, then the next poll tick brings it (the page's clock jumps a poll interval).
    await openWa.inboundText(session.name, customer, 'Said during the outage', {
        pushName: 'Olivia Outage',
    });
    await waitForMessage(
        wa,
        chat,
        (message) => message.body === 'Said during the outage',
    );
    await expect(inbox.bubble('Said during the outage')).toHaveCount(0);
    await admin.page.clock.fastForward(16_000);
    await expect(inbox.bubble('Said during the outage')).toBeVisible();

    // Replying needs no socket: REST, and the ticks come back with the next poll.
    await openWa.sessionAcks(session.name, { mode: 'manual' });
    await inbox.reply('Replying without a socket');

    const sent = await openWa.waitForRequest(
        (request) =>
            request.path.endsWith('/messages/send-text') &&
            JSON.stringify(request.body).includes('without a socket'),
    );

    await expect(inbox.bubble('Replying without a socket')).toHaveAttribute(
        'data-status',
        /sent|delivered/,
    );
    await openWa.ack(
        session.name,
        (sent.response as { messageId: string }).messageId,
        'read',
    );
    await waitForMessage(
        wa,
        chat,
        (message) =>
            message.body === 'Replying without a socket' &&
            message.status === 'read',
    );
    await admin.page.clock.fastForward(16_000);
    await expect(inbox.bubble('Replying without a socket')).toHaveAttribute(
        'data-status',
        'read',
    );

    // The socket returns: the banner goes and the next message is live again (the page's own reconnect, no clock help).
    gate.allow();
    await expect(banner).toHaveCount(0, { timeout: 30_000 });
    await openWa.inboundText(session.name, customer, 'Live again', {
        pushName: 'Olivia Outage',
    });
    await expect(inbox.bubble('Live again')).toBeVisible();
    expect((await transcript(wa, chat)).map((message) => message.body)).toEqual(
        [
            'Before the outage',
            'Live while connected',
            'Said during the outage',
            'Replying without a socket',
            'Live again',
        ],
    );
});

test.describe('OpenWA out of reach', () => {
    test.use({ waMode: 'exclusive' });

    test('with the address pointing nowhere replies fail with a clear reason, the session is not damaged, and everything works again when the address is right', async ({
        actors,
        instance,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        const customer = uniquePhone();

        await openWa.inboundText(session.name, customer, 'Anybody there?', {
            pushName: 'Nora Nowhere',
        });

        const chat = await waitForChat(wa, session, customer);
        // Not a loopback port anybody listens on (the suite's recorder port, idle outside a recording).
        const nowhere = 'http://127.0.0.1:8368';
        const admin = await actors.staff('admin');
        const inbox = new WaInboxPage(admin.page);

        try {
            await inbox.goto(chat.ulid);
            data(
                await wa.saveSettings({
                    base_url: nowhere,
                    api_key: openWa.apiKey,
                }),
                'point OpenWA nowhere',
            );
            await settleSettings();

            // A reply: stored, tried once, failed with the reason; nothing is lost, nothing is sent twice.
            await inbox.reply('Is this going out?');

            const failed = await waitForMessage(
                wa,
                chat,
                (message) =>
                    message.body === 'Is this going out?' &&
                    message.status === 'failed',
                'the reply to fail',
            );

            expect(failed.error).toMatch(/^OpenWA could not be reached/);
            await expect(inbox.bubble('Is this going out?')).toHaveAttribute(
                'data-status',
                'failed',
            );
            await expect(
                admin.page.getByTestId(`wa-message-failure-${failed.ulid}`),
            ).toContainText('OpenWA could not be reached');

            // The session actions say the same instead of failing silently; the stored session is untouched.
            const sync = await wa.syncSession(session.ulid);

            expect(sync.status).toBe(503);
            expect(sync.error?.code).toBe('openwa_unavailable');
            expect(
                (await wa.startSession(session.ulid)).status,
            ).toBeGreaterThanOrEqual(409);
            expect(
                data<WaSession>(await wa.session(session.ulid), 'read').status,
            ).toBe('ready');

            // The scheduled reconciliation cannot ask either: it keeps what it knew (no spurious failure) and reports nothing to the page.
            await runArtisan(instance, 'whatsapp:reconcile-sessions');
            expect(
                data<WaSession>(await wa.session(session.ulid), 'read').status,
            ).toBe('ready');
            expect(
                data<WaSession>(await wa.session(session.ulid), 'read')
                    .lastError,
            ).toBeNull();

            // The administrator fixes the address: the same chat works again.
            await restoreConnection(wa, openWa);
            await inbox.reply('Now it goes out');
            await expect(inbox.bubble('Now it goes out')).toHaveAttribute(
                'data-status',
                /sent|delivered|read/,
            );
            expect(
                data<WaSession>(await wa.syncSession(session.ulid), 'sync')
                    .status,
            ).toBe('ready');
        } finally {
            await restoreConnection(wa, openWa);
        }
    });

    test('a gateway that errors for a while does not flip a healthy session; the reconciliation repairs what a lost webhook left behind', async ({
        instance,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        const mock = (await openWa.state()).sessions.find(
            (candidate) => candidate.name === session.name,
        )!;
        const lookup = `/api/sessions/${mock.id}`;

        // OpenWA answers 502 to the next question about this session: reconciling keeps the status it had.
        await openWa.script({
            method: 'GET',
            path: lookup,
            status: 502,
            body: { message: 'Bad gateway' },
            times: 1,
        });
        await runArtisan(instance, 'whatsapp:reconcile-sessions');
        expect(
            data<WaSession>(await wa.session(session.ulid), 'read'),
        ).toMatchObject({ status: 'ready', lastError: null });

        // The phone logs out while the webhook is gone: the app does not know until it asks.
        const hook = (await openWa.webhooksOf(session.name))[0];

        await openWa.api('DELETE', `${lookup}/webhooks/${hook.id}`);
        await openWa.setStatus(session.name, 'disconnected', {
            reason: 'LOGOUT',
        });
        expect(
            data<WaSession>(await wa.session(session.ulid), 'read').status,
        ).toBe('ready');
        await runArtisan(instance, 'whatsapp:reconcile-sessions');
        await eventually(
            async () =>
                data<WaSession>(await wa.session(session.ulid), 'read')
                    .status === 'disconnected' || undefined,
            'the reconciliation to notice',
        );

        // The webhook can be registered again from the page's recovery action (a new secret), and deliveries verify again.
        expect((await wa.reregisterWebhook(session.ulid)).status).toBe(200);
        await openWa.connect(session.name, session.phone);

        const customer = uniquePhone();

        await openWa.inboundText(session.name, customer, 'After the recovery');
        await waitForChat(wa, session, customer);
    });
});

test('a delivery whose answer is lost, or that never arrived, is retried by OpenWA with the same ids and ends up as exactly one message', async ({
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const secret = await readWebhookSecret(instance, session.ulid);
    const mock = (await openWa.state()).sessions.find(
        (candidate) => candidate.name === session.name,
    )!;
    const own = (await openWa.webhooksOf(session.name))[0];
    const target = `${instance.url}/webhooks/openwa/${session.ulid}`;

    // The session's deliveries go through a relay that makes the network misbehave; the secret is the app's own, so the signature still verifies.
    const lost = await startRelay(target, { fail: 1, mode: 'lost-answer' });
    const missing = await startRelay(target, { fail: 2, mode: 'unreachable' });

    try {
        expect(
            (
                await openWa.api(
                    'DELETE',
                    `/api/sessions/${mock.id}/webhooks/${own.id}`,
                )
            ).status,
        ).toBe(204);

        // 1. The app receives the delivery and answers, but OpenWA is told 500: the retry is a quiet duplicate.
        const hookA = await openWa.api(
            'POST',
            `/api/sessions/${mock.id}/webhooks`,
            {
                body: {
                    url: lost.url,
                    events: ['message.received'],
                    secret,
                    retryCount: 3,
                },
            },
        );

        expect(hookA.status).toBe(201);

        const first = uniquePhone();
        const sentA = await openWa.inboundText(
            session.name,
            first,
            'Answer lost on the way back',
        );
        const chatA = await waitForChat(wa, session, first);

        await eventually(
            async () =>
                lost.calls.length >= 2 && lost.calls[1].appBody !== null
                    ? lost.calls
                    : undefined,
            'OpenWA to retry and the app to answer',
        );
        expect(lost.calls[0]).toMatchObject({
            outcome: 'lost-answer',
            appStatus: 200,
        });
        expect(JSON.parse(lost.calls[0].appBody!)).toEqual({
            status: 'accepted',
        });
        expect(JSON.parse(lost.calls[1].appBody!)).toEqual({
            status: 'duplicate',
        });
        // The very same delivery: the ids and the bytes of the first attempt (a retry is not a new delivery).
        expect(lost.calls[1].headers['x-openwa-idempotency-key']).toBe(
            lost.calls[0].headers['x-openwa-idempotency-key'],
        );
        expect(lost.calls[1].headers['x-openwa-delivery-id']).toBe(
            lost.calls[0].headers['x-openwa-delivery-id'],
        );
        expect(lost.calls[1].headers['x-openwa-retry-count']).toBe('1');
        expect(lost.calls[1].raw).toBe(lost.calls[0].raw);
        expect(await transcript(wa, chatA)).toHaveLength(1);
        expect(
            data<{ chat: WaChat }>(await wa.chat(chatA.ulid), 'read').chat
                .unreadByAdmin,
        ).toBe(1);

        const attempts = (await openWa.deliveries()).filter((attempt) =>
            attempt.idempotencyKey.includes(sentA.messageId),
        );

        expect(
            attempts.map((attempt) => [attempt.retryCount, attempt.status]),
        ).toEqual([
            [0, 500],
            [1, 200],
        ]);

        // 2. The app never sees the first two attempts: the third one is processed, once.
        await openWa.api(
            'DELETE',
            `/api/sessions/${mock.id}/webhooks/${hookA.body.id}`,
        );

        const hookB = await openWa.api(
            'POST',
            `/api/sessions/${mock.id}/webhooks`,
            {
                body: {
                    url: missing.url,
                    events: ['message.received'],
                    secret,
                    retryCount: 3,
                },
            },
        );

        expect(hookB.status).toBe(201);

        const second = uniquePhone();

        await openWa.inboundText(
            session.name,
            second,
            'Two attempts never arrived',
        );

        const chatB = await waitForChat(wa, session, second);

        await eventually(
            async () =>
                missing.calls.length >= 3 && missing.calls[2].appBody !== null
                    ? missing.calls
                    : undefined,
            'the third attempt to be answered',
        );
        expect(missing.calls.map((call) => call.outcome)).toEqual([
            'unreachable',
            'unreachable',
            'passed',
        ]);
        expect(JSON.parse(missing.calls[2].appBody!)).toEqual({
            status: 'accepted',
        });
        expect(
            new Set(
                missing.calls.map(
                    (call) => call.headers['x-openwa-idempotency-key'],
                ),
            ).size,
        ).toBe(1);
        expect(await transcript(wa, chatB)).toHaveLength(1);

        const ledger = await readLedger(instance, session.ulid);

        expect(
            ledger
                .filter((row) => row.event === 'message.received')
                .every((row) => row.outcome === 'processed'),
        ).toBe(true);
    } finally {
        await lost.close();
        await missing.close();
    }
});

test('session events that arrive together and in any order leave the status OpenWA raised last', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const secret = await readWebhookSecret(instance, session.ulid);
    const mock = (await openWa.state()).sessions.find(
        (candidate) => candidate.name === session.name,
    )!;
    const hook = new WebhookClient(request, instance, session.ulid, secret);
    const base = Date.now() + 60_000;
    const failures: string[] = [];

    for (let round = 0; round < 25; round += 1) {
        const at = (offset: number) =>
            new Date(base + round * 10_000 + offset).toISOString();
        const event = (status: string, offset: number) =>
            envelope(
                mock.id,
                'session.status',
                { sessionId: mock.id, status },
                { timestamp: at(offset) },
            );
        // Oldest first on the clock of OpenWA, newest last; sent all at once, in a different order every round.
        const sent = [
            event('qr_ready', 1_000),
            event('initializing', 2_000),
            event('ready', 3_000),
        ];
        const order = round % 2 === 0 ? sent : [...sent].reverse();

        await Promise.all(
            order.map((one) =>
                hook.send(one, { address: `198.51.100.${1 + (round % 200)}` }),
            ),
        );

        const status = await eventually(async () => {
            const current = data<WaSession>(
                await wa.session(session.ulid),
                'read',
            );

            return current.status;
        }, 'a status');

        // Give the slowest of the three a moment to land: the answer must not change afterwards.
        await new Promise((done) => setTimeout(done, 120));

        const settled = data<WaSession>(
            await wa.session(session.ulid),
            'read',
        ).status;

        if (settled !== 'ready') {
            failures.push(`round ${round}: ${status} -> ${settled}`);
        }
    }

    expect(failures, 'the newest event (ready) must win every round').toEqual(
        [],
    );
});

test('a burst of messages from one customer keeps its order, and many customers at once each get their own chat once', async ({
    actors,
    openWa,
    wa,
}) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const total = 40;
    const label = (index: number) => `Burst ${String(index).padStart(2, '0')}`;
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    // One customer, forty messages sent back to back; the page is open on the chat while they arrive.
    await openWa.inboundText(session.name, customer, label(1), {
        pushName: 'Burt Burst',
    });

    const chat = await waitForChat(wa, session, customer);

    await inbox.goto(chat.ulid);

    for (let index = 2; index <= total; index += 1) {
        await openWa.inboundText(session.name, customer, label(index), {
            pushName: 'Burt Burst',
        });
    }

    await waitForMessage(
        wa,
        chat,
        (message) => message.body === label(total),
        'the last message',
    );
    await expect(inbox.bubble(label(total))).toBeVisible();
    expect((await transcript(wa, chat)).map((message) => message.body)).toEqual(
        Array.from({ length: total }, (_, index) => label(index + 1)),
    );

    const shown = await admin.page
        .getByTestId('wa-transcript')
        .locator('li[data-testid^="wa-message-"]')
        .allInnerTexts();

    expect(shown.map((text) => text.split('\n')[0])).toEqual(
        Array.from({ length: total }, (_, index) => label(index + 1)),
    );
    // Read while open: nothing left unread.
    await eventually(
        async () =>
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .unreadByAdmin === 0 || undefined,
        'the open chat to be read',
    );

    // Many customers at the same moment: one chat each, five messages each, all in order.
    const crowd = Array.from({ length: 12 }, () => uniquePhone());

    await Promise.all(
        crowd.map(async (number, who) => {
            for (let index = 1; index <= 5; index += 1) {
                await openWa.inboundText(
                    session.name,
                    number,
                    `Crowd ${who}-${index}`,
                    { pushName: `Crowd ${who}` },
                );
            }
        }),
    );

    for (const [who, number] of crowd.entries()) {
        const found = await waitForChat(wa, session, number);

        await waitForMessage(
            wa,
            found,
            (message) => message.body === `Crowd ${who}-5`,
        );
        expect(
            (await transcript(wa, found)).map((message) => message.body),
        ).toEqual(
            Array.from(
                { length: 5 },
                (_, index) => `Crowd ${who}-${index + 1}`,
            ),
        );
        expect(
            data<{ chat: WaChat }>(await wa.chat(found.ulid), 'read').chat
                .unreadByAdmin,
        ).toBe(5);
    }

    expect(
        data<WaChat[]>(
            await wa.chats({ session: session.ulid, limit: '100' }),
            'list',
        ),
    ).toHaveLength(13);
});

test('two administrator tabs stay in step: a message, a read, a reply and an archive show up in the other tab without a reload', async ({
    actors,
    openWa,
    wa,
}, testInfo) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundText(
        session.name,
        customer,
        'Hello from the customer',
        { pushName: 'Tessa Tabs' },
    );

    const chat = await waitForChat(wa, session, customer);
    const left = await actors.staff('admin');
    const right = await actors.staff('admin');
    const first = new WaInboxPage(left.page);
    const second = new WaInboxPage(right.page);
    const phone = testInfo.project.name === 'mobile';

    // Tab one watches the list, tab two reads the chat.
    await first.goto();
    await second.goto();
    await expect(first.unread(chat.ulid)).toHaveText(/1/);
    await expect(second.unread(chat.ulid)).toHaveText(/1/);
    await second.row(chat.ulid).click();
    await expect(right.page.getByTestId('wa-chat-view')).toBeVisible();
    // Reading in tab two clears the badge in tab one.
    await expect(first.unread(chat.ulid)).toHaveCount(0);

    // A reply from tab two appears in tab one's chat (open it there).
    await first.row(chat.ulid).click();
    await expect(left.page.getByTestId('wa-chat-view')).toBeVisible();
    await second.reply('Answered in the second tab');
    await expect(first.bubble('Answered in the second tab')).toBeVisible();
    await expect(first.bubble('Answered in the second tab')).toHaveAttribute(
        'data-direction',
        'out',
    );

    // A new customer message reaches both, and both mark it read: no unread is left anywhere.
    await openWa.inboundText(session.name, customer, 'One more thing', {
        pushName: 'Tessa Tabs',
    });
    await expect(first.bubble('One more thing')).toBeVisible();
    await expect(second.bubble('One more thing')).toBeVisible();
    await eventually(
        async () =>
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .unreadByAdmin === 0 || undefined,
        'both tabs to have read it',
    );

    // Archiving in one tab is the other tab's news too.
    await left.page.getByTestId('wa-archive').click();
    await expect(left.page.getByTestId('wa-chat-archived')).toBeVisible();
    await expect(right.page.getByTestId('wa-chat-archived')).toBeVisible();
    await expect(right.page.getByTestId('wa-chat-view')).toHaveAttribute(
        'data-status',
        'archived',
    );

    if (!phone) {
        await expect(second.row(chat.ulid)).toHaveCount(0);
    }
});
