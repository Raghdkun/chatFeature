import { readAppLog } from '../support/staff-db';
import {
    expect,
    readySession,
    test,
    uniquePhone,
    waitForChat,
    transcript,
    type TestSession,
} from '../support/wa-test';
import {
    envelope,
    readLedger,
    readWebhookSecret,
    signature,
    textMessage,
    WebhookClient,
} from '../support/wa-webhook';
import { data, eventually, type WaSession } from '../support/whatsapp';

/**
 * The webhook at HTTP level, against the real server: `POST /webhooks/openwa/{session}` takes OpenWA's signed deliveries and nothing else.
 * The signatures come from the spec's own HMAC code (`e2e/support/wa-webhook.ts`: the exact bytes, the exact header) as well as from the
 * OpenWA mock, so a case the mock would never produce (a 1 MiB body, bytes that are not JSON, a header spelled wrongly, another session's secret)
 * is covered too. What the database knows (the ledger `wa_webhook_deliveries`, the session's secret) is read through tinker. Every test makes its
 * own session and its own customer numbers (shared mode); a client address of its own keeps a flood away from everybody else's deliveries.
 */
test.use({ scenario: 'p6-wa' });

let address = 10;

/** A client address (`X-Forwarded-For`, trusted by the scenario) that no other test of the run uses. */
const clientAddress = (): string => `198.51.100.${(address += 1) % 250}`;

async function webhookOf(
    session: TestSession,
    { request, instance, openWa }: Pick<any, 'request' | 'instance' | 'openWa'>,
) {
    const secret = await readWebhookSecret(instance, session.ulid);
    const mock = (await openWa.state()).sessions.find(
        (candidate: { name: string }) => candidate.name === session.name,
    );

    return {
        hook: new WebhookClient(request, instance, session.ulid, secret),
        secret,
        openWaId: mock.id as string,
    };
}

test('a signed delivery is accepted, processed once, and answered without cookies or caching', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const customer = uniquePhone();
    const message = envelope(
        openWaId,
        'message.received',
        textMessage(customer, 'Hello from my own HMAC'),
    );
    const answer = await hook.send(message, { address: clientAddress() });

    expect(answer.status).toBe(200);
    expect(answer.body).toEqual({ status: 'accepted' });
    expect(answer.headers['cache-control']).toContain('no-store');
    // Bearer-less, cookie-less, CSRF-less: no session is started for a machine call.
    expect(answer.headers['set-cookie']).toBeUndefined();

    const chat = await waitForChat(wa, session, customer);

    expect(chat.unreadByAdmin).toBe(1);
    expect(chat.inboundInitiated).toBe(true);
    expect(
        (await transcript(wa, chat)).map((row) => [row.direction, row.body]),
    ).toEqual([['in', 'Hello from my own HMAC']]);

    // The ledger says what happened to it.
    const ledger = await readLedger(instance, session.ulid);
    const row = ledger.find((entry) =>
        entry.key.includes(message.idempotencyKey),
    );

    expect(row).toMatchObject({
        event: 'message.received',
        outcome: 'processed',
    });

    // The mock's own delivery (its signature, its headers) is accepted the same way.
    const sent = await openWa.inboundText(
        session.name,
        customer,
        'And from the mock',
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
    await eventually(
        async () => (await transcript(wa, chat)).length === 2 || undefined,
        'the second message',
    );
});

test('every way of getting the signature wrong is the same generic 401 and stores nothing', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const other = await readySession(wa, openWa);
    const { hook, secret, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const otherSecret = await readWebhookSecret(instance, other.ulid);
    const customer = uniquePhone();
    const raw = JSON.stringify(
        envelope(openWaId, 'message.received', textMessage(customer, 'forged')),
    );
    const good = signature(secret, raw);
    const hex = good.slice('sha256='.length);
    const at = clientAddress();
    const before = (await readLedger(instance, session.ulid)).length;

    const cases: Record<string, { sign: boolean | string; body?: string }> = {
        'a header that is missing': { sign: false },
        'an empty header': { sign: '' },
        'a body touched after signing': { sign: good, body: `${raw} ` },
        'a body with one character changed': {
            sign: good,
            body: raw.replace('forged', 'forgeD'),
        },
        'another secret': {
            sign: signature('not-the-secret-0123456789abcdef', raw),
        },
        "another session's secret": { sign: signature(otherSecret, raw) },
        zeros: { sign: `sha256=${'0'.repeat(64)}` },
        'upper-case hex': { sign: `sha256=${hex.toUpperCase()}` },
        'a 63-character digest': { sign: `sha256=${hex.slice(1)}` },
        'a 65-character digest': { sign: `sha256=${hex}0` },
        'non-hex characters': { sign: `sha256=${'z'.repeat(64)}` },
        'no prefix': { sign: hex },
        'the wrong prefix (sha1)': { sign: `sha1=${hex}` },
        'a prefix in capitals': { sign: `SHA256=${hex}` },
        'a prefix with a space': { sign: `sha256 ${hex}` },
        'a doubled prefix': { sign: `sha256=sha256=${hex}` },
    };
    const answers: Record<string, string> = {};

    for (const [label, variant] of Object.entries(cases)) {
        const answer = await hook.post(variant.body ?? raw, {
            sign: variant.sign,
            address: at,
        });

        expect(answer.status, label).toBe(401);
        expect(answer.body?.error?.code, label).toBe('unauthenticated');
        expect(answer.headers['set-cookie'], label).toBeUndefined();
        answers[label] = answer.text;
    }

    // The refusals say nothing about WHY: one body for all of them.
    expect(new Set(Object.values(answers)).size).toBe(1);
    expect(Object.values(answers)[0]).not.toMatch(
        /sign|hmac|secret|hex|digest/i,
    );

    // Nothing was stored, queued or recorded as a chat; and the right signature still works afterwards.
    expect(await readLedger(instance, session.ulid)).toHaveLength(before);
    expect(
        data<unknown[]>(
            await wa.chats({
                session: session.ulid,
                q: customer,
                status: 'all',
            }),
            'list',
        ),
    ).toHaveLength(0);
    expect((await hook.post(raw, { address: at })).status).toBe(200);
    await waitForChat(wa, session, customer);
});

test('an unknown, malformed or deleted session answers 404 before anything is checked', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, secret, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const raw = JSON.stringify(
        envelope(openWaId, 'session.status', {
            sessionId: openWaId,
            status: 'ready',
        }),
    );
    const at = clientAddress();
    const base = `${instance.url}/webhooks/openwa`;

    // A well-formed ULID nobody owns, with a perfectly good signature.
    const unknown = await hook.post(raw, {
        url: `${base}/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
        address: at,
    });

    expect(unknown.status).toBe(404);

    // Not a ULID at all: not even routed.
    for (const path of [
        'not-a-ulid',
        '1',
        '01ARZ3NDEKTSV4RRFFQ69G5FA',
        '../sessions',
    ]) {
        expect(
            (await hook.post(raw, { url: `${base}/${path}`, address: at }))
                .status,
            path,
        ).toBe(404);
    }

    // Other methods are not offered.
    for (const method of ['get', 'put', 'delete', 'patch'] as const) {
        const answer = await request[method](hook.url, {
            failOnStatusCode: false,
            headers: { 'X-Forwarded-For': at },
        });

        expect(answer.status(), method).toBe(405);
    }

    // The session is deleted (soft delete: its chats stay readable): from then on its webhook is gone, whoever signs.
    expect((await hook.post(raw, { address: at })).status).toBe(200);
    expect((await wa.deleteSession(session.ulid)).status).toBe(204);
    expect((await hook.post(raw, { address: at })).status).toBe(404);
    expect(
        (await hook.post(raw, { sign: signature(secret, 'x'), address: at }))
            .status,
    ).toBe(404);
});

test('a repeat is a no-op: the same delivery, the same message under a new key, and the mock replaying a delivery', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const customer = uniquePhone();
    const message = textMessage(customer, 'Only once please');
    const first = envelope(openWaId, 'message.received', message);
    const at = clientAddress();

    expect((await hook.send(first, { address: at })).body).toEqual({
        status: 'accepted',
    });

    const chat = await waitForChat(wa, session, customer);

    // The same key again (OpenWA's own retry): a quiet `duplicate`, one message.
    expect((await hook.send(first, { address: at })).body).toEqual({
        status: 'duplicate',
    });
    expect((await hook.send(first, { address: at })).status).toBe(200);
    expect(await transcript(wa, chat)).toHaveLength(1);

    // The same WhatsApp message under a NEW key (the webhook was re-registered, so every key changed): accepted by the ledger, recognised as the
    // message it already is, still ONE message and the unread counter did not move.
    const again = envelope(openWaId, 'message.received', message);

    expect((await hook.send(again, { address: at })).body).toEqual({
        status: 'accepted',
    });
    await eventually(async () => {
        const ledger = await readLedger(instance, session.ulid);
        const row = ledger.find((entry) =>
            entry.key.includes(again.idempotencyKey),
        );

        return row?.outcome === 'duplicate' ? row : undefined;
    }, 'the repeated message to be recognised');
    expect(await transcript(wa, chat)).toHaveLength(1);
    expect(
        data<{ chat: { unreadByAdmin: number } }>(
            await wa.chat(chat.ulid),
            'read',
        ).chat.unreadByAdmin,
    ).toBe(1);
    expect(data<WaSession>(await wa.session(session.ulid), 'read').status).toBe(
        'ready',
    );

    // The mock replays one of ITS deliveries (same idempotency key, new delivery id and bytes): 200, still one message per WhatsApp message.
    const sent = await openWa.inboundText(
        session.name,
        customer,
        'Replayed by OpenWA',
    );
    const delivery = await openWa.waitForDelivery(
        (attempt) =>
            attempt.event === 'message.received' &&
            attempt.idempotencyKey.includes(sent.messageId),
    );

    await eventually(
        async () => (await transcript(wa, chat)).length === 2 || undefined,
        'the mock message',
    );
    expect((await openWa.replay(delivery.n)).status).toBe(200);
    expect((await openWa.replay(delivery.n, true)).status).toBe(200);
    expect(await transcript(wa, chat)).toHaveLength(2);

    // Pinned message id across a webhook swap: the real "same message, new key" path through the mock.
    const pinned = `3EB0PIN${Date.now()}`;

    await openWa.inbound(session.name, {
        from: customer,
        body: 'Pinned',
        id: pinned,
    });
    await eventually(
        async () => (await transcript(wa, chat)).length === 3 || undefined,
        'the pinned message',
    );
    expect((await wa.reregisterWebhook(session.ulid)).status).toBe(200);
    await openWa.inbound(session.name, {
        from: customer,
        body: 'Pinned',
        id: pinned,
    });
    await openWa.waitForDelivery(
        (attempt) => attempt.rawBody.includes(pinned) && attempt.status === 200,
        { since: delivery.n + 3 },
    );
    expect(await transcript(wa, chat)).toHaveLength(3);
});

test('the body is capped at 1 MiB before the signature is even looked at', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const at = clientAddress();
    const limit = 1_048_576;
    const pad = (size: number): string => {
        const base = JSON.stringify(
            envelope(openWaId, 'presence.update', { filler: '' }),
        );

        return base.replace(
            '"filler":""',
            `"filler":"${'x'.repeat(size - base.length + 0)}"`,
        );
    };

    // Exactly the limit: processed (an event the app does not use, acknowledged and ignored).
    const exact = pad(limit);

    expect(Buffer.byteLength(exact)).toBe(limit);
    expect((await hook.post(exact, { address: at })).status).toBe(200);

    // One byte more: 413 with a signature that is valid, wrong, or absent: the size is judged before the HMAC has to chew the body.
    const over = pad(limit + 1);

    expect(Buffer.byteLength(over)).toBe(limit + 1);

    for (const sign of [true, false, `sha256=${'0'.repeat(64)}`] as const) {
        const answer = await hook.post(over, { sign, address: at });

        expect(answer.status, String(sign)).toBe(413);
        expect(answer.body?.error?.code).toBe('payload_too_large');
    }

    // Bytes that are not even JSON, far over the limit, from a client that does not sign at all.
    expect(
        (
            await hook.post(Buffer.alloc(limit * 2, 0x61), {
                sign: false,
                address: at,
            })
        ).status,
    ).toBe(413);
    // The session is none the worse: a normal delivery is processed.
    expect(
        (
            await hook.send(
                envelope(
                    openWaId,
                    'message.received',
                    textMessage(uniquePhone(), 'still fine'),
                ),
                { address: at },
            )
        ).status,
    ).toBe(200);
});

test('a signed body that is not usable is acknowledged and recorded as rejected or ignored, never retried into a loop', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const at = clientAddress();
    const customer = uniquePhone();
    const keys: Record<string, string> = {};
    const send = async (label: string, raw: string | Buffer) => {
        const key = `evt_${label}_${Date.now()}`;

        keys[label] = key;

        return hook.post(raw, { key, address: at });
    };

    // Not JSON, a JSON array, a scalar, nothing, and a nesting deeper than the parser accepts: `rejected` (200: OpenWA stops retrying).
    for (const [label, raw] of Object.entries({
        text: 'this is not json',
        list: '[1,2,3]',
        scalar: '"hello"',
        empty: '',
        deep: `${'['.repeat(200)}${']'.repeat(200)}`,
        binary: Buffer.from([0xff, 0xfe, 0x00, 0x01]) as unknown as string,
    })) {
        const answer = await send(label, raw);

        expect(answer.status, label).toBe(200);
        expect(answer.body, label).toEqual({ status: 'rejected' });
    }

    // Valid JSON the app does not use: accepted, then ignored. Unknown fields never fail a delivery.
    const unknownEvent = envelope(openWaId, 'group.update', {
        anything: [1, 2, { deep: true }],
    });

    unknownEvent.idempotencyKey = `evt_unknown_${Date.now()}`;
    expect((await hook.send(unknownEvent, { address: at })).body).toEqual({
        status: 'accepted',
    });

    // A delivery that names another OpenWA session than the URL's: ignored.
    const foreign = envelope(
        '00000000-0000-4000-8000-000000000000',
        'message.received',
        textMessage(customer, 'for somebody else'),
    );

    expect((await hook.send(foreign, { address: at })).status).toBe(200);

    // A message with unknown fields and no usable id: ignored; one with the right shape and extras: processed.
    const noId = envelope(openWaId, 'message.received', {
        from: `${customer}@c.us`,
        body: 'no id',
        brandNewField: { nested: true },
    });

    expect((await hook.send(noId, { address: at })).status).toBe(200);

    const extras = envelope(openWaId, 'message.received', {
        ...textMessage(customer, 'with extras'),
        futureField: [1, 2, 3],
        contact: { pushName: 'Extra Person', unknown: true },
    });

    expect((await hook.send(extras, { address: at })).status).toBe(200);

    const chat = await waitForChat(wa, session, customer);

    expect((await transcript(wa, chat)).map((row) => row.body)).toEqual([
        'with extras',
    ]);
    expect(chat.pushName).toBe('Extra Person');

    const ledger = await eventually(async () => {
        const rows = await readLedger(instance, session.ulid);

        return rows.every((row) => row.outcome !== null) ? rows : undefined;
    }, 'every delivery to have an outcome');
    const outcome = (key: string) =>
        ledger.find((row) => row.key.includes(key))?.outcome;

    for (const label of ['text', 'list', 'scalar', 'empty', 'deep', 'binary']) {
        expect(outcome(keys[label]), label).toBe('rejected');
    }

    expect(outcome(unknownEvent.idempotencyKey)).toBe('ignored');
    expect(outcome(foreign.idempotencyKey)).toBe('ignored');
    expect(outcome(noId.idempotencyKey)).toBe('ignored');
    expect(outcome(extras.idempotencyKey)).toBe('processed');
    expect(ledger.find((row) => row.key.includes(keys.text))?.error).toBe(
        'The body is not a JSON object.',
    );
});

test('session events are applied in the order OpenWA raised them, whatever order they arrive in', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const at = clientAddress();
    const now = Date.now();
    const status = (value: string, ahead: number) =>
        envelope(
            openWaId,
            'session.status',
            { sessionId: openWaId, status: value },
            { timestamp: new Date(now + ahead).toISOString() },
        );

    // The newer event arrives first and is applied; the older one (the delivery overtaken on the wire) must not undo it.
    expect(
        (await hook.send(status('disconnected', 10_000), { address: at }))
            .status,
    ).toBe(200);
    await eventually(async () => {
        const current = data<WaSession>(await wa.session(session.ulid), 'read');

        return current.status === 'disconnected' ? current : undefined;
    }, 'the newer event to be applied');
    expect(
        (await hook.send(status('ready', 5_000), { address: at })).status,
    ).toBe(200);

    const ledger = await eventually(async () => {
        const rows = await readLedger(instance, session.ulid);

        return rows.some((row) => row.outcome === 'ignored') ? rows : undefined;
    }, 'the older event to be ignored');
    const stale = ledger.filter((row) => row.outcome === 'ignored');

    expect(stale.length).toBeGreaterThanOrEqual(1);
    expect(stale.at(-1)?.error).toContain('Older than');
    expect(data<WaSession>(await wa.session(session.ulid), 'read').status).toBe(
        'disconnected',
    );
});

test('nothing secret ever leaves the application: not the webhook secret, not the API key, not in answers, pages or the log', async ({
    actors,
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, secret, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const at = clientAddress();
    const raw = JSON.stringify(
        envelope(
            openWaId,
            'message.received',
            textMessage(uniquePhone(), 'logging check'),
        ),
    );
    const seen: string[] = [];
    const bad = `sha256=${'a'.repeat(64)}`;

    // Answers of the webhook itself: accepted, refused, unknown, too large.
    for (const answer of [
        await hook.post(raw, { address: at }),
        await hook.post(raw, { sign: bad, address: at }),
        await hook.post(raw, { sign: false, address: at }),
        await hook.post(raw, {
            url: `${instance.url}/webhooks/openwa/01ARZ3NDEKTSV4RRFFQ69G5FAV`,
            address: at,
        }),
        await hook.post(Buffer.alloc(1_048_577, 0x61), {
            sign: bad,
            address: at,
        }),
    ]) {
        seen.push(answer.text, JSON.stringify(answer.headers));
    }

    // The management API.
    for (const result of [
        await wa.sessions(),
        await wa.session(session.ulid),
        await wa.settings(),
        await wa.reregisterWebhook(session.ulid),
        await wa.chats(),
    ]) {
        seen.push(JSON.stringify(result.body), JSON.stringify(result.headers));
    }

    // The pages (HTML and the Inertia props inside).
    const admin = await actors.staff('admin');

    for (const path of ['/settings/whatsapp', '/whatsapp']) {
        await admin.page.goto(path);
        await expect(
            admin.page.getByTestId(
                path === '/whatsapp' ? 'wa-inbox' : 'settings-whatsapp',
            ),
        ).toBeVisible();
        seen.push(await admin.page.content());
        seen.push(
            await admin.page.evaluate(
                () =>
                    document.getElementById('app')?.getAttribute('data-page') ??
                    '',
            ),
        );
    }

    const log = await readAppLog(instance);
    const haystack = seen.join('\n');

    // The secret was re-registered by the call above: the one we read first is gone, but it must not be anywhere either.
    for (const needle of [secret, openWa.apiKey, bad, signature(secret, raw)]) {
        expect(haystack).not.toContain(needle);
        expect(log).not.toContain(needle);
    }

    const fresh = await readWebhookSecret(instance, session.ulid);

    expect(fresh).not.toBe(secret);
    expect(haystack).not.toContain(fresh);
    expect(log).not.toContain(fresh);
    expect(fresh.length).toBeGreaterThanOrEqual(16);
});

test('a flood of unsigned requests is limited per client network and does not touch anybody else', async ({
    instance,
    openWa,
    request,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const { hook, openWaId } = await webhookOf(session, {
        request,
        instance,
        openWa,
    });
    const flood = '203.0.113.200';
    const raw = JSON.stringify(
        envelope(
            openWaId,
            'message.received',
            textMessage(uniquePhone(), 'flood'),
        ),
    );
    let limited: Awaited<ReturnType<WebhookClient['post']>> | null = null;
    let sent = 0;

    while (limited === null && sent < 900) {
        const batch = await Promise.all(
            Array.from({ length: 30 }, () =>
                hook.post(raw, { sign: false, address: flood }),
            ),
        );

        sent += batch.length;
        limited = batch.find((answer) => answer.status === 429) ?? null;
    }

    expect(limited, `no 429 after ${sent} requests`).not.toBeNull();
    expect(Number(limited!.headers['retry-after'])).toBeGreaterThan(0);
    // The same network is still limited (even with a valid signature) ...
    expect((await hook.post(raw, { address: flood })).status).toBe(429);
    // ... while another network, and OpenWA itself, are not.
    expect((await hook.post(raw, { address: '203.0.113.201' })).status).toBe(
        200,
    );
    const fromOpenWa = await openWa.deliver({
        session: session.name,
        event: 'message.received',
        data: textMessage(uniquePhone(), 'from OpenWA during the flood'),
    });

    expect(fromOpenWa.results[0].status).toBe(200);
});
