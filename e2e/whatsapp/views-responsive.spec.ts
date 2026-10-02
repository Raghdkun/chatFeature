import type { Locator, Page } from '@playwright/test';
import { expectInsideViewportWidth, settlePanel } from '../support/chat-lab';
import { expectNoHorizontalScroll } from '../support/helpers';
import { openCustomerSite } from '../support/panel';
import { asBase64, smallPng } from '../support/wa-images';
import { linkedChat, whatsappWidget } from '../support/wa-flow';
import { createWorld } from '../support/world';
import {
    expect,
    readySession,
    test,
    uniqueName,
    uniquePhone,
    waitForChat,
    waitForMessage,
} from '../support/wa-test';
import { WaInboxPage, WaSettingsPage } from '../support/wa-ui';
import { data, eventually, type WaSession } from '../support/whatsapp';

/**
 * The WhatsApp screens at 375 px, at 320 px and on a short phone (420 px high): no sideways scrolling, long unbroken names, URLs, file names
 * and errors wrap inside their boxes, dialogs and sheets stay inside the screen with their primary action in reach, the composer stays on
 * screen with its send button, and the visitor panel is the full screen with every control reachable. Desktop project only: these tests set
 * their own viewport (the `mobile` project's emulation adds nothing to a 375 px window).
 */
test.use({ scenario: 'p6-wa' });
test.beforeEach(({ browserName: _browser }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'sets its own viewports');
});

const WIDTHS = [375, 320] as const;
const LONG_NAME =
    'Bartholomew-Alexander-Montgomery-Featherstonehaugh-Cholmondeley-Marjoribanks';
const LONG_TOKEN = 'x'.repeat(120);
const LONG_URL = `https://example.com/a/very/long/path/${'segment-'.repeat(14)}end?token=${'t'.repeat(60)}`;

/** Waits until the element stopped moving (sheets and dialogs slide and zoom in), then checks it lies inside the screen's width. */
async function insideScreen(
    locator: Locator,
    page: Page,
    label: string,
): Promise<void> {
    let last = '';

    await expect
        .poll(
            async () => {
                const now = JSON.stringify(await locator.boundingBox());
                const same = now === last && now !== 'null';

                last = now;

                return same;
            },
            { message: `${label} stopped moving`, intervals: [50, 100, 100] },
        )
        .toBe(true);
    await expectInsideViewportWidth(locator, page, label);
}

async function onScreen(
    locator: Locator,
    page: Page,
    label: string,
): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await insideScreen(locator, page, label);

    const box = await locator.boundingBox();
    const height = page.viewportSize()!.height;

    expect(
        box!.y + box!.height,
        `${label} is on the screen vertically`,
    ).toBeLessThanOrEqual(height + 1);
}

test('the inbox at 375 and 320 px: the list, a chat full of long strings, the composer, the details sheet, the filters', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const customer = uniquePhone();

    await openWa.inboundText(
        session.name,
        customer,
        `${LONG_TOKEN} and then ${LONG_URL}`,
        { pushName: LONG_NAME },
    );
    await openWa.inbound(session.name, {
        from: customer,
        type: 'document',
        body: '',
        pushName: LONG_NAME,
        media: {
            mimetype: 'application/pdf',
            filename: `${'quarterly-report-'.repeat(7)}final.pdf`,
            sizeBytes: 1_234_567,
            omitted: true,
            stored: false,
        },
    });
    await openWa.inbound(session.name, {
        from: customer,
        type: 'image',
        body: 'A picture next to the long things',
        pushName: LONG_NAME,
        media: {
            mimetype: 'image/png',
            filename: 'p.png',
            dataBase64: asBase64(smallPng(160)),
        },
    });

    const chat = await waitForChat(wa, session, customer);
    const picture = await waitForMessage(
        wa,
        chat,
        (message) =>
            message.type === 'image' &&
            (message as unknown as { media: { available: boolean } }).media
                .available,
    );

    expect(
        (
            await wa.reply(
                chat.ulid,
                `Replying with ${LONG_URL} and ${LONG_TOKEN}`,
            )
        ).status,
    ).toBe(201);
    await linkedChat(openWa, wa, instance, session, widget, {
        name: LONG_NAME,
        email: `${'very-long-local-part-'.repeat(4)}@example.test`,
        category: 'billing',
        customer: uniquePhone(),
        pushName: LONG_NAME,
    });

    const admin = await actors.staff('admin');
    const page = admin.page;
    const inbox = new WaInboxPage(page);

    for (const width of WIDTHS) {
        await page.setViewportSize({ width, height: 800 });

        // The list screen.
        await inbox.goto();
        await expect(inbox.row(chat.ulid)).toBeVisible();
        await expectNoHorizontalScroll(page);
        await insideScreen(inbox.row(chat.ulid), page, `list row at ${width}`);
        await page.getByTestId('wa-export').locator('summary').click();
        await expectNoHorizontalScroll(page);

        // The conversation: no overflow, every bubble inside the screen, the picture scaled, the composer reachable.
        await inbox.goto(chat.ulid);
        await expect(
            page.getByTestId(`wa-message-image-${picture.ulid}`).locator('img'),
        ).toBeVisible();
        await expectNoHorizontalScroll(page);

        for (const bubble of await page
            .getByTestId('wa-transcript')
            .locator('li[data-testid^="wa-message-"]')
            .all()) {
            await insideScreen(bubble, page, `a bubble at ${width}`);
        }

        await insideScreen(
            page.getByTestId('wa-chat-header'),
            page,
            `header at ${width}`,
        );
        await onScreen(inbox.composer, page, `composer at ${width}`);
        await onScreen(inbox.send, page, `send button at ${width}`);

        // The details sheet: inside the screen, scrollable, closable.
        await page.getByTestId('wa-chat-info').click();
        await expect(page.getByTestId('wa-details')).toBeVisible();
        await insideScreen(
            page.getByTestId('wa-details'),
            page,
            `details at ${width}`,
        );
        await expectNoHorizontalScroll(page);
        await page.keyboard.press('Escape');
        await expect(page.getByTestId('wa-details')).toBeHidden();

        // Typing a long reply keeps the composer (it grows, then scrolls) and the send button on screen.
        await inbox.composer.fill(
            `${LONG_TOKEN}\n${LONG_URL}\nline three\nline four\nline five\nline six\nline seven\nline eight\nline nine\nline ten`,
        );
        await onScreen(
            inbox.send,
            page,
            `send button with a long text at ${width}`,
        );
        await expectNoHorizontalScroll(page);
        await inbox.composer.fill('');
    }

    // A short phone (420 px high, the keyboard is up): the composer is still reachable.
    await page.setViewportSize({ width: 375, height: 420 });
    await inbox.goto(chat.ulid);
    await onScreen(inbox.composer, page, 'composer on a short phone');
    await onScreen(inbox.send, page, 'send button on a short phone');
});

test('Settings > WhatsApp at 375 and 320 px: long session names, URLs and errors wrap, and every dialog stays inside the screen with its action in reach', async ({
    actors,
    openWa,
    wa,
}) => {
    test.slow();

    const long = `${uniqueName('l')}-${'a'.repeat(50)}`.slice(0, 50);
    const failedName = uniqueName('broken');
    const ready = await readySession(wa, openWa, { name: long });
    const failed = data<WaSession>(
        await wa.createSession(failedName),
        'create',
    );

    expect((await wa.startSession(failed.ulid)).status).toBe(202);

    /** The engine crashes (again): the session is `failed` with a long reason, which the page shows after the app has read it. */
    const crash = async (): Promise<void> => {
        // The engine's first webhooks arrive a moment after the start call: let them land before it "crashes".
        await eventually(async () => {
            const result = await wa.sessionQr(failed.ulid);

            return result.status === 200 ? result : undefined;
        }, 'the session to wait for a scan');
        await openWa.setStatus(failedName, 'failed', {
            reason: `Chromium crashed: ${LONG_TOKEN} ${LONG_URL}`,
        });
        expect((await wa.syncSession(failed.ulid)).status).toBe(200);
        await eventually(async () => {
            const session = data<WaSession>(
                await wa.session(failed.ulid),
                'read the session',
            );

            return session.status === 'failed' && session.lastError !== null
                ? session
                : undefined;
        }, 'the session to be marked failed, with the reason');
    };

    const admin = await actors.staff('admin');
    const page = admin.page;
    const settings = new WaSettingsPage(page);

    for (const width of WIDTHS) {
        // The QR dialog below starts the session again: break it again for every width.
        await crash();
        await page.setViewportSize({ width, height: 800 });
        await settings.goto();
        await expect(settings.row(failed.ulid)).toContainText(
            'Chromium crashed',
        );
        await expectNoHorizontalScroll(page);
        await insideScreen(
            settings.row(ready.ulid),
            page,
            `a session at ${width}`,
        );
        await insideScreen(
            settings.row(failed.ulid),
            page,
            `a failed session at ${width}`,
        );
        await insideScreen(
            page.getByTestId('wa-connection-card'),
            page,
            `the connection card at ${width}`,
        );
        await insideScreen(
            page.getByTestId('wa-behavior-card'),
            page,
            `the behaviour card at ${width}`,
        );

        // Each dialog: inside the screen, its confirming button reachable.
        const dialogs: [string, Locator, Locator][] = [
            [
                'the limits',
                page.getByTestId(`wa-session-pacing-${ready.ulid}`),
                page.getByTestId('wa-pacing-save'),
            ],
            [
                'stop',
                settings.button('stop', ready.ulid),
                page.getByRole('button', { name: 'Stop session' }),
            ],
            [
                'the webhook',
                settings.button('webhook-reregister', ready.ulid),
                page.getByRole('button', { name: 'Register again' }),
            ],
            [
                'delete',
                settings.button('delete', ready.ulid),
                page.getByRole('button', { name: 'Delete session' }),
            ],
        ];

        for (const [label, opener, confirm] of dialogs) {
            await opener.scrollIntoViewIfNeeded();
            await opener.click();
            await expect(confirm).toBeVisible();
            await insideScreen(
                page.locator('[role="dialog"], [role="alertdialog"]'),
                page,
                `${label} dialog at ${width}`,
            );
            await onScreen(confirm, page, `${label} button at ${width}`);
            await page.keyboard.press('Escape');
            await expect(
                page.locator('[role="dialog"], [role="alertdialog"]'),
            ).toBeHidden();
        }

        // The QR dialog of a session waiting for a scan.
        await settings.button('start', failed.ulid).click();
        await expect(settings.qrDialog).toBeVisible();
        await insideScreen(
            page.getByTestId('wa-qr-tile'),
            page,
            `the QR tile at ${width}`,
        );
        await onScreen(
            page.getByTestId('wa-qr-close'),
            page,
            `the QR dialog's close button at ${width}`,
        );
        await page.getByTestId('wa-qr-close').click();
    }
});

test("the builder's WhatsApp tab and the visitor's screens at 375 and 320 px", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        categories: ['billing'],
        agents: { ann: ['billing'] },
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    const admin = await actors.staff('admin');

    for (const width of WIDTHS) {
        await admin.page.setViewportSize({ width, height: 800 });
        await admin.page.goto(`/widgets/${world.widget.ulid}`);
        await expect(admin.page.getByTestId('builder-page')).toBeVisible();
        await admin.page.getByTestId('builder-tab-whatsapp').click();
        await expect(
            admin.page.getByTestId('builder-whatsapp-session'),
        ).toBeVisible();
        await expectNoHorizontalScroll(admin.page);
        await insideScreen(
            admin.page.getByTestId('builder-whatsapp-checks'),
            admin.page,
            `the checklist at ${width}`,
        );
        await insideScreen(
            admin.page.getByTestId('builder-whatsapp-link'),
            admin.page,
            `the link preview at ${width}`,
        );
    }

    for (const width of WIDTHS) {
        const visitor = await actors.visitor();

        await visitor.page.setViewportSize({ width, height: 640 });

        const panel = await openCustomerSite(visitor.page, instance, {
            key: world.widget.key,
            open: true,
        });

        await settlePanel(panel);
        await expect(panel.tid('channel-chooser')).toBeVisible();
        await onScreen(
            panel.tid('channel-whatsapp'),
            visitor.page,
            `the WhatsApp choice at ${width}`,
        );
        await panel.tid('channel-whatsapp').click();
        await expect(panel.tid('whatsapp-code')).toBeVisible();

        // The code (32 px, spaced) fits the screen at 320 px, and so does every control below it.
        const box = (await panel.tid('whatsapp-code').boundingBox())!;

        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width + 0.5);

        for (const id of [
            'whatsapp-open',
            'whatsapp-copy',
            'whatsapp-sent',
            'whatsapp-back',
        ]) {
            await panel.tid(id).scrollIntoViewIfNeeded();
            await expect(panel.tid(id)).toBeVisible();
        }

        await expectNoHorizontalScroll(visitor.page);
    }
});
