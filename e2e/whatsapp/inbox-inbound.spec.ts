import { readLedger } from '../support/wa-webhook';
import { asBase64, hugeDimensionsPng, smallPng } from '../support/wa-images';
import {
    expect,
    readySession,
    settleSettings,
    test,
    transcript,
    uniquePhone,
    waitForChat,
    waitForMessage,
} from '../support/wa-test';
import { WaInboxPage } from '../support/wa-ui';
import { data, eventually, type WaChat } from '../support/whatsapp';

/**
 * What the administrator sees when customers write: the OpenWA mock plays the phone (`message.received`, signed, through the real webhook), the
 * app records the chat, and the real dashboard shows it live over Reverb. Every test makes its own session and numbers (shared mode) except
 * the ones that change a global setting or read the sidebar total (exclusive).
 */
test.use({ scenario: 'p6-wa' });

const isPhone = (name: string): boolean => name === 'mobile';

test('a first message from a new number appears at once as an unlinked chat; opening it marks it read; later messages arrive live', async ({
    actors,
    openWa,
    wa,
}, testInfo) => {
    const session = await readySession(wa, openWa);
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);
    const customer = uniquePhone();

    await inbox.goto();
    await openWa.inboundText(
        session.name,
        customer,
        'Hello there, I need help with my order',
        { pushName: 'Vera Visitor' },
    );

    // The server recorded it; the open page shows the new chat without a reload.
    const chat = await waitForChat(wa, session, customer);

    expect(chat).toMatchObject({
        pushName: 'Vera Visitor',
        linked: false,
        widget: null,
        category: null,
        unreadByAdmin: 1,
        inboundInitiated: true,
        isGroup: false,
        status: 'open',
    });
    expect(chat.phone).toBe(`+${customer}`);

    const row = inbox.row(chat.ulid);

    await expect(row).toBeVisible();
    await expect(row).toContainText('Vera Visitor');
    await expect(row).toContainText('Hello there, I need help with my order');
    await expect(row).toContainText('Not linked to a website visit');
    await expect(inbox.unread(chat.ulid)).toHaveText(/1/);
    // The tab title counts what is waiting.
    await expect(admin.page).toHaveTitle(/^\(\d+\) WhatsApp/);

    // A second message: the badge grows and the preview follows.
    await openWa.inboundText(session.name, customer, 'It has not arrived yet', {
        pushName: 'Vera Visitor',
    });
    await expect(inbox.unread(chat.ulid)).toHaveText(/2/);
    await expect(row).toContainText('It has not arrived yet');

    // Open it: both messages, the phone number and session in the header, the badge gone here and on the server.
    await row.click();
    await expect(admin.page.getByTestId('wa-chat-view')).toBeVisible();
    await expect(admin.page.getByTestId('wa-chat-name')).toHaveText(
        'Vera Visitor',
    );
    await expect(admin.page.getByTestId('wa-chat-header')).toContainText(
        `+${customer}`,
    );
    await expect(admin.page.getByTestId('wa-chat-header')).toContainText(
        session.name,
    );
    await expect(
        inbox.bubble('Hello there, I need help with my order'),
    ).toBeVisible();
    await expect(inbox.bubble('It has not arrived yet')).toBeVisible();
    await expect(inbox.composer).toBeVisible();
    await eventually(
        async () =>
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .unreadByAdmin === 0 || undefined,
        'the chat to be marked read',
    );

    if (!isPhone(testInfo.project.name)) {
        await expect(inbox.unread(chat.ulid)).toHaveCount(0);
    }

    // A message that arrives while the chat is open lands at the end of the transcript and does not leave it unread.
    await openWa.inboundText(session.name, customer, 'Are you still there?', {
        pushName: 'Vera Visitor',
    });
    await expect(inbox.bubble('Are you still there?')).toBeVisible();
    await eventually(
        async () =>
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .unreadByAdmin === 0 || undefined,
        'the open chat to stay read',
    );
    expect((await transcript(wa, chat)).map((message) => message.body)).toEqual(
        [
            'Hello there, I need help with my order',
            'It has not arrived yet',
            'Are you still there?',
        ],
    );
    // The bubbles are in arrival order on screen as well.
    const shown = await admin.page
        .getByTestId('wa-transcript')
        .locator('li[data-testid^="wa-message-"]')
        .allInnerTexts();

    expect(shown.map((text) => text.split('\n')[0])).toEqual([
        'Hello there, I need help with my order',
        'It has not arrived yet',
        'Are you still there?',
    ]);
});

test('an image arrives inline and is shown through a signed link that only an administrator can use', async ({
    actors,
    adminApi,
    instance,
    openWa,
    playwright,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundImage(session.name, customer, 'Here is the damage', {
        dataBase64: asBase64(smallPng(48)),
        filename: 'damage.png',
    });

    const chat = await waitForChat(wa, session, customer);
    // The row is there before its file is (the webhook answer is not the mock's `inbound` answer): wait for the stored picture.
    const message = await waitForMessage(
        wa,
        chat,
        (candidate) =>
            candidate.type === 'image' &&
            (candidate as unknown as { media: { available: boolean } }).media
                .available,
        'the picture to be stored',
    );
    const media = (
        message as unknown as {
            media: { available: boolean; url: string; mime: string };
        }
    ).media;

    expect(media).toMatchObject({ available: true, mime: 'image/png' });
    expect(
        data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
            .lastMessagePreview,
    ).toBe('Here is the damage');

    // In the transcript: a button with the picture, loaded from the signed URL, and the caption.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    const picture = admin.page.getByTestId(`wa-message-image-${message.ulid}`);

    await expect(picture).toBeVisible();

    const image = picture.locator('img');

    await expect(image).toHaveAttribute(
        'src',
        /\/api\/v1\/whatsapp\/media\/.+signature=/,
    );
    await expect
        .poll(() =>
            image.evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBe(48);
    await expect(inbox.bubble('Here is the damage')).toBeVisible();

    // The link: an administrator's session serves the stored picture with the protective headers ...
    const url = new URL(media.url);
    const path = `${url.pathname}${url.search}`;
    const served = await adminApi.request('GET', path);

    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toBe('image/png');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toContain(
        "default-src 'none'",
    );
    expect(served.headers['content-security-policy']).toContain('sandbox');
    expect(served.headers['content-disposition']).toMatch(
        /^inline; filename="?image\.png"?$/,
    );
    expect(served.headers['cache-control']).toContain('private');

    // ... a signature that was touched does not ...
    const bad = new URL(media.url);

    bad.searchParams.set(
        'signature',
        `${bad.searchParams.get('signature')!.slice(0, -1)}0`,
    );
    expect(
        (await adminApi.request('GET', `${bad.pathname}${bad.search}`)).status,
    ).toBe(403);
    expect((await adminApi.request('GET', `${url.pathname}`)).status).toBe(403);

    // ... and neither does a browser that holds no login, signed or not.
    const anonymous = await playwright.request.newContext({
        baseURL: instance.url,
    });
    const without = await anonymous.get(media.url, {
        failOnStatusCode: false,
        maxRedirects: 0,
    });

    expect([401, 403]).toContain(without.status());
    expect(without.headers()['content-type'] ?? '').not.toContain('image/');
    await anonymous.dispose();
});

test('an image that is not a picture, is too large or too big in pixels is recorded without a file; so is one OpenWA no longer has', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const cases: Record<string, Parameters<typeof openWa.inboundImage>[3]> = {
        'a web page named photo.png': {
            dataBase64: asBase64('<!doctype html><script>alert(1)</script>'),
            filename: 'photo.png',
        },
        'an SVG with a script': {
            mimetype: 'image/svg+xml',
            dataBase64: asBase64(
                '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
            ),
            filename: 'logo.svg',
        },
        'bytes that are not an image': {
            mimetype: 'image/jpeg',
            dataBase64: asBase64('this is only text'),
            filename: 'holiday.jpg',
        },
        'a PNG that claims 30000 x 30000 pixels': {
            dataBase64: asBase64(hugeDimensionsPng()),
            filename: 'bomb.png',
        },
        'a file bigger than the storage limit (only the marker arrives)': {
            sizeBytes: 6_000_000,
            filename: 'big.png',
        },
        'a picture OpenWA no longer stores (the media route says 404)': {
            omitted: true,
            stored: false,
            filename: 'gone.png',
        },
    };

    for (const [label, media] of Object.entries(cases)) {
        await openWa.inboundImage(session.name, customer, label, media);
    }

    const chat = await waitForChat(wa, session, customer);
    const rows = await eventually(async () => {
        const all = await transcript(wa, chat);

        return all.length === Object.keys(cases).length ? all : undefined;
    }, 'all six messages');

    for (const row of rows) {
        const media = (
            row as unknown as {
                media: { available: boolean; url: string | null };
            }
        ).media;

        expect(row.type, row.body ?? '').toBe('image');
        expect(media.available, row.body ?? '').toBe(false);
        expect(media.url, row.body ?? '').toBeNull();
    }

    // The caption survives and the transcript says what it is: a photo whose file is not stored. Nothing is a link.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    for (const row of rows) {
        const bubble = admin.page.getByTestId(`wa-message-${row.ulid}`);

        await expect(bubble).toBeVisible();
        await expect(
            admin.page.getByTestId(`wa-message-media-${row.ulid}`),
        ).toContainText('Photo · attachment not stored');
        await expect(bubble.locator('img')).toHaveCount(0);
        await expect(bubble.locator('a')).toHaveCount(0);
    }

    // A file over the limit is never even asked for.
    const media = await openWa.requests({ method: 'GET', path: '/media' });

    expect(
        media.filter(
            (call) =>
                call.path.includes(`/${customer}@c.us/`) &&
                call.path.includes('big'),
        ),
    ).toHaveLength(0);
});

test('a picture over the inline limit is fetched from OpenWA through its media route and shown', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const before = (await openWa.requests({ method: 'GET', path: '/media' }))
        .length;

    // `omitted`: OpenWA sends the marker instead of the bytes (what it does above about 768 KiB); the file is still downloadable.
    await openWa.inboundImage(session.name, customer, 'Large one', {
        omitted: true,
        size: 80,
        filename: 'large.png',
    });

    const chat = await waitForChat(wa, session, customer);
    const message = await waitForMessage(
        wa,
        chat,
        (candidate) =>
            candidate.type === 'image' &&
            (candidate as unknown as { media: { available: boolean } }).media
                .available,
        'the picture to be fetched and stored',
    );
    const calls = (
        await openWa.requests({ method: 'GET', path: '/media' })
    ).slice(before);

    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBe(openWa.apiKey);
    expect(calls[0].status).toBe(200);

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await expect
        .poll(() =>
            admin.page
                .getByTestId(`wa-message-image-${message.ulid}`)
                .locator('img')
                .evaluate((node: HTMLImageElement) => node.naturalWidth),
        )
        .toBe(80);
});

test('documents, audio, voice notes, videos, stickers, locations and contacts are recorded with their name and size, and say that the attachment is not stored', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const sent: [string, string, string, number | undefined][] = [
        ['document', 'Document', 'invoice-2026.pdf', 48_128],
        ['audio', 'Audio', 'song.mp3', 1_200_000],
        ['ptt', 'Voice message', 'voice.ogg', 9_000],
        ['video', 'Video', 'clip.mp4', 3_500_000],
        ['sticker', 'Sticker', 'sticker.webp', 20_000],
        ['location', 'Location', '', undefined],
        ['vcard', 'Contact', '', undefined],
    ];

    for (const [type, , filename, size] of sent) {
        await openWa.inbound(session.name, {
            from: customer,
            type,
            body: type === 'document' ? 'Please find the invoice attached' : '',
            ...(filename
                ? {
                      media: {
                          mimetype:
                              type === 'document'
                                  ? 'application/pdf'
                                  : 'application/octet-stream',
                          filename,
                          sizeBytes: size,
                          omitted: true,
                          stored: false,
                      },
                  }
                : {}),
        });
    }

    const chat = await waitForChat(wa, session, customer);
    const rows = await eventually(async () => {
        const all = await transcript(wa, chat);

        return all.length === sent.length ? all : undefined;
    }, 'every typed message');
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);

    for (const [index, [, label, filename]] of sent.entries()) {
        const placeholder = admin.page.getByTestId(
            `wa-message-media-${rows[index].ulid}`,
        );

        await expect(placeholder, label).toContainText(
            `${label} · attachment not stored`,
        );

        if (filename) {
            await expect(placeholder).toContainText(filename);
        }

        // No download link, no inline player: only the typed card.
        await expect(
            admin.page
                .getByTestId(`wa-message-${rows[index].ulid}`)
                .locator('a, audio, video, img'),
        ).toHaveCount(0);
    }

    // The caption of the document is shown next to its card, and the list says what the last message was.
    await expect(
        inbox.bubble('Please find the invoice attached'),
    ).toBeVisible();
    expect(rows[0].type).toBe('document');
    expect(rows[2].type).toBe('voice');
    expect(rows[5].type).toBe('location');
    expect(rows[6].type).toBe('contact');
});

test('groups, stories, channels and broadcast lists are not chats of a person: acknowledged and ignored', async ({
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const group = await openWa.inboundGroup(session.name, 'Hello group');
    const story = await openWa.inbound(session.name, {
        chatId: 'status@broadcast',
        kind: 'status',
        body: 'A story',
        author: `${uniquePhone()}@c.us`,
    });
    const channel = await openWa.inbound(session.name, {
        chatId: '120363111111111111@newsletter',
        kind: 'channel',
        body: 'News from a channel',
    });
    const broadcast = await openWa.inbound(session.name, {
        chatId: '1700000000@broadcast',
        kind: 'broadcast',
        body: 'A broadcast list',
    });

    await openWa.inboundText(session.name, customer, 'A real customer');
    await waitForChat(wa, session, customer);

    // One chat in the session, and the four deliveries were answered 200 and recorded as ignored.
    expect(
        data<WaChat[]>(
            await wa.chats({ session: session.ulid, status: 'all' }),
            'list',
        ),
    ).toHaveLength(1);

    const ledger = await eventually(async () => {
        const rows = await readLedger(instance, session.ulid);

        return rows.filter(
            (row) => row.event === 'message.received' && row.outcome !== null,
        ).length >= 5
            ? rows
            : undefined;
    }, 'the ledger to hold the five messages');

    for (const sent of [group, story, channel, broadcast]) {
        const row = ledger.find((entry) => entry.key.includes(sent.messageId));

        expect(row?.outcome, sent.chatId).toBe('ignored');
    }
});

test('a sender hidden behind a privacy id shows by the number OpenWA resolved, and one customer is one chat in either id dialect', async ({
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const resolved = uniquePhone();
    const baileys = uniquePhone();

    // `@lid` + `senderPhone`: the chat has the real number (never the privacy id), under the customer's name.
    await openWa.inboundLid(session.name, 'Hi, writing from a hidden number', {
        senderPhone: resolved,
        pushName: 'Hidden Hannah',
    });

    const hidden = await waitForChat(wa, session, resolved);

    expect(hidden).toMatchObject({ pushName: 'Hidden Hannah', isGroup: false });
    expect(JSON.stringify(hidden)).not.toContain('@lid');

    // whatsapp-web.js says `@c.us`, Baileys `@s.whatsapp.net`: one customer, one chat.
    await openWa.inbound(session.name, {
        chatId: `${baileys}@c.us`,
        body: 'First, web.js dialect',
    });
    await waitForChat(wa, session, baileys);
    await openWa.inbound(session.name, {
        chatId: `${baileys}@s.whatsapp.net`,
        body: 'Second, Baileys dialect',
    });

    const chat = await waitForChat(wa, session, baileys);

    await waitForMessage(
        wa,
        chat,
        (message) => message.body === 'Second, Baileys dialect',
    );
    expect(
        data<WaChat[]>(
            await wa.chats({
                session: session.ulid,
                q: baileys,
                status: 'all',
            }),
            'list',
        ),
    ).toHaveLength(1);
    expect((await transcript(wa, chat)).map((message) => message.body)).toEqual(
        ['First, web.js dialect', 'Second, Baileys dialect'],
    );
});

test("the phone's own message shows as an outgoing bubble without an unread badge, and a chat the customer never started cannot be answered from here", async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundFromMe(
        session.name,
        customer,
        'Hello, this is support, how can we help?',
    );

    const chat = await waitForChat(wa, session, customer);

    expect(chat).toMatchObject({
        unreadByAdmin: 0,
        inboundInitiated: false,
        linked: false,
    });

    const messages = await transcript(wa, chat);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
        direction: 'out',
        body: 'Hello, this is support, how can we help?',
    });

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await expect(
        admin.page.getByTestId(`wa-message-${messages[0].ulid}`),
    ).toHaveAttribute('data-direction', 'out');
    await expect(
        admin.page.getByTestId(`wa-message-${messages[0].ulid}`),
    ).toHaveAttribute('data-status', 'sent');

    // The reason is on the screen instead of a box, and the server says the same.
    const reason = admin.page.getByTestId('wa-composer-disabled');

    await expect(reason).toBeVisible();
    await expect(reason).toHaveAttribute('data-reason', 'not_inbound');
    await expect(reason).toContainText(
        'You can only reply to customers who wrote first.',
    );
    await expect(inbox.composer).toHaveCount(0);

    const refused = await wa.reply(chat.ulid, 'Can I send this anyway?');

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('reply_not_allowed');
    expect(await transcript(wa, chat)).toHaveLength(1);
});

test.describe('the sidebar badge and the page title', () => {
    test.use({ waMode: 'exclusive', waWipe: true });

    test('count the unread messages of the open chats, and drop when they are read', async ({
        actors,
        openWa,
        wa,
    }, testInfo) => {
        const session = await readySession(wa, openWa);
        const first = uniquePhone();
        const second = uniquePhone();
        const admin = await actors.staff('admin');
        const inbox = new WaInboxPage(admin.page);

        await inbox.goto();
        await expect(admin.page).toHaveTitle('WhatsApp - PNE Chat');
        await expect(inbox.navBadge).toHaveCount(0);

        await openWa.inboundText(session.name, first, 'One message');
        await openWa.inboundText(session.name, second, 'Two');
        await openWa.inboundText(session.name, second, 'messages');

        const chatOne = await waitForChat(wa, session, first);
        const chatTwo = await waitForChat(wa, session, second);

        await eventually(
            async () =>
                (await waitForChat(wa, session, second)).unreadByAdmin === 2 ||
                undefined,
            'both messages of the second chat',
        );
        await expect(admin.page).toHaveTitle(/^\(3\) WhatsApp - PNE Chat$/);

        if (!isPhone(testInfo.project.name)) {
            await expect(inbox.navBadge).toHaveText(/3/);
            await expect(inbox.navBadge).toContainText(
                'unread WhatsApp messages',
            );
        }

        // The count is MESSAGES waiting (1 + 2): reading the two-message chat leaves one, reading the other clears it.
        await inbox.row(chatTwo.ulid).click();
        await expect(admin.page).toHaveTitle(/^\(1\) WhatsApp: /);

        if (isPhone(testInfo.project.name)) {
            await admin.page.getByTestId('wa-chat-back').click();
        }

        await inbox.row(chatOne.ulid).click();
        await expect(admin.page).toHaveTitle(/^WhatsApp: /);

        if (!isPhone(testInfo.project.name)) {
            await expect(inbox.navBadge).toHaveCount(0);
        }

        // The count is the server's too: a reload agrees.
        await admin.page.reload();
        await expect(admin.page).toHaveTitle(/^WhatsApp: /);
    });
});

test.describe('groups when they are switched on', () => {
    test.use({ waMode: 'exclusive' });

    test('are recorded as group chats with the sender named, and the privacy-id sender without a resolved number has no phone', async ({
        actors,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);

        data(await wa.saveSettings({ ignore_groups: false }), 'allow groups');
        await settleSettings();

        const author = uniquePhone();

        await openWa.inboundGroup(
            session.name,
            'Hello group',
            `${author}@c.us`,
        );

        const groups = await eventually(async () => {
            const rows = data<WaChat[]>(
                await wa.chats({ session: session.ulid, status: 'all' }),
                'list',
            );

            return rows.length > 0 ? rows : undefined;
        }, 'the group chat');

        expect(groups).toHaveLength(1);
        expect(groups[0].isGroup).toBe(true);

        const admin = await actors.staff('admin');
        const inbox = new WaInboxPage(admin.page);

        await inbox.goto();
        await expect(inbox.row(groups[0].ulid)).toBeVisible();
        await expect(
            inbox.row(groups[0].ulid).getByLabel('Group'),
        ).toBeVisible();

        // Without OpenWA's number resolution (RESOLVE_LID_TO_PHONE off) a privacy-id sender is a chat without a phone.
        await openWa.config({ resolveLid: false });
        await openWa.inboundLid(session.name, 'Who am I?', {
            pushName: 'Nameless Nora',
        });

        const hidden = await eventually(async () => {
            const rows = data<WaChat[]>(
                await wa.chats({
                    session: session.ulid,
                    status: 'all',
                    q: 'Nameless',
                }),
                'list',
            );

            return rows[0];
        }, 'the unresolved chat');

        expect(hidden.phone).toBeNull();
        expect(hidden.pushName).toBe('Nameless Nora');
        await expect(inbox.row(hidden.ulid)).toContainText('Nameless Nora');
    });
});
