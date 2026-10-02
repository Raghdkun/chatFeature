import {
    expect,
    readySession,
    settleSettings,
    test,
    transcript,
    uniquePhone,
    waitForChat,
    waitForMessage,
    type TestSession,
} from '../support/wa-test';
import type { OpenWaMock } from '../support/openwa';
import { WaInboxPage } from '../support/wa-ui';
import { data, eventually, type WaChat } from '../support/whatsapp';

/**
 * Replying from the dashboard, end to end: the composer, the optimistic bubble, the call the app makes at OpenWA (the mock's request log), the
 * ticks that follow as signed `message.ack` webhooks arrive (fired from the mock's control API: this suite has no phone), and every way a
 * reply can be refused or fail. Each test has its own session and customer (shared mode) except the ones that change a global setting.
 *
 * About the `sync` queue of the e2e instances: the send job cannot hand itself back to a queue, so where production would retry later (the plain
 * throttler 429, a 409 "not connected", a gateway that is down) the job fails the message at once with the reason, and where it would wait for
 * the pacing slot it sleeps (`SendPacer`). The specs assert what the sync queue does; the retry rules themselves are unit-tested
 * (`tests/Feature/WhatsApp`).
 */
test.use({ scenario: 'p6-wa' });

/** A ready session with a customer who wrote first, and the chat as the administrator's list shows it. */
async function conversation(
    wa: Parameters<typeof readySession>[0],
    openWa: OpenWaMock,
    options: Parameters<typeof readySession>[2] = {},
): Promise<{
    session: TestSession;
    customer: string;
    chat: WaChat;
    mockId: string;
}> {
    const session = await readySession(wa, openWa, options);
    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, 'Hi, is anybody there?', {
        pushName: 'Carla Customer',
    });

    const chat = await waitForChat(wa, session, customer);
    const mock = (await openWa.state()).sessions.find(
        (candidate) => candidate.name === session.name,
    )!;

    return { session, customer, chat, mockId: mock.id };
}

const sends = (openWa: OpenWaMock, mockId: string) =>
    openWa.requests({
        method: 'POST',
        path: `/api/sessions/${mockId}/messages/send-text`,
    });

test('a reply goes pending, sent, delivered and read as OpenWA reports it, and the echo of the send is not a second message', async ({
    actors,
    openWa,
    wa,
}) => {
    const { session, chat, customer, mockId } = await conversation(wa, openWa);

    // This session's acks come only from the spec (the others keep the automatic ones).
    await openWa.sessionAcks(session.name, { mode: 'manual' });

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    // Hold the reply's HTTP request so the optimistic bubble can be seen while it is still being sent.
    let release!: () => void;
    const gate = new Promise<void>((done) => (release = done));

    await admin.page.route(
        '**/api/v1/whatsapp/chats/*/messages',
        async (route) => {
            if (route.request().method() === 'POST') {
                await gate;
            }

            await route.continue();
        },
    );

    await inbox.reply('Hello Carla, I am on it.');

    const bubble = inbox.bubble('Hello Carla, I am on it.');

    await expect(bubble).toBeVisible();
    await expect(bubble).toHaveAttribute('data-status', 'pending');
    await expect(bubble).toHaveAttribute('data-direction', 'out');
    await expect(inbox.composer).toHaveValue('');
    release();

    // The call at OpenWA: the right chat id, the exact text, the configured key; 201 = accepted, not delivered.
    const call = await openWa.waitForRequest((request) =>
        request.path.includes(`/${mockId}/messages/send-text`),
    );

    expect(call.body).toEqual({
        chatId: `${customer}@c.us`,
        text: 'Hello Carla, I am on it.',
    });
    expect(call.apiKey).toBe(openWa.apiKey);
    expect(call.status).toBe(201);

    const messageId = (call.response as { messageId: string }).messageId;

    await expect(bubble).toHaveAttribute('data-status', 'sent');

    // The ticks follow the acks, forward only: delivered, read; a late `sent` and a repeated `delivered` change nothing.
    await openWa.ack(session.name, messageId, 'delivered');
    await expect(bubble).toHaveAttribute('data-status', 'delivered');
    await openWa.ack(session.name, messageId, 'read');
    await expect(bubble).toHaveAttribute('data-status', 'read');
    await openWa.ack(session.name, messageId, 'sent');
    await openWa.ack(session.name, messageId, 'delivered');
    await openWa.ack(session.name, 'true_unknown@c.us_DOESNOTEXIST', 'read');

    // The late acks were answered (200) and applied nowhere: wait for them to have been delivered, then look.
    await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.ack' &&
            attempt.rawBody.includes('DOESNOTEXIST') &&
            attempt.status === 200,
    );
    await expect(bubble).toHaveAttribute('data-status', 'read');

    // One outgoing message, however many things OpenWA said about it (the `message.sent` echo became this very row).
    const rows = await transcript(wa, chat);

    expect(rows.filter((row) => row.direction === 'out')).toHaveLength(1);
    expect(rows.find((row) => row.direction === 'out')).toMatchObject({
        status: 'read',
        body: 'Hello Carla, I am on it.',
    });
    expect((await sends(openWa, mockId)).length).toBe(1);
});

test('an ack that says failed shows the reason under the bubble; a delivered message cannot fail afterwards', async ({
    actors,
    openWa,
    wa,
}) => {
    const { session, chat, mockId } = await conversation(wa, openWa);

    await openWa.sessionAcks(session.name, { mode: 'manual' });

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await inbox.reply('This one will not arrive');

    const first = await openWa.waitForRequest((request) =>
        request.path.includes(`/${mockId}/messages/send-text`),
    );
    const failing = (first.response as { messageId: string }).messageId;

    await expect(inbox.bubble('This one will not arrive')).toHaveAttribute(
        'data-status',
        'sent',
    );
    await openWa.ack(session.name, failing, 'failed');
    await expect(inbox.bubble('This one will not arrive')).toHaveAttribute(
        'data-status',
        'failed',
    );

    const failure = admin.page.getByTestId(/^wa-message-failure-/);

    await expect(failure).toContainText('Not delivered');

    const stored = await waitForMessage(
        wa,
        chat,
        (row) =>
            row.body === 'This one will not arrive' && row.status === 'failed',
    );

    expect(stored.direction).toBe('out');

    // A message that was delivered is not turned into a failure by a stray late ack.
    await inbox.reply('And this one did');

    const second = await openWa.waitForRequest(
        (request) =>
            request.path.includes(`/${mockId}/messages/send-text`) &&
            request.n > first.n,
    );
    const delivered = (second.response as { messageId: string }).messageId;

    await openWa.ack(session.name, delivered, 'delivered');
    await expect(inbox.bubble('And this one did')).toHaveAttribute(
        'data-status',
        'delivered',
    );
    await openWa.ack(session.name, delivered, 'failed');
    await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.failed' &&
            attempt.rawBody.includes(delivered) &&
            attempt.status === 200,
    );
    await expect(inbox.bubble('And this one did')).toHaveAttribute(
        'data-status',
        'delivered',
    );
});

test('the composer: Enter sends, Shift+Enter breaks the line, blank is not sent, the counter and the limit, and a double click is one message', async ({
    actors,
    openWa,
    wa,
}) => {
    const { chat, mockId, customer } = await conversation(wa, openWa);
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    // Nothing to send: the button is off, Enter does nothing.
    await expect(inbox.send).toBeDisabled();
    await inbox.composer.fill('   ');
    await expect(inbox.send).toBeDisabled();
    await inbox.composer.press('Enter');
    expect((await sends(openWa, mockId)).length).toBe(0);

    // Shift+Enter is a new line in the same message.
    await inbox.composer.fill('First line');
    await inbox.composer.press('Shift+Enter');
    await inbox.composer.pressSequentially('Second line');
    await expect(inbox.composer).toHaveValue('First line\nSecond line');
    await expect(admin.page.getByTestId('wa-composer-count')).toContainText(
        '22 / 4096',
    );
    await inbox.composer.press('Enter');
    await expect(inbox.composer).toHaveValue('');

    const call = await openWa.waitForRequest((request) =>
        request.path.includes(`/${mockId}/messages/send-text`),
    );

    expect(call.body).toEqual({
        chatId: `${customer}@c.us`,
        text: 'First line\nSecond line',
    });
    await expect(inbox.bubble('Second line')).toBeVisible();

    // The box stops at the limit.
    await inbox.composer.fill('x'.repeat(4200));
    expect((await inbox.composer.inputValue()).length).toBe(4096);
    await inbox.composer.fill('');

    // The API refuses what the box would not let through, and a repeated `client_msg_id` is the same message (200 and the original), sent once.
    const tooLong = await wa.reply(chat.ulid, 'y'.repeat(4097));

    expect(tooLong.status).toBe(422);
    expect(tooLong.error?.details).toHaveProperty('body');
    expect((await wa.reply(chat.ulid, '   ')).status).toBe(422);

    const key = '01JZ0000000000000000000001';
    const once = await wa.reply(chat.ulid, 'Exactly once', key);
    const twice = await wa.reply(chat.ulid, 'Exactly once', key);

    expect(once.status).toBe(201);
    expect(twice.status).toBe(200);
    expect(twice.data.ulid).toBe(once.data.ulid);
    expect(
        (await sends(openWa, mockId)).filter(
            (request) =>
                (request.body as { text: string }).text === 'Exactly once',
        ),
    ).toHaveLength(1);
    expect(
        (await transcript(wa, chat)).filter(
            (row) => row.body === 'Exactly once',
        ),
    ).toHaveLength(1);
});

test('what customers and administrators type is shown as text: markup stays markup, only https links become links', async ({
    actors,
    openWa,
    wa,
}) => {
    const { session, chat, customer } = await conversation(wa, openWa);

    await openWa.inboundText(
        session.name,
        customer,
        '<img src=x onerror=alert(1)> <script>alert(2)</script> see https://example.com/page?a=1 and javascript:alert(3) and http://127.0.0.1:1/x',
        { pushName: 'Carla Customer' },
    );

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    const bubble = inbox.bubble('see https://example.com/page');

    await expect(bubble).toBeVisible();
    await expect(bubble).toContainText(
        '<img src=x onerror=alert(1)> <script>alert(2)</script>',
    );
    await expect(bubble.locator('img, script')).toHaveCount(0);

    const links = bubble.locator('a');

    await expect(links.first()).toHaveAttribute(
        'href',
        'https://example.com/page?a=1',
    );
    await expect(links.first()).toHaveAttribute('rel', /noopener/);
    await expect(links.first()).toHaveAttribute('target', '_blank');
    expect(
        await links.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('href')),
        ),
    ).not.toContain('javascript:alert(3)');

    // An administrator's own markup goes out as typed (and is shown as typed).
    await inbox.reply('<b>bold?</b> no');
    await expect(inbox.bubble('<b>bold?</b> no')).toBeVisible();
    await expect(inbox.bubble('<b>bold?</b> no').locator('b')).toHaveCount(0);
});

test('while the number is not connected the box is replaced by the reason, the API refuses with session_not_ready, and the box comes back with the connection', async ({
    actors,
    openWa,
    wa,
}) => {
    const { session, chat } = await conversation(wa, openWa);
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await expect(inbox.composer).toBeVisible();

    // The phone is unlinked: the status webhook reaches the open page.
    await openWa.setStatus(session.name, 'disconnected', { reason: 'LOGOUT' });

    const reason = admin.page.getByTestId('wa-composer-disabled');

    await expect(reason).toHaveAttribute('data-reason', 'session_not_ready');
    await expect(reason).toContainText(
        'This WhatsApp session is not connected, so replies cannot be sent.',
    );
    await expect(
        reason.getByRole('link', { name: 'Open WhatsApp settings' }),
    ).toHaveAttribute('href', '/settings/whatsapp');
    await expect(inbox.composer).toHaveCount(0);

    const refused = await wa.reply(chat.ulid, 'Still there?');

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('session_not_ready');
    expect(refused.error?.details).toMatchObject({ status: 'disconnected' });

    // Reconnected: the box returns without a reload, and a reply goes out.
    await openWa.connect(session.name, session.phone);
    await expect(inbox.composer).toBeVisible();
    await inbox.reply('Back again');
    await expect(inbox.bubble('Back again')).toHaveAttribute(
        'data-status',
        /sent|delivered/,
    );
});

test("the session's daily cap refuses the next reply with 429 until midnight UTC, the box pauses, and a failed send gives its slot back", async ({
    actors,
    openWa,
    wa,
}) => {
    const { session, chat, mockId } = await conversation(wa, openWa, {
        cap: 2,
    });

    expect((await wa.reply(chat.ulid, 'One of two')).status).toBe(201);
    expect((await wa.reply(chat.ulid, 'Two of two')).status).toBe(201);

    // The API: 429 with the cap, the seconds to midnight, and the header.
    const over = await wa.reply(chat.ulid, 'Three of two');

    expect(over.status).toBe(429);
    expect(over.error?.code).toBe('daily_cap_reached');
    expect(over.error?.details).toMatchObject({ cap: 2 });
    expect(Number(over.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(over.headers['retry-after'])).toBeLessThanOrEqual(86_400);
    expect((await sends(openWa, mockId)).length).toBe(2);
    expect(
        (await transcript(wa, chat)).filter((row) => row.direction === 'out'),
    ).toHaveLength(2);

    // The page: the refused reply stays visible as a failed bubble with its reason, and the box waits.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await inbox.reply('Three of two');
    await expect(inbox.bubble('Three of two')).toHaveAttribute(
        'data-status',
        'failed',
    );
    await expect(
        admin.page.getByText('Not sent: the daily sending limit is reached.'),
    ).toBeVisible();
    await expect(admin.page.getByTestId('wa-composer-paused')).toContainText(
        'Sending is paused to protect the number.',
    );

    // A send that OpenWA refuses gives its slot back: with the cap raised to 3, one failed send and one good one still fit.
    data(
        await wa.updateSession(session.ulid, { daily_send_cap: 3 }),
        'raise the cap',
    );
    await openWa.script({
        method: 'POST',
        path: `/api/sessions/${mockId}/messages/send-text`,
        status: 400,
        body: { statusCode: 400, message: 'Bad Request' },
    });

    const failed = await wa.reply(chat.ulid, 'Refused at OpenWA');

    expect(failed.status).toBe(201);
    await waitForMessage(
        wa,
        chat,
        (row) => row.body === 'Refused at OpenWA' && row.status === 'failed',
    );
    expect((await wa.reply(chat.ulid, 'Fits after the failure')).status).toBe(
        201,
    );
    expect((await wa.reply(chat.ulid, 'One too many')).error?.code).toBe(
        'daily_cap_reached',
    );
});

test("the session's minimum interval makes a quick second reply wait for its slot (the send job sleeps on the sync queue), and the order is kept", async ({
    openWa,
    wa,
}) => {
    const { chat, mockId } = await conversation(wa, openWa, { interval: 2500 });

    const startedAt = Date.now();
    const first = await wa.reply(chat.ulid, 'Pace one');
    const second = await wa.reply(chat.ulid, 'Pace two');
    const waited = Date.now() - startedAt;

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);

    const calls = await sends(openWa, mockId);

    expect(calls.map((call) => (call.body as { text: string }).text)).toEqual([
        'Pace one',
        'Pace two',
    ]);
    // Two sends in a row cannot be closer than the interval at OpenWA, and the second request really waited for it.
    expect(
        Date.parse(calls[1].at) - Date.parse(calls[0].at),
    ).toBeGreaterThanOrEqual(2300);
    expect(waited).toBeGreaterThanOrEqual(2300);
    expect(
        (await transcript(wa, chat))
            .filter((row) => row.direction === 'out')
            .every((row) => row.status !== 'failed'),
    ).toBe(true);
});

test.describe('when OpenWA refuses or cannot be reached', () => {
    const refusals: [string, { status: number; body: unknown }, RegExp][] = [
        [
            'its own sending limit (SEND_PACING_LIMITED, an hour to wait)',
            {
                status: 429,
                body: {
                    statusCode: 429,
                    error: 'Too Many Requests',
                    message: 'Daily allowance of 5 new conversation(s) reached',
                    code: 'SEND_PACING_LIMITED',
                    retryAfterSeconds: 3600,
                },
            },
            /WhatsApp's own sending limit applies to this number .* Try again in about 60 minutes/i,
        ],
        [
            'a 409 "not connected" (on a queue it is retried; the sync queue cannot, so it fails with the reason)',
            {
                status: 409,
                body: {
                    statusCode: 409,
                    error: 'Conflict',
                    message:
                        'Session is not connected. The WhatsApp client is not ready.',
                },
            },
            /^OpenWA refused the request: Session is not connected\./,
        ],
        [
            'a 400 "session is not active" (OpenWA has no engine for the number)',
            {
                status: 400,
                body: {
                    statusCode: 400,
                    error: 'Bad Request',
                    message:
                        "Session 'x' is not active. Start the session first.",
                },
            },
            /no running engine for this number/i,
        ],
        [
            'a gateway error (502)',
            { status: 502, body: { message: 'Bad gateway' } },
            /^OpenWA could not be reached \(OpenWA answered HTTP 502\.\)$/,
        ],
        [
            "the plain throttler's 429 (clears in seconds; retried on a queue, failed on the sync one)",
            {
                status: 429,
                body: {
                    statusCode: 429,
                    error: 'Too Many Requests',
                    message: 'ThrottlerException: Too Many Requests',
                },
            },
            /^OpenWA refused the request: ThrottlerException: Too Many Requests$/,
        ],
    ];

    for (const [label, answer, reason] of refusals) {
        test(`${label}: the reply fails with its reason, nothing is lost, and the next reply works`, async ({
            actors,
            openWa,
            wa,
        }) => {
            const { chat, mockId } = await conversation(wa, openWa);
            const admin = await actors.staff('admin');
            const inbox = new WaInboxPage(admin.page);
            const text = `Refused: ${label.slice(0, 20)}`;

            await inbox.goto(chat.ulid);
            await openWa.script({
                method: 'POST',
                path: `/api/sessions/${mockId}/messages/send-text`,
                ...answer,
            });
            await inbox.reply(text);

            const stored = await waitForMessage(
                wa,
                chat,
                (row) => row.body === text && row.status === 'failed',
                'the reply to be marked failed',
            );

            expect(stored.error ?? '').toMatch(reason);
            await expect(inbox.bubble(text)).toHaveAttribute(
                'data-status',
                'failed',
            );
            await expect(
                admin.page.getByTestId(`wa-message-failure-${stored.ulid}`),
            ).toContainText('Not delivered');
            await expect(
                admin.page.getByTestId(`wa-message-failure-${stored.ulid}`),
            ).toContainText(stored.error!.slice(0, 20));

            // The failure is only about that message: the number is not blocked, the next one goes out.
            await inbox.reply('And now it works');
            await expect(inbox.bubble('And now it works')).toHaveAttribute(
                'data-status',
                /sent|delivered/,
            );
        });
    }
});

test.describe('replies to chats the customer did not start', () => {
    test.use({ waMode: 'exclusive' });

    test('are allowed when the protection is switched off, and the same box then works', async ({
        actors,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        const customer = uniquePhone();

        await openWa.inboundFromMe(
            session.name,
            customer,
            'Hello from the phone first',
        );

        const chat = await waitForChat(wa, session, customer);

        expect(chat.inboundInitiated).toBe(false);
        expect(
            (await wa.reply(chat.ulid, 'Refused while the protection is on'))
                .error?.code,
        ).toBe('reply_not_allowed');

        data(
            await wa.saveSettings({ reply_only_to_inbound: false }),
            'switch the protection off',
        );
        await settleSettings();

        const admin = await actors.staff('admin');
        const inbox = new WaInboxPage(admin.page);

        await inbox.goto(chat.ulid);
        await expect(inbox.composer).toBeVisible();
        await inbox.reply('Allowed now');
        await expect(inbox.bubble('Allowed now')).toHaveAttribute(
            'data-status',
            /sent|delivered/,
        );
        await eventually(
            async () =>
                (await transcript(wa, chat)).some(
                    (row) =>
                        row.body === 'Allowed now' && row.status !== 'failed',
                ) || undefined,
            'the reply',
        );

        // The customer answering a conversation the phone started does not make it "customer started": the flag is set when the chat is created.
        await openWa.inboundText(
            session.name,
            customer,
            'Oh hi, thanks for writing',
        );
        await eventually(
            async () => (await transcript(wa, chat)).length === 3 || undefined,
            'the answer',
        );
        expect(
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .inboundInitiated,
        ).toBe(false);
    });
});
