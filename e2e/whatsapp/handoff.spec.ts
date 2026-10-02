import type { BrowserContext } from '@playwright/test';
import { tinker } from '../support/artisan';
import { createWorld } from '../support/world';
import { openCustomerSite } from '../support/panel';
import {
    linkedChat,
    requestHandoff,
    whatsappWidget,
    handoffRefusal,
} from '../support/wa-flow';
import {
    expect,
    readySession,
    settleSettings,
    test,
    uniquePhone,
    waitForChat,
} from '../support/wa-test';
import { WaInboxPage } from '../support/wa-ui';
import { data, eventually, type WaChat } from '../support/whatsapp';

/**
 * The hand-off on the customer's website, with the real widget on a cross-origin page: the channel chooser, the code screen, the `wa.me` link,
 * the countdown and a new code, and then the customer's first WhatsApp message with the code (through the OpenWA mock) linking the chat to the
 * widget, the visitor and the topic. Worlds (own categories, agent and widget) keep every test apart from the others (shared mode).
 */
test.use({ scenario: 'p6-wa' });

const ALPHABET = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{8}$/;

async function allowClipboard(
    context: BrowserContext,
    origins: string[],
): Promise<void> {
    await context
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
            origin: origins[0],
        })
        .catch(() => undefined);

    for (const origin of origins.slice(1)) {
        await context
            .grantPermissions(['clipboard-read', 'clipboard-write'], { origin })
            .catch(() => undefined);
    }
}

test("Continue on WhatsApp on a one-topic widget: a code, the wa.me link and the countdown; the customer's message with the code links the chat to the widget and the visitor", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        categories: ['help'],
        agents: { ann: ['help'] },
        config: { features: { whatsapp: true } },
    });

    expect((await wa.linkWidget(world.widget.ulid, session.ulid)).status).toBe(
        200,
    );
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        visitor: { name: 'Vera Visitor', email: 'vera@example.test' },
        open: true,
    });

    // The chooser: the old start button is "Chat here", next to "Continue on WhatsApp".
    await expect(panel.tid('channel-chooser')).toBeVisible();
    await expect(panel.tid('channel-chat')).toContainText('Chat here');
    await expect(panel.tid('channel-whatsapp')).toContainText(
        'Continue on WhatsApp',
    );
    await panel.tid('channel-whatsapp').click();

    // One topic: no picker. The code screen.
    const code = panel.tid('whatsapp-code');

    await expect(code).toBeVisible();

    const typed = (await code.innerText()).replace(/\s+/g, '');

    expect(typed).toMatch(ALPHABET);
    await expect(code).toHaveText(`${typed.slice(0, 4)} ${typed.slice(4)}`);
    await expect(panel.tid('whatsapp-expiry')).toContainText(
        'This code works for another',
    );
    await expect(panel.tid('whatsapp-expiry')).toContainText('hours');

    // "Open WhatsApp": the wa.me link of the connected number with the code already typed, in a new tab, never leaking the opener.
    const open = panel.tid('whatsapp-open');

    await expect(open).toHaveAttribute('target', '_blank');
    await expect(open).toHaveAttribute('rel', /noopener/);
    await expect(open).toHaveAttribute('rel', /noreferrer/);

    const href = new URL((await open.getAttribute('href'))!);

    expect(`${href.origin}${href.pathname}`).toBe(
        `https://wa.me/${session.phone}`,
    );
    expect(href.searchParams.get('text')).toBe(
        `Hi! My support code is ${typed}`,
    );
    expect(href.search).toBe(
        `?text=Hi%21%20My%20support%20code%20is%20${typed}`,
    );

    // Copy: the code goes to the clipboard (or, where the browser refuses, is selected and the panel says so).
    await allowClipboard(visitor.page.context(), [
        instance.hostUrl!,
        instance.url,
    ]);
    await panel.tid('whatsapp-copy').click();
    await expect(panel.tid('whatsapp-copy')).toContainText(/Copied|Copy code/);

    // The server's ticket is the same code, for this visitor, with the topic (the only one) recorded.
    const token = await panel.visitorToken();

    expect(token).not.toBeNull();

    // The customer sends it from their phone (a different number than the visitor's, in a sentence, in lower case).
    const customer = uniquePhone();

    await openWa.inboundText(
        session.name,
        customer,
        `hi there, my code is ${typed.toLowerCase()} thanks`,
        { pushName: 'Vera on WhatsApp' },
    );

    const chat = await waitForChat(wa, session, customer, { linked: '1' });

    expect(chat).toMatchObject({
        linked: true,
        widget: { ulid: world.widget.ulid, name: world.widget.name },
        category: { slug: world.categories.help.slug },
    });

    const detail = data<{
        visitor: { name: string; email: string; verified: boolean };
        handoff: { code: string; consumedAt: string | null };
    }>(await wa.chat(chat.ulid), 'detail');

    expect(detail.visitor).toMatchObject({
        name: 'Vera Visitor',
        email: 'vera@example.test',
        verified: false,
    });
    expect(detail.handoff.code).toBe(typed);
    expect(detail.handoff.consumedAt).not.toBeNull();

    // The administrator sees it: the row says where the customer came from; the details sheet names the visit.
    const admin = await actors.staff('admin');
    const inbox = new WaInboxPage(admin.page);

    await inbox.goto(chat.ulid);
    await expect(admin.page.getByTestId('wa-chat-linked')).toContainText(
        world.widget.name,
    );
    await expect(admin.page.getByTestId('wa-chat-linked')).toContainText(
        world.categories.help.name,
    );
    await admin.page.getByTestId('wa-chat-info').click();

    const sheet = admin.page.getByTestId('wa-details');

    await expect(sheet).toContainText(world.widget.name);
    await expect(sheet).toContainText(world.categories.help.name);
    await expect(sheet).toContainText('Vera Visitor');
    await expect(sheet).toContainText('vera@example.test');
    await expect(sheet.getByTestId('wa-details-code')).toContainText(typed);
    await expect(sheet.getByTestId('wa-details-unlinked')).toHaveCount(0);

    // "I sent it": the panel says the reply comes on WhatsApp and holds NOTHING of that conversation (hand-off + record: visitors never see it).
    await panel.tid('whatsapp-sent').click();
    await expect(
        panel.frame.getByText("We'll reply on WhatsApp"),
    ).toBeVisible();
    await expect(panel.frame.getByText('hi there')).toHaveCount(0);
    expect(
        await visitor.page.evaluate(() => JSON.stringify({ ...localStorage })),
    ).not.toContain('hi there');

    const api = (await import('../support/chat-api')).VisitorApi;
    const asVisitor = await api.withToken(instance, token!);

    expect(
        (await asVisitor.request('GET', '/conversation')).body.data,
    ).toBeNull();
    await asVisitor.dispose();
});

test('with several topics the visitor picks one first, and the topic travels with the code into the linked chat', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        categories: ['billing', 'sales'],
        agents: { ann: ['billing', 'sales'] },
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await panel.tid('channel-whatsapp').click();

    // The topic picker is the chat's own: choosing a topic goes to the code (no chat is started, nothing is queued).
    await expect(
        panel.tid(`category-option-${world.categories.sales.slug}`),
    ).toBeVisible();
    await expect(
        panel.tid(`category-option-${world.categories.billing.slug}`),
    ).toBeVisible();
    await panel.tid(`category-option-${world.categories.sales.slug}`).click();
    await expect(panel.tid('whatsapp-code')).toBeVisible();

    const typed = (await panel.tid('whatsapp-code').innerText()).replace(
        /\s+/g,
        '',
    );
    const customer = uniquePhone();

    await openWa.inboundText(
        session.name,
        customer,
        `Hi! My support code is ${typed}`,
    );

    const chat = await waitForChat(wa, session, customer, { linked: '1' });

    expect(chat.category?.slug).toBe(world.categories.sales.slug);
    expect(chat.widget?.ulid).toBe(world.widget.ulid);

    // Back from the code screen returns to the topic choice, and a topic that was chosen again gets the SAME live ticket back.
    const again = await actors.visitor();
    const second = await openCustomerSite(again.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await second.tid('channel-whatsapp').click();
    await second
        .tid(`category-option-${world.categories.billing.slug}`)
        .click();
    await expect(second.tid('whatsapp-code')).toBeVisible();

    const first = (await second.tid('whatsapp-code').innerText()).replace(
        /\s+/g,
        '',
    );

    await second.tid('whatsapp-back').click();
    // Back is the channel choice again, and WhatsApp asks for the topic again (a wrong one can be changed): the same visitor and topic get
    // the same live code, another topic another one.
    await expect(second.tid('channel-chooser')).toBeVisible();
    await second.tid('channel-whatsapp').click();
    await expect(
        second.tid(`category-option-${world.categories.sales.slug}`),
    ).toBeVisible();
    await second
        .tid(`category-option-${world.categories.billing.slug}`)
        .click();
    await expect(second.tid('whatsapp-code')).toBeVisible();
    expect(
        (await second.tid('whatsapp-code').innerText()).replace(/\s+/g, ''),
    ).toBe(first);
});

test('the chooser only appears when the widget offers WhatsApp for real: feature on, a connected session linked, the switch on', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const ready = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
        config: { features: { whatsapp: true } },
    });
    const featureOff = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
        config: { features: { whatsapp: false } },
    });
    const unlinked = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(ready.widget.ulid, session.ulid);
    await wa.linkWidget(featureOff.widget.ulid, session.ulid);
    await actors.account(ready.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });
    await actors.account(featureOff.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });
    await actors.account(unlinked.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const look = async (key: string) => {
        const visitor = await actors.visitor();
        const panel = await openCustomerSite(visitor.page, instance, {
            key,
            open: true,
        });

        return { visitor, panel };
    };

    // Offered.
    const on = await look(ready.widget.key);

    await expect(on.panel.tid('channel-chooser')).toBeVisible();

    // The feature is off in the published design: the usual start button, no chooser; the API refuses too.
    const off = await look(featureOff.widget.key);

    await expect(off.panel.tid('channel-chooser')).toHaveCount(0);
    await expect(off.panel.tid('channel-whatsapp')).toHaveCount(0);

    const refused = await handoffRefusal(instance, featureOff.widget);

    expect(refused).toContain('403');
    expect(refused).toContain('feature_disabled');

    // Feature on but no session linked: not offered either; the API says there is no number.
    const none = await look(unlinked.widget.key);

    await expect(none.panel.tid('channel-chooser')).toHaveCount(0);
    expect(await handoffRefusal(instance, unlinked.widget)).toMatch(/409|403/);

    // The number goes away (the phone logs out): the widget stops offering WhatsApp within seconds, without anybody editing the widget.
    await openWa.setStatus(session.name, 'disconnected', { reason: 'LOGOUT' });
    await eventually(
        async () =>
            data<{ status: string }>(await wa.session(session.ulid), 'read')
                .status === 'disconnected' || undefined,
        'the session to be disconnected',
    );

    await expect(async () => {
        const after = await look(ready.widget.key);

        await expect(after.panel.tid('channel-chooser')).toHaveCount(0, {
            timeout: 2_000,
        });
    }).toPass({ timeout: 20_000 });

    const gone = await handoffRefusal(instance, ready.widget);

    expect(gone).toContain('409');
    expect(gone).toContain('whatsapp_unavailable');

    // It comes back with the connection.
    await openWa.connect(session.name, session.phone);
    await eventually(
        async () =>
            data<{ status: string }>(await wa.session(session.ulid), 'read')
                .status === 'ready' || undefined,
        'the session to be ready again',
    );
    await expect(async () => {
        const back = await look(ready.widget.key);

        await expect(back.panel.tid('channel-chooser')).toBeVisible({
            timeout: 2_000,
        });
    }).toPass({ timeout: 20_000 });
});

test('nobody online: the offline form carries the WhatsApp alternative, and the code works the same', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    // A world whose only category nobody serves: the panel opens straight on the offline form.
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);

    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await panel.expectState('offline');
    await expect(panel.tid('channel-chooser')).toBeVisible();
    await expect(panel.tid('channel-chooser')).toContainText(
        'Continue on WhatsApp',
    );
    // Only the WhatsApp option: the chat itself is not on offer.
    await expect(panel.tid('channel-chat')).toHaveCount(0);
    await panel.tid('channel-whatsapp').click();
    await expect(panel.tid('whatsapp-code')).toBeVisible();

    const typed = (await panel.tid('whatsapp-code').innerText()).replace(
        /\s+/g,
        '',
    );

    expect(typed).toMatch(ALPHABET);

    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, typed);
    expect(
        (await waitForChat(wa, session, customer, { linked: '1' })).widget
            ?.ulid,
    ).toBe(world.widget.ulid);
});

test('a code that has run out is struck through and offers a new one; the old code links nothing, the new one does', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const visitor = await actors.visitor();

    // The first answer of the hand-off endpoint is rewritten to expire in a few seconds, and the stored ticket is aged to match: what the
    // panel counts down is what the server will refuse. (The second answer, for the new code, is left alone.)
    let first = true;
    let ticket = '';

    await visitor.page.route(
        '**/api/v1/public/widgets/*/whatsapp-handoff',
        async (route) => {
            const response = await route.fetch();
            const body = await response.json();

            if (first) {
                first = false;
                ticket = body.data.code;
                body.data.expiresAt = new Date(
                    Date.now() + 4_000,
                ).toISOString();
            }

            await route.fulfill({ response, json: body });
        },
    );

    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await panel.tid('channel-whatsapp').click();
    await expect(panel.tid('whatsapp-code')).toBeVisible();

    const old = (await panel.tid('whatsapp-code').innerText()).replace(
        /\s+/g,
        '',
    );

    expect(old).toBe(ticket);
    await expect(panel.tid('whatsapp-expiry')).toContainText(
        'This code works for another 1 minute',
    );
    await tinker(
        instance,
        `App\\Models\\WaHandoffTicket::where('code', getenv('E2E_CODE'))->update(['expires_at' => now()->subMinute()]); echo "AGED\\n";`,
        { E2E_CODE: old },
    );

    // Expired on the screen: the code is struck through, no link, one way forward.
    await expect(panel.tid('whatsapp-expiry')).toHaveAttribute(
        'data-expired',
        'true',
        { timeout: 15_000 },
    );
    await expect(panel.tid('whatsapp-expiry')).toContainText(
        'This code has expired.',
    );
    await expect(panel.tid('whatsapp-open')).toHaveCount(0);
    await expect(panel.tid('whatsapp-copy')).toHaveCount(0);

    // A message with the old code is not linked...
    const late = uniquePhone();

    await openWa.inboundText(session.name, late, `my code is ${old}`);
    expect((await waitForChat(wa, session, late)).linked).toBe(false);

    // ...a new code is another ticket and works.
    await panel.tid('whatsapp-new-code').click();
    await expect(panel.tid('whatsapp-expiry')).not.toHaveAttribute(
        'data-expired',
        'true',
    );
    await expect(panel.tid('whatsapp-open')).toBeVisible();

    const fresh = (await panel.tid('whatsapp-code').innerText()).replace(
        /\s+/g,
        '',
    );

    expect(fresh).toMatch(ALPHABET);
    expect(fresh).not.toBe(old);

    const customer = uniquePhone();

    await openWa.inboundText(session.name, customer, `new code ${fresh}`);
    expect(
        (await waitForChat(wa, session, customer, { linked: '1' })).widget
            ?.ulid,
    ).toBe(world.widget.ulid);
});

test('which messages link a chat: the code in a sentence, in lower case, with punctuation; not inside a word, not another session, not the phone, not a used or old code, not late', async ({
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const other = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const otherWidget = await whatsappWidget(adminApi, wa, instance, other);
    const linkedWith = async (
        text: (code: string) => string,
        label: string,
    ) => {
        const { handoff, visitor } = await requestHandoff(instance, widget, {
            name: label,
        });
        const customer = uniquePhone();

        await openWa.inboundText(session.name, customer, text(handoff.code));

        const chat = await waitForChat(wa, session, customer);

        // The link is made in the same webhook request: the first message's recording and its link come together.
        await visitor.dispose();

        return { chat, handoff, customer };
    };

    // Linked: whole word, any case, any punctuation around it, several lines, with other words that look like codes.
    for (const [label, text] of Object.entries({
        bare: (code: string) => code,
        'lower case': (code: string) => code.toLowerCase(),
        'mixed case in a sentence': (code: string) =>
            `Hi, my code is ${code[0]}${code.slice(1).toLowerCase()} - please help`,
        'in brackets': (code: string) => `(${code})`,
        'with a full stop': (code: string) => `Code: ${code}.`,
        'on its own line': (code: string) => `Hello\n${code}\nthanks`,
        'after other candidates': (code: string) =>
            `ABCDEFGH is not it, but ${code} is`,
        'in the Baileys id dialect': (code: string) => `via baileys ${code}`,
    })) {
        const { chat } = await linkedWith(text, label);

        expect(chat.linked, label).toBe(true);
        expect(chat.widget?.ulid, label).toBe(widget.ulid);
    }

    // Not linked: inside a longer word, next to letters or digits, with a look-alike, mistyped.
    for (const [label, text] of Object.entries({
        'a letter before': (code: string) => `X${code}`,
        'a letter after': (code: string) => `${code}Y`,
        'a digit after': (code: string) => `${code}2`,
        'an underscore around': (code: string) => `_${code}_`,
        'two letters swapped': (code: string) =>
            `${code[1]}${code[0]}${code.slice(2)}`,
        'too short': (code: string) => code.slice(0, 7),
        'spaces inside': (code: string) =>
            `${code.slice(0, 4)} ${code.slice(4)}`,
    })) {
        const { chat } = await linkedWith(text, label);

        expect(chat.linked, label).toBe(false);
    }

    // The code of a ticket of ANOTHER session (another number) links nothing here.
    const foreign = await requestHandoff(instance, otherWidget, {
        name: 'Other number',
    });
    const stray = uniquePhone();

    await openWa.inboundText(session.name, stray, foreign.handoff.code);
    expect((await waitForChat(wa, session, stray)).linked).toBe(false);
    // ...and it still works where it belongs.
    const rightful = uniquePhone();

    await openWa.inboundText(other.name, rightful, foreign.handoff.code);
    expect(
        (await waitForChat(wa, other, rightful, { linked: '1' })).widget?.ulid,
    ).toBe(otherWidget.ulid);

    // A used code does not link a second number; the first chat keeps its visitor.
    const used = await linkedWith((code) => `first ${code}`, 'First owner');

    expect(used.chat.linked).toBe(true);

    const reuse = uniquePhone();

    await openWa.inboundText(
        session.name,
        reuse,
        `second ${used.handoff.code}`,
    );
    expect((await waitForChat(wa, session, reuse)).linked).toBe(false);
    expect(
        data<{ chat: WaChat }>(await wa.chat(used.chat.ulid), 'read').chat
            .linked,
    ).toBe(true);

    // The phone's own message with a live code does not link (and does not use it up).
    const fromPhone = await requestHandoff(instance, widget, {
        name: 'Phone sender',
    });
    const phoneChat = uniquePhone();

    await openWa.inboundFromMe(
        session.name,
        phoneChat,
        `my code ${fromPhone.handoff.code}`,
    );
    expect((await waitForChat(wa, session, phoneChat)).linked).toBe(false);

    const afterwards = uniquePhone();

    await openWa.inboundText(session.name, afterwards, fromPhone.handoff.code);
    expect(
        (await waitForChat(wa, session, afterwards, { linked: '1' })).linked,
    ).toBe(true);

    // Only the first five messages of a chat are searched: a code in the sixth message is too late.
    const late = await requestHandoff(instance, widget, {
        name: 'Late sender',
    });
    const lateCustomer = uniquePhone();

    for (let message = 1; message <= 6; message += 1) {
        await openWa.inboundText(
            session.name,
            lateCustomer,
            message === 6
                ? `finally ${late.handoff.code}`
                : `message ${message}`,
        );
    }

    await eventually(
        async () =>
            (
                await waitForChat(wa, session, lateCustomer)
            ).lastMessagePreview?.startsWith('finally') || undefined,
        'the sixth message',
    );
    expect((await waitForChat(wa, session, lateCustomer)).linked).toBe(false);

    // A chat that is already linked is never re-linked by another code.
    const second = await requestHandoff(instance, widget, {
        name: 'Second ticket',
    });

    await openWa.inboundText(
        session.name,
        used.customer,
        `another ${second.handoff.code}`,
    );
    await eventually(
        async () =>
            (
                await waitForChat(wa, session, used.customer)
            ).lastMessagePreview?.startsWith('another') || undefined,
        'the later message',
    );
    expect(
        data<{ visitor: { name: string } }>(
            await wa.chat(used.chat.ulid),
            'detail',
        ).visitor.name,
    ).toBe('First owner');
});

test('a code that is past its time links nothing, and the hand-off endpoint is limited per visitor with a Retry-After', async ({
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const { handoff, visitor } = await requestHandoff(instance, widget, {
        name: 'Too slow',
        address: '203.0.113.50',
    });
    const customer = uniquePhone();

    // The ticket expires while the customer is still typing.
    await tinker(
        instance,
        `App\\Models\\WaHandoffTicket::where('code', getenv('E2E_CODE'))->update(['expires_at' => now()->subSecond()]); echo "AGED\\n";`,
        { E2E_CODE: handoff.code },
    );
    await openWa.inboundText(session.name, customer, handoff.code);
    expect((await waitForChat(wa, session, customer)).linked).toBe(false);

    // A visitor who asks again while their ticket is live gets the same code with 200; six asks a minute are allowed, the seventh is limited.
    const path = `/widgets/${widget.key}/whatsapp-handoff`;
    const fresh = await visitor.request('POST', path, {});

    expect(fresh.status).toBe(201);
    expect(fresh.data.code).not.toBe(handoff.code);

    const same = await visitor.request('POST', path, {});

    expect(same.status).toBe(200);
    expect(same.data.code).toBe(fresh.data.code);
    expect(Object.keys(same.data).sort()).toEqual([
        'code',
        'expiresAt',
        'waUrl',
    ]);

    const statuses: number[] = [];

    for (let ask = 0; ask < 6; ask += 1) {
        statuses.push((await visitor.request('POST', path, {})).status);
    }

    expect(
        statuses.filter((status) => status === 429).length,
    ).toBeGreaterThanOrEqual(1);

    const limited = await visitor.request('POST', path, {});

    expect(limited.status).toBe(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await visitor.dispose();
});

test.describe('the master switch', () => {
    test.use({ waMode: 'exclusive' });

    test('WhatsApp off for visitors hides the chooser everywhere and refuses the hand-off, while messages to the number are still recorded', async ({
        actors,
        adminApi,
        instance,
        openWa,
        wa,
    }) => {
        const session = await readySession(wa, openWa);
        const world = await createWorld(adminApi, instance, {
            agents: { ann: ['main'] },
            config: { features: { whatsapp: true } },
        });

        await wa.linkWidget(world.widget.ulid, session.ulid);
        await actors.account(world.agents.ann, {
            presence: 'online',
            keepAlive: true,
        });

        const before = await actors.visitor();
        const on = await openCustomerSite(before.page, instance, {
            key: world.widget.key,
            open: true,
        });

        await expect(on.tid('channel-chooser')).toBeVisible();

        data(
            await wa.saveSettings({ enabled: false }),
            'switch WhatsApp off for visitors',
        );
        await settleSettings();

        // A widget's availability is cached for 8 seconds: a visitor who arrives in that window may still be offered the choice (and is then
        // refused by the hand-off itself, below); after it the chooser is gone.
        await expect(async () => {
            const after = await actors.visitor();
            const off = await openCustomerSite(after.page, instance, {
                key: world.widget.key,
                open: true,
            });

            await expect(off.tid('channel-chooser')).toHaveCount(0, {
                timeout: 2_000,
            });
        }).toPass({ timeout: 25_000 });
        expect(await handoffRefusal(instance, world.widget)).toContain(
            'feature_disabled',
        );

        // The administrator is told on the inbox, and a customer who writes anyway is still recorded.
        const admin = await actors.staff('admin');
        const inbox = new WaInboxPage(admin.page);

        await inbox.goto();
        await expect(
            admin.page.getByTestId('wa-disabled-notice'),
        ).toContainText('WhatsApp is switched off for visitors');

        const customer = uniquePhone();

        await openWa.inboundText(session.name, customer, 'Still recorded');
        await waitForChat(wa, session, customer);
    });
});
