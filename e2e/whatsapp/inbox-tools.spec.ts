import { readFile } from 'node:fs/promises';
import { csvRecords } from '../support/csv';
import {
    expect,
    readySession,
    test,
    transcript,
    uniqueName,
    uniquePhone,
    waitForChat,
    waitForMessage,
} from '../support/wa-test';
import { linkedChat, whatsappWidget } from '../support/wa-flow';
import { WaInboxPage } from '../support/wa-ui';
import { data, eventually, type WaChat } from '../support/whatsapp';

/**
 * The administrator's tools around the inbox: archive and unarchive, search, the filters, paging through a long list and a long transcript,
 * the export (CSV and JSON, with the filters) and the details sheet. Every test has its own session (shared mode): rows are found by their ulid
 * and lists are scoped to the test's session, so what other spec files do in parallel never shows up.
 */
test.use({ scenario: 'p6-wa' });

test('archiving takes a chat out of the open list, a new message or a reply brings it back, and both directions are idempotent', async ({
    actors,
    openWa,
    wa,
}, testInfo) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, 'Please archive me', {
        pushName: 'Arne Archive',
    });

    const chat = await waitForChat(wa, session, customer);
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    // Reading takes a short dwell time (400 ms) in the open chat: leaving before it would leave the chat unread.
    await eventually(
        async () =>
            data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat
                .unreadByAdmin === 0 || undefined,
        'the open chat to be marked read',
    );
    await admin.page.getByTestId('wa-archive').click();
    await expect(admin.page.getByTestId('wa-chat-archived')).toContainText(
        'This chat is archived.',
    );
    await expect(admin.page.getByText('Chat archived.')).toBeVisible();
    await expect(admin.page.getByTestId('wa-chat-view')).toHaveAttribute(
        'data-status',
        'archived',
    );
    expect(
        data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat.status,
    ).toBe('archived');

    // Out of the open list (the default), in the archived one with its badge.
    const phone = testInfo.project.name === 'mobile';

    if (phone) {
        await admin.page.getByTestId('wa-chat-back').click();
    }

    await expect(inbox.row(chat.ulid)).toHaveCount(0);
    await admin.page.getByTestId('wa-filter-archived').click();
    await expect(inbox.row(chat.ulid)).toBeVisible();
    await expect(inbox.row(chat.ulid)).toContainText('Archived');
    await expect(admin.page.getByTestId('wa-filter-archived')).toHaveAttribute(
        'aria-pressed',
        'true',
    );

    // Archive twice, unarchive twice: the same answers, no error.
    expect(
        (await wa.api.post(`/api/v1/whatsapp/chats/${chat.ulid}/archive`))
            .status,
    ).toBe(200);
    expect(
        (await wa.api.post(`/api/v1/whatsapp/chats/${chat.ulid}/unarchive`))
            .status,
    ).toBe(200);
    expect(
        (await wa.api.post(`/api/v1/whatsapp/chats/${chat.ulid}/unarchive`))
            .status,
    ).toBe(200);
    expect(
        (await wa.api.post(`/api/v1/whatsapp/chats/${chat.ulid}/archive`)).data
            .status,
    ).toBe('archived');

    // The customer writes again: the chat is back in the inbox, unread, live.
    await admin.page.getByTestId('wa-filter-archived').click(); // back to "open"
    await expect(inbox.row(chat.ulid)).toHaveCount(0);
    await openWa.inboundText(session.name, customer, 'Hello again', {
        pushName: 'Arne Archive',
    });
    await expect(inbox.row(chat.ulid)).toBeVisible();
    await expect(inbox.unread(chat.ulid)).toHaveText(/1/);
    expect(
        data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat.status,
    ).toBe('open');

    // A reply to an archived chat brings it back as well.
    await wa.api.post(`/api/v1/whatsapp/chats/${chat.ulid}/archive`);
    expect((await wa.reply(chat.ulid, 'Reopening from my side')).status).toBe(
        201,
    );
    expect(
        data<{ chat: WaChat }>(await wa.chat(chat.ulid), 'read').chat.status,
    ).toBe('open');

    // Unarchive from the header.
    await inbox.goto(chat.ulid);
    await admin.page.getByTestId('wa-archive').click();
    await expect(admin.page.getByTestId('wa-chat-archived')).toBeVisible();
    await admin.page.getByTestId('wa-archive').click();
    await expect(admin.page.getByTestId('wa-chat-archived')).toHaveCount(0);
    await expect(
        admin.page.getByText('Chat moved back to the inbox.'),
    ).toBeVisible();
});

test('search finds a chat by number in any spelling, by name, by message text and by the linked visitor, and says when nothing matches', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const first = uniquePhone();
    const second = uniquePhone();
    const word = `refund${Date.now().toString(36)}`;
    const email = `${uniqueName('shopper')}@example.test`;

    await openWa.inboundText(
        session.name,
        first,
        `I want a ${word} for invoice 4471`,
        { pushName: 'Zelda Zed' },
    );
    await openWa.inboundText(session.name, second, 'Where is my parcel?', {
        pushName: 'Bruno Brandt',
    });

    const one = await waitForChat(wa, session, first);
    const two = await waitForChat(wa, session, second);
    const linked = await linkedChat(openWa, wa, instance, session, widget, {
        name: 'Greta Visitor',
        email,
        pushName: 'Greta',
    });
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);
    const rows = [one.ulid, two.ulid, linked.chat.ulid];

    await inbox.goto();

    const search = async (text: string, expected: string[]): Promise<void> => {
        await inbox.search.fill(text);

        for (const ulid of rows) {
            if (expected.includes(ulid)) {
                await expect(
                    inbox.row(ulid),
                    `${text} -> ${ulid}`,
                ).toBeVisible();
            } else {
                await expect(
                    inbox.row(ulid),
                    `${text} -> not ${ulid}`,
                ).toHaveCount(0);
            }
        }
    };

    // The number: the whole of it, its tail, with the plus, spaced and dashed like people type it.
    await search(first, [one.ulid]);
    await search(first.slice(-6), [one.ulid]);
    await search(`+${first}`, [one.ulid]);
    await search(
        `+${first.slice(0, 2)} ${first.slice(2, 5)}-${first.slice(5)}`,
        [one.ulid],
    );
    // The name on WhatsApp, in any case.
    await search('zelda', [one.ulid]);
    await search('BRUNO', [two.ulid]);
    // The text of any message in the chat (not only the last).
    await search(word, [one.ulid]);
    await search('parcel', [two.ulid]);
    // The website visitor the chat was linked to: name and e-mail.
    await search('Greta Visitor', [linked.chat.ulid]);
    await search(email, [linked.chat.ulid]);
    // Nothing: the empty state, and clearing the box gets the list back.
    await inbox.search.fill('nothing-like-this-zzqx');
    await expect(admin.page.getByTestId('wa-list-no-match')).toBeVisible();
    await inbox.search.fill('');
    await expect(admin.page.getByTestId('wa-list-no-match')).toHaveCount(0);
    await expect(inbox.row(one.ulid)).toBeVisible();

    // The API treats `%`, `_` and `!` as the characters they are, never as wildcards. (No digits in these words: three or more digits in the
    // search box also match phone numbers, so a "100%" would find every number that has 100 in it.)
    const percyPhone = uniquePhone();

    await openWa.inboundText(
        session.name,
        percyPhone,
        'Ten% sure about snake_case!',
        { pushName: 'Percy' },
    );

    const percy = await waitForChat(wa, session, percyPhone);
    const find = async (text: string): Promise<string[]> =>
        data<WaChat[]>(
            await wa.chats({ session: session.ulid, q: text, status: 'all' }),
            'search',
        ).map((row) => row.ulid);

    await eventually(
        async () => (await find('Ten%')).length === 1 || undefined,
        'the literal percent sign to match',
    );
    expect(await find('Ten%')).toEqual([percy.ulid]);
    expect(await find('%')).toEqual([percy.ulid]);
    expect(await find('snake_c')).toEqual([percy.ulid]);
    expect(await find('_')).toContain(percy.ulid);
    expect(await find('!')).toContain(percy.ulid);
    // As wildcards these would match every chat of the session.
    expect(await find('%%')).toEqual([]);
    expect(await find('_%_')).toEqual([]);
    expect(await find('Te%n')).toEqual([]);

    expect((await wa.chats({ q: 'x'.repeat(201) })).status).toBe(422);
});

test('the filters (open, archived, from the website, not linked, unread, unread first, session, widget, topic) narrow the list', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const other = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const plain = uniquePhone();
    const readOne = uniquePhone();
    const archivedOne = uniquePhone();
    const elsewhere = uniquePhone();

    await openWa.inboundText(session.name, readOne, 'Already read', {
        pushName: 'Rita Read',
    });
    await openWa.inboundText(session.name, archivedOne, 'Archived soon', {
        pushName: 'Arne Old',
    });
    await openWa.inboundText(other.name, elsewhere, 'In the other session', {
        pushName: 'Olga Other',
    });
    await openWa.inboundText(session.name, plain, 'Unread and unlinked', {
        pushName: 'Ulf Unread',
    });

    const chats = {
        read: await waitForChat(wa, session, readOne),
        archived: await waitForChat(wa, session, archivedOne),
        elsewhere: await waitForChat(wa, other, elsewhere),
        plain: await waitForChat(wa, session, plain),
    };
    const linked = await linkedChat(openWa, wa, instance, session, widget, {
        category: 'billing',
        name: 'Lena Linked',
    });

    // Read one, archive another.
    expect((await wa.markRead(chats.read.ulid)).status).toBe(200);
    expect(
        (
            await wa.api.post(
                `/api/v1/whatsapp/chats/${chats.archived.ulid}/archive`,
            )
        ).status,
    ).toBe(200);

    const mine = (extra: Record<string, string> = {}) =>
        wa
            .chats({ session: session.ulid, status: 'open', ...extra })
            .then((result) =>
                data<WaChat[]>(result, 'list')
                    .map((row) => row.ulid)
                    .sort(),
            );
    const all = [chats.read.ulid, chats.plain.ulid, linked.chat.ulid].sort();

    // The API says it first (the UI sends the same filters).
    expect(await mine()).toEqual(all);
    expect(await mine({ linked: '1' })).toEqual([linked.chat.ulid]);
    expect(await mine({ linked: '0' })).toEqual(
        [chats.read.ulid, chats.plain.ulid].sort(),
    );
    expect(await mine({ unread: '1' })).toEqual(
        [chats.plain.ulid, linked.chat.ulid].sort(),
    );
    expect(await mine({ status: 'archived' })).toEqual([chats.archived.ulid]);
    expect(await mine({ status: 'all' })).toEqual(
        [...all, chats.archived.ulid].sort(),
    );
    expect(await mine({ widget: widget.ulid })).toEqual([linked.chat.ulid]);
    expect(await mine({ category: 'billing' })).toEqual([linked.chat.ulid]);
    expect(
        await mine({ category: linked.chat.category ? 'billing' : 'sales' }),
    ).toEqual([linked.chat.ulid]);
    expect(await mine({ category: 'sales' })).toEqual([]);

    // The page: the chips and the selects, one after the other.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto();
    await admin.page
        .getByTestId('wa-filter-session')
        .selectOption({ label: session.name });

    const expectRows = async (
        expected: string[],
        label: string,
    ): Promise<void> => {
        for (const ulid of [
            ...all,
            chats.archived.ulid,
            chats.elsewhere.ulid,
        ]) {
            if (expected.includes(ulid)) {
                await expect(
                    inbox.row(ulid),
                    `${label}: ${ulid}`,
                ).toBeVisible();
            } else {
                await expect(
                    inbox.row(ulid),
                    `${label}: not ${ulid}`,
                ).toHaveCount(0);
            }
        }
    };

    await expectRows(all, 'one session, open');
    await admin.page.getByTestId('wa-filter-linked').click();
    await expectRows([linked.chat.ulid], 'from the website');
    await expect(inbox.row(linked.chat.ulid)).toContainText(widget.name);
    await expect(inbox.row(linked.chat.ulid)).toContainText('Billing');
    await admin.page.getByTestId('wa-filter-linked').click();
    await admin.page.getByTestId('wa-filter-unlinked').click();
    await expectRows([chats.read.ulid, chats.plain.ulid], 'not linked');
    await admin.page.getByTestId('wa-filter-unread').click();
    await expectRows([chats.plain.ulid], 'not linked and unread');
    await admin.page.getByTestId('wa-filter-unlinked').click();
    await expectRows([chats.plain.ulid, linked.chat.ulid], 'unread');
    await admin.page.getByTestId('wa-filter-unread').click();
    await admin.page.getByTestId('wa-filter-archived').click();
    await expectRows([chats.archived.ulid], 'archived');
    await admin.page.getByTestId('wa-filter-archived').click();

    // The other session's chat is hidden by the session filter and visible without it; widget and topic filters.
    await admin.page.getByTestId('wa-filter-session').selectOption('');
    await expect(inbox.row(chats.elsewhere.ulid)).toBeVisible();
    await admin.page.getByTestId('wa-filter-widget').selectOption(widget.ulid);
    await expectRows([linked.chat.ulid], 'a widget');
    await admin.page.getByTestId('wa-filter-category').selectOption('billing');
    await expectRows([linked.chat.ulid], 'a widget and a topic');
    await admin.page.getByTestId('wa-filter-category').selectOption('sales');
    await expectRows([], 'a widget and another topic');
    await expect(admin.page.getByTestId('wa-list-no-match')).toBeVisible();
});

test('a long list is read in pages of 50 with a Load more button and cursors that never repeat or skip a chat', async ({
    actors,
    openWa,
    wa,
}) => {
    test.slow();

    const session = await readySession(wa, openWa);

    await readySession(wa, openWa); // a second session: the session filter only exists with two or more

    const customers = Array.from({ length: 56 }, () => uniquePhone());

    // In batches of eight so the receiving server is not flooded; one message each, recent ones last.
    for (let at = 0; at < customers.length; at += 8) {
        await Promise.all(
            customers
                .slice(at, at + 8)
                .map((customer, index) =>
                    openWa.inboundText(
                        session.name,
                        customer,
                        `Message ${at + index}`,
                        { pushName: `Customer ${at + index}` },
                    ),
                ),
        );
    }

    await eventually(
        async () =>
            data<WaChat[]>(
                await wa.chats({ session: session.ulid, limit: '100' }),
                'list',
            ).length === 56 || undefined,
        'all 56 chats',
        30_000,
    );

    // The API: pages of 20 until the end, newest activity first, every chat exactly once, the same order as one big page.
    const big = data<WaChat[]>(
        await wa.chats({ session: session.ulid, limit: '100' }),
        'list',
    ).map((row) => row.ulid);
    const walked: string[] = [];
    let cursor: string | null = null;
    let pages = 0;

    do {
        const result = await wa.chats({
            session: session.ulid,
            limit: '20',
            ...(cursor ? { cursor } : {}),
        });

        expect(result.ok).toBe(true);
        walked.push(...(result.data as WaChat[]).map((row) => row.ulid));
        cursor = result.body.meta.next_cursor;
        pages += 1;
    } while (cursor !== null && pages < 10);

    expect(pages).toBe(3);
    expect(walked).toEqual(big);
    expect(new Set(walked).size).toBe(56);

    // A cursor this API did not make is refused, not followed.
    expect((await wa.chats({ cursor: 'not-a-cursor' })).status).toBe(422);
    expect(
        (
            await wa.chats({
                cursor: Buffer.from('{"t":"x","i":1}').toString('base64url'),
            })
        ).status,
    ).toBe(422);

    // The page: fifty rows, Load more, six more. (Unread chats are also pulled in by the unread summary behind the sidebar badge, which would
    // show all of them at once: the chats are read first, as they are in a quiet inbox.)
    await Promise.all(big.map((ulid) => wa.markRead(ulid)));

    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto();
    await admin.page
        .getByTestId('wa-filter-session')
        .selectOption({ label: session.name });
    await expect(
        admin.page.locator('[data-testid^="wa-chat-row-"]'),
    ).toHaveCount(50);
    await admin.page.getByTestId('wa-list-more').click();
    await expect(
        admin.page.locator('[data-testid^="wa-chat-row-"]'),
    ).toHaveCount(56);
    await expect(admin.page.getByTestId('wa-list-more')).toHaveCount(0);
});

test('a long transcript opens at its newest 100 messages and loads the older ones on request, in order', async ({
    actors,
    openWa,
    wa,
}) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const customer = uniquePhone();
    const total = 130;
    const label = (index: number) => `Line ${String(index).padStart(3, '0')}`;

    for (let index = 1; index <= total; index += 1) {
        await openWa.inboundText(session.name, customer, label(index), {
            pushName: 'Long Larry',
        });
    }

    const chat = await waitForChat(wa, session, customer);

    await waitForMessage(
        wa,
        chat,
        (message) => message.body === label(total),
        'the last line',
    );

    // The API: the newest page, then older ones with `before_id`, and `after_id` for catching up.
    const newest = await wa.messages(chat.ulid);

    expect(newest.data).toHaveLength(100);
    expect(newest.data[0].body).toBe(label(31));
    expect(newest.data.at(-1).body).toBe(label(130));
    expect(newest.body.meta.next_cursor).toBeNull();
    expect(newest.body.meta.prev_cursor).not.toBeNull();

    const older = await wa.api.get(
        `/api/v1/whatsapp/chats/${chat.ulid}/messages?before_id=${newest.data[0].ulid}`,
    );

    expect(older.data.map((row: { body: string }) => row.body)).toEqual(
        Array.from({ length: 30 }, (_, index) => label(index + 1)),
    );
    expect(older.body.meta.prev_cursor).toBeNull();

    const after = await wa.api.get(
        `/api/v1/whatsapp/chats/${chat.ulid}/messages?after_id=${newest.data[96].ulid}&limit=200`,
    );

    expect(after.data.map((row: { body: string }) => row.body)).toEqual([
        label(128),
        label(129),
        label(130),
    ]);
    expect(
        (
            await wa.api.get(
                `/api/v1/whatsapp/chats/${chat.ulid}/messages?before_id=01JZ0000000000000000000000`,
            )
        ).status,
    ).toBe(422);

    // The page: the newest 100, the button, the whole history in order.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await expect(
        admin.page
            .getByTestId('wa-transcript')
            .locator('li[data-testid^="wa-message-"]'),
    ).toHaveCount(100);
    await expect(inbox.bubble(label(130))).toBeVisible();
    await expect(inbox.bubble(label(1))).toHaveCount(0);
    await admin.page.getByTestId('wa-load-older').click();
    await expect(
        admin.page
            .getByTestId('wa-transcript')
            .locator('li[data-testid^="wa-message-"]'),
    ).toHaveCount(total);
    await expect(admin.page.getByTestId('wa-load-older')).toHaveCount(0);

    const shown = await admin.page
        .getByTestId('wa-transcript')
        .locator('li[data-testid^="wa-message-"]')
        .allInnerTexts();

    expect(shown.map((text) => text.split('\n')[0])).toEqual(
        Array.from({ length: total }, (_, index) => label(index + 1)),
    );
});

test('the export streams the filtered chats or messages as CSV or JSON, neutralises formulas, and says what it holds', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const plain = uniquePhone();
    const evil = uniquePhone();

    await openWa.inboundText(
        session.name,
        plain,
        'A harmless question, with "quotes", commas,\nand a second line',
        { pushName: 'Pat Plain' },
    );
    // Everything a spreadsheet would run: the cell starts with =, +, -, @, a tab or a carriage return.
    const formulas = [
        '=HYPERLINK("http://evil.test","click")',
        '+49 151 1234567',
        '-2+3',
        '@SUM(A1:A9)',
        '\t=1+1',
        '\r=1+1',
    ];

    for (const formula of formulas) {
        await openWa.inboundText(session.name, evil, formula, {
            pushName: "=cmd|' /C calc'!A0",
        });
    }

    const evilChat = await waitForChat(wa, session, evil);
    const linked = await linkedChat(openWa, wa, instance, session, widget, {
        name: '+Victor Visitor',
        email: 'victor@example.test',
        category: 'sales',
    });

    await eventually(
        async () =>
            (await transcript(wa, evilChat)).length === formulas.length ||
            undefined,
        'all formula messages',
    );
    expect(
        (await wa.reply(linked.chat.ulid, 'We are looking into it')).status,
    ).toBe(201);

    const url = (query: string) =>
        `/api/v1/whatsapp/export?${query}&session=${session.ulid}`;
    const records = async (query: string) => {
        const result = await wa.api.get(url(query));

        expect(result.status, query).toBe(200);

        return csvRecords(result.text!);
    };
    const messages = await wa.api.get(url('format=csv'));

    expect(messages.status).toBe(200);
    expect(messages.headers['content-type']).toContain('text/csv');
    expect(messages.headers['content-disposition']).toMatch(
        /^attachment; filename="?whatsapp.*\.csv"?$/,
    );
    expect(messages.headers['cache-control']).toContain('no-store');

    const text = messages.text!;
    const rows = csvRecords(text);

    expect(text.split('\n')[0]).toBe(
        'message,chat,session,phone,push_name,widget,category,direction,type,status,sent_by,timestamp,body,media_filename,media_mime,media_size',
    );
    // One row per message of the session's chats: the plain one, six formulas, the linked chat's code message and the reply.
    expect(rows).toHaveLength(1 + formulas.length + 1 + 1);
    expect(rows.every((row) => row.session === session.name)).toBe(true);

    // Nothing in any cell starts with a formula character: it is prefixed with a quote. The body, the phone and the name too.
    const cells = rows.flatMap((row) => Object.values(row));

    expect(cells.filter((cell) => /^[=+\-@\t\r]/.test(cell))).toEqual([]);
    expect(rows.find((row) => row.body.includes('HYPERLINK'))?.body).toBe(
        `'${formulas[0]}`,
    );
    expect(rows.find((row) => row.body.includes('SUM('))?.body).toBe(
        `'${formulas[3]}`,
    );
    expect(rows.find((row) => row.push_name.includes('calc'))?.push_name).toBe(
        "'=cmd|' /C calc'!A0",
    );
    expect(rows.find((row) => row.chat === evilChat.ulid)?.phone).toBe(
        `'+${evil}`,
    );
    // Quotes, commas and the line break inside a message survive.
    expect(
        rows.find((row) => row.body.startsWith('A harmless question'))?.body,
    ).toBe('A harmless question, with "quotes", commas,\nand a second line');

    // The linked chat carries the widget and the topic; the administrator's reply says who wrote it.
    const reply = rows.find((row) => row.body === 'We are looking into it');

    expect(reply).toMatchObject({
        direction: 'out',
        widget: widget.name,
        category: 'Sales',
    });
    expect(reply?.sent_by).not.toBe('');
    // Never in a row: the WhatsApp message id, the raw object, a storage path.
    expect(text).not.toMatch(
        /false_\d+@c\.us_|true_\d+@c\.us_|storage\/|whatsapp\/media/,
    );

    // Chats: one row per chat, the counts and the visitor of the linked one.
    const chatRows = await records('format=csv&resource=chats');

    expect(chatRows).toHaveLength(3);
    expect(chatRows.find((row) => row.chat === linked.chat.ulid)).toMatchObject(
        {
            linked: 'true',
            widget: widget.name,
            category: 'Sales',
            visitor_email: 'victor@example.test',
            inbound_initiated: 'true',
            messages: '2',
            visitor_name: "'+Victor Visitor",
        },
    );

    // The filters apply: only linked chats, a search, a day, nothing for a day long ago.
    const today = new Date().toISOString().slice(0, 10);

    expect(await records('format=csv&linked=1')).toHaveLength(2);
    expect(await records('format=csv&q=harmless')).toHaveLength(1);
    expect(
        (await records(`format=csv&from=${today}&to=${today}`)).length,
    ).toBeGreaterThanOrEqual(1 + formulas.length);
    expect(
        await records('format=csv&from=2020-01-01&to=2020-01-02'),
    ).toHaveLength(0);

    // JSON is not a spreadsheet: values as they are (the phone keeps its plus).
    const json = await wa.api.get(url('format=json'));

    expect(json.body.data).toHaveLength(1 + formulas.length + 1 + 1);
    expect(
        json.body.data.find(
            (row: { chat: string }) => row.chat === evilChat.ulid,
        ).phone,
    ).toBe(`+${evil}`);
    expect((await wa.api.get(url('format=xml'))).status).toBe(422);

    // The page's own links carry the filters and download the file.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto();
    await admin.page
        .getByTestId('wa-filter-session')
        .selectOption({ label: session.name });
    await admin.page.getByTestId('wa-filter-linked').click();
    await admin.page.getByTestId('wa-export').locator('summary').click();
    await expect(
        admin.page.getByTestId('wa-export-messages-csv'),
    ).toHaveAttribute(
        'href',
        new RegExp(
            `session=${session.ulid}.*linked=1|linked=1.*session=${session.ulid}`,
        ),
    );

    const pending = admin.page.waitForEvent('download');

    await admin.page.getByTestId('wa-export-messages-csv').click();

    const file = await pending;
    const path = testInfo.outputPath(file.suggestedFilename());

    await file.saveAs(path);
    expect(file.suggestedFilename()).toMatch(/\.csv$/);
    expect(csvRecords(await readFile(path, 'utf8'))).toHaveLength(2);
});

test('the details sheet says what is known about a chat that no hand-off code matched', async ({
    actors,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, 'Who am I?', {
        pushName: 'Nobody Special',
    });

    const chat = await waitForChat(wa, session, customer);
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await admin.page.getByTestId('wa-chat-info').click();

    const sheet = admin.page.getByTestId('wa-details');

    await expect(sheet).toBeVisible();
    await expect(sheet).toContainText('Nobody Special');
    await expect(sheet).toContainText(`+${customer}`);
    await expect(sheet).toContainText(session.name);
    await expect(sheet).toContainText('The customer');
    await expect(sheet.getByTestId('wa-details-unlinked')).toContainText(
        'No hand-off code matched this chat, so it is not linked to a website visit.',
    );
    await expect(sheet.getByTestId('wa-details-code')).toHaveCount(0);
    await admin.page.keyboard.press('Escape');
    await expect(sheet).toBeHidden();
});
