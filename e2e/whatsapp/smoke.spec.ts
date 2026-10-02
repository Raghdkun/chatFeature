import { expect, test } from '../support/wa-test';
import { createWidget } from '../support/api';
import { VisitorApi } from '../support/chat-api';
import { P4_CATEGORIES } from '../support/users';
import {
    data,
    eventually,
    WaAdminApi,
    type WaChat,
    type WaMessage,
    type WaSession,
} from '../support/whatsapp';

/**
 * The smoke test of P6 (WhatsApp via OpenWA), end to end against the stateful OpenWA mock (`e2e/support/openwa-mock.mjs`, started by
 * Playwright next to the app; the seed pointed the app at it): the administrator creates and starts a session, the mock moves it to
 * `ready` and signs its webhooks the way OpenWA does, a visitor on the customer site asks for a WhatsApp hand-off, the customer's first
 * WhatsApp message with the code arrives through the mock and links the chat to the widget and the visitor, the administrator replies from
 * the inbox, the mock acks it, and an agent is refused everywhere.
 *
 * STATUS: `test.fixme('needs 6A+6B merged')`. It is written against the documented API of track 6A (`docs/rest-api.md`, "WhatsApp API
 * (P6)", every path in `e2e/support/whatsapp.ts`) and the documented UI test ids of track 6B (`wa-composer-input`, `wa-composer-send`,
 * `wa-transcript`, `wa-message-<ulid>`); neither exists on the branch this file was written on. When 6A and 6B are merged: remove the
 * `.fixme`, run `E2E_ONLY=p6-wa npx playwright test e2e/whatsapp`, and fix whatever the real routes / test ids say differently.
 */
test.use({ scenario: 'p6-wa' });

test("a customer's WhatsApp message with the hand-off code is linked, answered and acked; agents see nothing", async ({
    actors,
    adminApi,
    instance,
    openWa,
}) => {
    const wa = new WaAdminApi(adminApi);
    const name = `support-${Date.now().toString(36)}`;

    // 1. The administrator creates a session and starts it: the app creates it at OpenWA, registers ONE webhook (secret write-only) and
    //    starts the engine; the mock answers `qr_ready` and the app shows a QR.
    const created = data<WaSession>(
        await wa.createSession(name),
        'create the session',
    );

    expect(created.status).toBe('created');
    const mockSession = await openWa.waitForSession(name);

    expect((await wa.startSession(created.ulid)).status).toBe(202);

    const hooks = await eventually(async () => {
        const found = await openWa.webhooksOf(name);

        return found.length > 0 ? found : undefined;
    }, 'the webhook registration');

    expect(hooks).toHaveLength(1);
    expect(hooks[0].url).toBe(
        `${instance.url}/webhooks/openwa/${created.ulid}`,
    );
    expect(hooks[0].hasSecret).toBe(true);
    expect(hooks[0].events).toEqual(
        expect.arrayContaining([
            'message.received',
            'message.ack',
            'session.status',
        ]),
    );
    await eventually(
        async () =>
            (await wa.sessions()).data.find(
                (row: WaSession) => row.ulid === created.ulid,
            )?.status === 'qr' && true,
        'the session waiting for a scan',
    );
    expect(data(await wa.sessionQr(created.ulid), 'read the QR').qr).toMatch(
        /^data:image\/png;base64,/,
    );

    // 2. A phone scans the QR: the mock says `ready` (session.status + session.authenticated, signed). The app marks it ready and knows the number.
    await openWa.connect(name, '4915100000000', 'PNE Support');

    const ready = await eventually(async () => {
        const session = data<WaSession>(
            await wa.session(created.ulid),
            'read the session',
        );

        return session.status === 'ready' ? session : undefined;
    }, 'the session to become ready');

    // The administrator's own data carries the number (the page shows it masked until revealed): E.164 and a masked twin.
    expect(ready.phone).toBe('+4915100000000');
    expect(ready.maskedPhone).toBe('+49•••••••0000');

    // 3. A widget offers WhatsApp: linked to the ready session, `features.whatsapp` on, published.
    const widget = await createWidget(adminApi, {
        name: 'WhatsApp Storefront',
        domains: [`localhost:${instance.hostPort}`],
        categories: P4_CATEGORIES.map((category) => category.slug),
        settings: { offline_mode: 'always_online' },
        config: {
            hours: { mode: 'always_online' },
            greetings: { enabled: false },
            features: { whatsapp: true },
        },
    });

    expect((await wa.linkWidget(widget.ulid, created.ulid)).status).toBe(200);

    // 4. A visitor on the customer site asks for the hand-off: an 8-character code and a wa.me link for the connected number.
    const visitor = await VisitorApi.start(instance, {
        key: widget.key,
        visitor: { name: 'Vera Visitor' },
    });
    const handoff = await visitor.request(
        'POST',
        `/widgets/${widget.key}/whatsapp-handoff`,
        {
            category: 'billing',
        },
    );

    expect(handoff.status).toBe(201);
    expect(handoff.data.code).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/);
    expect(handoff.data.waUrl).toContain('https://wa.me/4915100000000?text=');
    expect(Object.keys(handoff.data).sort()).toEqual([
        'code',
        'expiresAt',
        'waUrl',
    ]);

    // 5. The customer sends the code from their phone. The mock delivers `message.received`, signed and with the idempotency headers; the app answers 200.
    const customer = '4915112345678';
    const sent = await openWa.inboundText(
        name,
        customer,
        `Hi! My support code is ${handoff.data.code}`,
        {
            pushName: 'Vera Visitor',
        },
    );
    const delivery = await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.received' &&
            attempt.idempotencyKey.includes(sent.messageId),
    );

    expect(delivery.status).toBe(200);
    expect(delivery.headers['X-OpenWA-Signature']).toMatch(
        /^sha256=[0-9a-f]{64}$/,
    );

    // 6. The chat exists, is linked to the widget, the visitor and the topic, and shows the message.
    const chat = await eventually(async () => {
        const rows = data<WaChat[]>(
            await wa.chats({ linked: '1' }),
            'list the linked chats',
        );

        return rows.find((row) => row.widget?.ulid === widget.ulid);
    }, 'the linked chat');

    expect(chat.linked).toBe(true);
    expect(chat.category?.slug).toBe('billing');
    expect(chat.inboundInitiated).toBe(true);
    expect(chat.unreadByAdmin).toBe(1);

    // 7. A replay of the very same delivery (the same idempotency key) changes nothing.
    const before = data<WaMessage[]>(
        await wa.messages(chat.ulid),
        'read the transcript',
    ).length;

    expect((await openWa.replay(delivery.n)).status).toBe(200);
    expect(
        data<WaMessage[]>(await wa.messages(chat.ulid), 'read the transcript'),
    ).toHaveLength(before);

    // ...and a delivery with a bad signature is refused with the same generic 401 and stores nothing.
    const forged = await openWa.deliver({
        session: name,
        event: 'message.received',
        data: {
            id: 'false_x@c.us_FORGED',
            from: `${customer}@c.us`,
            chatId: `${customer}@c.us`,
            body: 'forged',
            type: 'text',
            timestamp: 1790932530,
            fromMe: false,
            isGroup: false,
            kind: 'individual',
        },
        signature: 'bad',
    });

    expect(forged.results[0].status).toBe(401);
    expect(
        data<WaMessage[]>(await wa.messages(chat.ulid), 'read the transcript'),
    ).toHaveLength(before);

    // 8. The administrator replies from the inbox: the app calls send-text (201 = accepted), the message is `pending` then acked.
    const admin = await actors.staff('admin', {
        open: `/whatsapp/chats/${chat.ulid}`,
    });

    await expect(admin.page.getByTestId('wa-transcript')).toContainText(
        handoff.data.code,
    );
    await admin.page
        .getByTestId('wa-composer-input')
        .fill('Hi Vera, I am looking at it now.');
    await admin.page.getByTestId('wa-composer-send').click();

    const call = await openWa.waitForRequest(
        (request) =>
            request.path.endsWith('/messages/send-text') &&
            request.path.includes(`/${mockSession.id}/`),
    );

    expect(call.body).toMatchObject({
        chatId: `${customer}@c.us`,
        text: 'Hi Vera, I am looking at it now.',
    });
    expect(call.apiKey).toBe(openWa.apiKey);

    // The mock acks it (sent, then delivered) through signed webhooks; the row follows forward-only.
    const reply = await eventually(async () => {
        const rows = data<WaMessage[]>(
            await wa.messages(chat.ulid),
            'read the transcript',
        );

        return rows.find(
            (row) => row.direction === 'out' && row.status === 'delivered',
        );
    }, 'the reply to be delivered');

    expect(reply.body).toBe('Hi Vera, I am looking at it now.');

    // A late `read` ack from the phone moves it on; a stale `sent` after it cannot move it back (acks arrive late, twice, out of order).
    const messageId = (call.response as { messageId: string }).messageId;

    await openWa.ack(name, messageId, 'read');
    await eventually(
        async () =>
            data<WaMessage[]>(
                await wa.messages(chat.ulid),
                'read the transcript',
            ).find((row) => row.direction === 'out' && row.status === 'read'),
        'the reply to be read',
    );
    await openWa.ack(name, messageId, 'sent');

    const settled = await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.ack' &&
            attempt.rawBody.includes('"status":"sent"') &&
            attempt.retryCount === 0 &&
            attempt.n > delivery.n,
    );

    expect(settled.status).toBe(200);
    expect(
        data<WaMessage[]>(
            await wa.messages(chat.ulid),
            'read the transcript',
        ).find((row) => row.direction === 'out')?.status,
    ).toBe('read');

    // 9. An agent gets 403 on every WhatsApp route and page; a visitor token gets 401 (never a hint that WhatsApp exists).
    const alice = await actors.staff('alice', { presence: 'online' });
    const agent = new WaAdminApi(alice.api.api);

    for (const result of [
        await agent.sessions(),
        await agent.createSession('agent-session'),
        await agent.settings(),
        await agent.testSettings(),
        await agent.chats(),
        await agent.chat(chat.ulid),
        await agent.messages(chat.ulid),
        await agent.reply(chat.ulid, 'agents cannot reply'),
        await agent.exportChats(),
    ]) {
        expect(result.status).toBe(403);
    }

    expect((await alice.page.goto('/whatsapp'))?.status()).toBe(403);
    expect((await alice.page.goto('/settings/whatsapp'))?.status()).toBe(403);
    expect(
        (await visitor.request('GET', '/whatsapp/chats')).status,
    ).toBeGreaterThanOrEqual(401);

    await visitor.dispose();
});
