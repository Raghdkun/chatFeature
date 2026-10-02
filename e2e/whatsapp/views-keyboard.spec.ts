import type { Page } from '@playwright/test';
import { openCustomerSite } from '../support/panel';
import { seedInbox } from '../support/wa-seed';
import { createWorld } from '../support/world';
import { expect, readySession, test, uniqueName } from '../support/wa-test';
import { WaInboxPage, WaSettingsPage } from '../support/wa-ui';
import { data, type WaSession } from '../support/whatsapp';

/**
 * Keyboard-only operation of the WhatsApp screens (a phone has no Tab key: desktop only): the inbox (filters, opening a chat, the composer, the
 * details sheet, archiving), the Settings dialogs (focus moves in, stays in, and returns to the control that opened it), visible focus rings,
 * and the visitor's choice and code screens.
 */
test.use({ scenario: 'p6-wa' });
test.beforeEach(({ browserName: _browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a phone has no Tab key');
});

/** The test id of the element that has focus (empty when it has none). */
const focused = (page: Page): Promise<string> =>
    page.evaluate(
        () => document.activeElement?.getAttribute('data-testid') ?? '',
    );

const insideDialog = (page: Page): Promise<boolean> =>
    page.evaluate(
        () =>
            document.activeElement?.closest(
                '[role="dialog"], [role="alertdialog"]',
            ) != null,
    );

/** Presses Tab until `id` has focus (at most `max` presses). */
async function tabTo(page: Page, id: string, max = 40): Promise<void> {
    for (let press = 0; press < max; press += 1) {
        await page.keyboard.press('Tab');

        if ((await focused(page)) === id) {
            return;
        }
    }

    throw new Error(`Tab never reached ${id}`);
}

test('the inbox with the keyboard alone: filters, opening a chat, the composer, the details sheet and archiving', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    test.slow();

    const inbox = await seedInbox(adminApi, wa, openWa, instance);
    const admin = await actors.staff('admin');
    const page = admin.page;
    const view = new WaInboxPage(page);

    await view.goto();

    // The search box and a filter chip: Tab to it, Space or Enter toggles it, and it says so (aria-pressed).
    await page.getByTestId('wa-search').focus();
    await page.getByTestId('wa-search').fill(inbox.unread.customer.slice(-8));
    await expect(view.row(inbox.unread.ulid)).toBeVisible();
    await expect(view.row(inbox.main.ulid)).toHaveCount(0);
    await page.getByTestId('wa-search').fill('');
    await tabTo(page, 'wa-filter-unread');
    await expect(page.getByTestId('wa-filter-unread')).toHaveAttribute(
        'aria-pressed',
        'false',
    );
    await page.keyboard.press('Space');
    await expect(page.getByTestId('wa-filter-unread')).toHaveAttribute(
        'aria-pressed',
        'true',
    );
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-filter-unread')).toHaveAttribute(
        'aria-pressed',
        'false',
    );

    // A row is a link: Tab to it, Enter opens the chat, and the reply box has the focus (a keyboard device lands in it).
    await tabTo(page, `wa-chat-row-${inbox.main.ulid}`, 80);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-chat-view')).toBeVisible();
    await expect(view.composer).toBeFocused();

    // Typing, Shift+Enter, Enter: one message with two lines, sent; the box is empty and still focused.
    await page.keyboard.type('Keyboard only,');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('two lines.');
    await page.keyboard.press('Enter');
    await expect(view.bubble('two lines.')).toBeVisible();
    await expect(view.composer).toHaveValue('');
    await expect(view.composer).toBeFocused();
    expect(await view.bubble('two lines.').innerText()).toContain(
        'Keyboard only,\ntwo lines.',
    );

    // The send button is reachable by Tab and works with Enter / Space.
    await page.keyboard.type('Sent from the button');
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('wa-composer-send')).toBeFocused();
    await page.keyboard.press('Space');
    await expect(view.bubble('Sent from the button')).toBeVisible();

    // The details sheet opens from the info button, keeps the focus inside, and Escape gives the focus back.
    await page.getByTestId('wa-chat-info').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-details')).toBeVisible();
    expect(await insideDialog(page)).toBe(true);

    for (let press = 0; press < 12; press += 1) {
        await page.keyboard.press('Tab');
        expect(
            await insideDialog(page),
            `Tab ${press + 1} stays in the sheet`,
        ).toBe(true);
    }

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wa-details')).toBeHidden();
    await expect(page.getByTestId('wa-chat-info')).toBeFocused();

    // Archive with the keyboard.
    await page.getByTestId('wa-archive').focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-chat-archived')).toBeVisible();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-chat-archived')).toHaveCount(0);
});

test('the Settings dialogs take the focus in, keep it in, and give it back to the control that opened them', async ({
    actors,
    openWa,
    wa,
}) => {
    test.slow();

    const ready = await readySession(wa, openWa);
    const waiting = data<WaSession>(
        await wa.createSession(uniqueName('scan')),
        'create',
    );

    expect((await wa.startSession(waiting.ulid)).status).toBe(202);

    const admin = await actors.staff('admin');
    const page = admin.page;
    const settings = new WaSettingsPage(page);

    await settings.goto();

    const dialogs: [string, string, string][] = [
        ['the QR code', `wa-session-qr-${waiting.ulid}`, 'wa-qr-dialog'],
        ['the limits', `wa-session-pacing-${ready.ulid}`, 'wa-pacing-dialog'],
        ['stop', `wa-session-stop-${ready.ulid}`, 'wa-stop-dialog'],
        [
            'the webhook',
            `wa-session-webhook-reregister-${ready.ulid}`,
            'wa-webhook-dialog',
        ],
        ['delete', `wa-session-delete-${ready.ulid}`, 'wa-delete-dialog'],
    ];

    for (const [label, opener, dialog] of dialogs) {
        await page.getByTestId(opener).focus();
        await page.keyboard.press('Enter');
        await expect(page.getByTestId(dialog), label).toBeVisible();
        await expect
            .poll(() => insideDialog(page), {
                message: `${label}: the focus moved into the dialog`,
            })
            .toBe(true);

        // Tab and Shift+Tab never leave it.
        for (let press = 0; press < 10; press += 1) {
            await page.keyboard.press('Tab');
            expect(
                await insideDialog(page),
                `${label}: Tab ${press + 1} stays inside`,
            ).toBe(true);
        }

        for (let press = 0; press < 10; press += 1) {
            await page.keyboard.press('Shift+Tab');
            expect(
                await insideDialog(page),
                `${label}: Shift+Tab ${press + 1} stays inside`,
            ).toBe(true);
        }

        await page.keyboard.press('Escape');
        await expect(page.getByTestId(dialog), label).toBeHidden();
        await expect(
            page.getByTestId(opener),
            `${label}: the focus returns to what opened it`,
        ).toBeFocused();
    }

    // The limits form submits with Enter.
    await page.getByTestId(`wa-session-pacing-${ready.ulid}`).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-pacing-dialog')).toBeVisible();
    await page
        .getByTestId('wa-pacing-dialog')
        .getByLabel('Pause between messages')
        .focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('wa-pacing-dialog')).toBeHidden();
});

test('focus is visible: a ring on the inbox controls, the chips, the composer and the settings buttons, in both themes', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const inbox = await seedInbox(adminApi, wa, openWa, instance);
    const admin = await actors.staff('admin');
    const page = admin.page;
    const view = new WaInboxPage(page);
    const ring = (id: string) =>
        page.getByTestId(id).evaluate((element) => {
            const style = getComputedStyle(element);

            return `${style.boxShadow} ${style.outlineStyle} ${style.outlineWidth} ${style.borderColor}`;
        });

    await view.goto(inbox.main.ulid);

    for (const theme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: theme });

        for (const id of [
            'wa-filter-unread',
            'wa-chat-info',
            'wa-archive',
            'wa-search',
        ]) {
            await page.getByTestId(id).focus();
            await page.keyboard.press('Shift+Tab');
            await page.keyboard.press('Tab');
            expect(await focused(page), id).toBe(id);
            expect(
                await ring(id),
                `${theme}: a focus ring on ${id}`,
            ).not.toMatch(/^none 0px/);
        }

        // The composer's frame lights up when the box is focused (it is the visible ring of that control).
        await view.composer.focus();
        await expect(
            page
                .getByTestId('wa-composer')
                .locator('div.focus-within\\:ring-\\[3px\\]')
                .first(),
        ).toBeVisible();
    }
});

test("the visitor's choice and code screens by keyboard: Tab order, Enter and Space, and Back", async ({
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
    const key = (name: string) => visitor.page.keyboard.press(name);
    const inPanel = (id: string) => panel.tid(id);

    await expect(inPanel('channel-chooser')).toBeVisible();
    // The chat button is the default focus; Tab goes to WhatsApp; Enter chooses it.
    await expect(inPanel('channel-chat')).toBeFocused();
    await key('Tab');
    await expect(inPanel('channel-whatsapp')).toBeFocused();
    await key('Enter');

    // The topic picker is the chat's own: arrow / Tab to a topic, Enter picks it.
    await expect(
        inPanel(`category-option-${world.categories.billing.slug}`),
    ).toBeVisible();
    await inPanel(`category-option-${world.categories.billing.slug}`).focus();
    await key('Enter');
    await expect(inPanel('whatsapp-code')).toBeVisible();

    // The code screen: the first control is "Open WhatsApp" (the link), then Copy, I sent it, Back; Shift+Tab goes back through them.
    await expect(inPanel('whatsapp-open')).toBeFocused();
    await key('Tab');
    await expect(inPanel('whatsapp-copy')).toBeFocused();
    await key('Tab');
    await expect(inPanel('whatsapp-sent')).toBeFocused();
    await key('Tab');
    await expect(inPanel('whatsapp-back')).toBeFocused();
    await key('Shift+Tab');
    await expect(inPanel('whatsapp-sent')).toBeFocused();

    // Back by keyboard returns to the choice, and the focus lands on the first control again.
    await inPanel('whatsapp-back').focus();
    await key('Space');
    await expect(inPanel('channel-chooser')).toBeVisible();
    await expect(inPanel('channel-chat')).toBeFocused();

    // "I sent it" by keyboard: the closing note takes the focus.
    await key('Tab');
    await key('Enter');
    await inPanel(`category-option-${world.categories.sales.slug}`).focus();
    await key('Enter');
    await inPanel('whatsapp-sent').focus();
    await key('Enter');
    await expect(
        panel.frame.getByText("We'll reply on WhatsApp"),
    ).toBeVisible();
});
