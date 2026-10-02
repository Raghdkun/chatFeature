import { scanDashboard, scanPanel, settlePanel } from '../support/chat-lab';
import { expectNoHorizontalScroll } from '../support/helpers';
import { openCustomerSite } from '../support/panel';
import { seedInbox } from '../support/wa-seed';
import { createWorld } from '../support/world';
import { expect, readySession, test } from '../support/wa-test';
import { WaInboxPage, WaSettingsPage } from '../support/wa-ui';

/**
 * Right-to-left (`p6-wa-rtl`: the administrator's interface and the widget in Arabic): the WhatsApp inbox, settings and builder tab are mirrored
 * (list on the right, bubbles on their logical sides, arrows and send icon flipped, numbers and technical strings stay left to right), nothing
 * scrolls sideways, axe passes in both themes; and the visitor's chooser and code screen follow the visitor's language. The administrator's
 * UI strings are English (only the visitor's panel has Arabic texts): the pages are checked for their layout, not their wording.
 */
test.use({ scenario: 'p6-wa-rtl' });

test('the inbox is mirrored: list on the right, customer bubbles on the right and replies on the left, flipped arrows, numbers left to right', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    test.slow();

    const inbox = await seedInbox(adminApi, wa, openWa, instance);
    const admin = await actors.staff('admin');
    const page = admin.page;
    const view = new WaInboxPage(page);
    const phone = testInfo.project.name === 'mobile';

    await view.goto();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expect(view.row(inbox.unread.ulid)).toBeVisible();
    await expectNoHorizontalScroll(page);
    await scanDashboard(page, testInfo, 'wa-rtl-inbox-list');

    await view.goto(inbox.main.ulid);
    await expect(
        page
            .getByTestId(`wa-message-image-${inbox.main.pictureUlid}`)
            .locator('img'),
    ).toBeVisible();
    await expectNoHorizontalScroll(page);

    // Where things are: the customer's bubble at the start (right), ours at the end (left).
    const transcript = (await page.getByTestId('wa-transcript').boundingBox())!;
    const incoming = (await page
        .getByTestId(`wa-message-${inbox.main.messages[0].ulid}`)
        .locator('> div')
        .first()
        .boundingBox())!;
    const outgoing = (await page
        .getByTestId(
            `wa-message-${inbox.main.messages.find((message) => message.direction === 'out')!.ulid}`,
        )
        .locator('> div')
        .first()
        .boundingBox())!;

    expect(
        incoming.x + incoming.width,
        'a customer bubble hugs the right edge',
    ).toBeGreaterThan(transcript.x + transcript.width - 120);
    expect(outgoing.x, 'a reply hugs the left edge').toBeLessThan(
        transcript.x + 120,
    );

    // Two panes: the list is to the right of the chat on a wide screen (it is a separate screen on a phone).
    if (!phone) {
        const list = (await page.getByTestId('wa-chat-list').boundingBox())!;
        const chat = (await page.getByTestId('wa-chat-view').boundingBox())!;

        expect(list.x, 'the list is on the right').toBeGreaterThan(chat.x);
    } else {
        // The back arrow points the other way: its icon is mirrored.
        const scale = await page
            .getByTestId('wa-chat-back')
            .locator('svg')
            .evaluate((icon) => getComputedStyle(icon).scale);

        expect(scale).toMatch(/^-1\b/);
    }

    // The send icon is mirrored; the phone number and the session name read left to right.
    await expect(page.getByTestId('wa-composer-send').locator('svg')).toHaveCSS(
        'scale',
        /^-1\b/,
    );
    await expect(
        page.getByTestId('wa-chat-header').locator('span[dir="ltr"]').first(),
    ).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-rtl-chat');

    await page.getByTestId('wa-chat-info').click();
    await expect(page.getByTestId('wa-details')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await scanDashboard(page, testInfo, 'wa-rtl-details');
});

test('Settings > WhatsApp, its limits dialog and the builder tab are mirrored, and technical strings stay left to right', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);

    const admin = await actors.staff('admin');
    const page = admin.page;
    const settings = new WaSettingsPage(page);

    await settings.goto();
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expectNoHorizontalScroll(page);

    // Addresses, keys, names and the webhook URL are code: left to right inside the mirrored form.
    for (const id of ['wa-base-url', 'wa-session-name']) {
        await expect(page.getByTestId(id)).toHaveAttribute('dir', 'ltr');
    }

    await expect(
        page.getByTestId(`wa-session-name-${session.ulid}`),
    ).toHaveAttribute('dir', 'ltr');
    await expect(
        page.getByTestId(`wa-session-webhook-url-${session.ulid}`),
    ).toHaveAttribute('dir', 'ltr');
    await scanDashboard(page, testInfo, 'wa-rtl-settings');

    await page.getByTestId(`wa-session-pacing-${session.ulid}`).click();
    await expect(page.getByTestId('wa-pacing-dialog')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-rtl-limits');
    await page.getByTestId('wa-pacing-cancel').click();

    // The builder tab.
    await page.goto(`/widgets/${world.widget.ulid}`);
    await expect(page.getByTestId('builder-page')).toBeVisible();
    await page.getByTestId('builder-tab-whatsapp').click();
    await expect(page.getByTestId('builder-whatsapp-session')).toBeVisible();
    await expectNoHorizontalScroll(page);
    await expect(page.getByTestId('builder-whatsapp-link')).toHaveAttribute(
        'dir',
        'ltr',
    );
    await scanDashboard(page, testInfo, 'wa-rtl-builder', {
        exclude: ['iframe'],
    });
});

test("the visitor's choice and code screens follow the visitor's language: Arabic, right to left, the code and the link left to right", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        categories: ['billing'],
        agents: { ann: ['billing'] },
        settings: { locale: 'ar' },
        config: { defaultLocale: 'ar', features: { whatsapp: true } },
    });
    const offline = await createWorld(adminApi, instance, {
        agents: {},
        settings: { locale: 'ar' },
        config: { defaultLocale: 'ar', features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);
    await wa.linkWidget(offline.widget.ulid, session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    // The visitor's browser speaks Arabic in this scenario: so does the panel.
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await expect(panel.tid('channel-chooser')).toBeVisible();
    await settlePanel(panel);
    await expect(panel.frame.locator('html')).toHaveAttribute('dir', 'rtl');
    // Arabic texts, not the English fallbacks.
    await expect(panel.tid('channel-whatsapp')).not.toContainText(
        'Continue on WhatsApp',
    );
    await expect(panel.tid('channel-whatsapp')).toContainText(/[؀-ۿ]/);
    await scanPanel(panel, testInfo, 'wa-rtl-panel-choice');

    await panel.tid('channel-whatsapp').click();
    await expect(panel.tid('whatsapp-code')).toBeVisible();
    await expect(panel.tid('whatsapp-code')).toHaveAttribute('dir', 'ltr');

    // The "open" arrow is mirrored with the layout, the link still goes to WhatsApp, the code is selectable text.
    await expect(panel.tid('whatsapp-open')).toHaveAttribute(
        'href',
        new RegExp(`^https://wa\\.me/${session.phone}\\?text=`),
    );
    await expect(panel.tid('whatsapp-open').locator('svg').first()).toHaveCSS(
        'scale',
        /^-1\b/,
    );
    await scanPanel(panel, testInfo, 'wa-rtl-panel-code');

    // Nobody online: the offline form with the alternative.
    const lonely = await actors.visitor();
    const second = await openCustomerSite(lonely.page, instance, {
        key: offline.widget.key,
        open: true,
    });

    await second.expectState('offline');
    await expect(second.tid('channel-chooser')).toBeVisible();
    await scanPanel(second, testInfo, 'wa-rtl-panel-offline');
});
