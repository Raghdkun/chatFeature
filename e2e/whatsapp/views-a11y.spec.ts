import type { Page } from '@playwright/test';
import { scanDashboard, scanPanel, settlePanel } from '../support/chat-lab';
import { openCustomerSite } from '../support/panel';
import { createWorld } from '../support/world';
import { seedInbox } from '../support/wa-seed';
import {
    expect,
    readySession,
    restoreConnection,
    settleSettings,
    test,
    uniqueName,
    uniquePhone,
    waitForChat,
} from '../support/wa-test';
import { WaInboxPage, WaSettingsPage } from '../support/wa-ui';
import { data, eventually, type WaSession } from '../support/whatsapp';

/**
 * axe (WCAG 2.x A and AA, light and dark, desktop and phone) on every WhatsApp screen of the administrator and of the visitor: the inbox (list,
 * an open chat with a picture, ticks, a failure and a document, the details sheet, the filters and the export), Settings > WhatsApp in every
 * state (each session status, the QR dialog, the limits, stop / delete / webhook dialogs, the connection test results, the validation errors),
 * the builder's WhatsApp tab, and the panel's chooser and hand-off screens. A violation fails the test (`scanDashboard` / `scanPanel`).
 */
test.use({ scenario: 'p6-wa' });

const settleFonts = async (page: Page) => {
    await page.evaluate(() => document.fonts.ready);
};

test('the inbox: the list, an open chat with a picture, ticks, a failed reply and a document, the details sheet, the filters and the export', async ({
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

    // The list (on a phone it is the whole screen), with an unread chat, a linked one and the filters.
    await view.goto();
    await expect(view.row(inbox.unread.ulid)).toBeVisible();
    await expect(view.row(inbox.linked.ulid)).toBeVisible();
    await settleFonts(page);
    await scanDashboard(page, testInfo, 'wa-inbox-list');

    // The filters and the export links, opened.
    await page.getByTestId('wa-export').locator('summary').click();
    await expect(page.getByTestId('wa-export-messages-csv')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-inbox-filters-export');

    // No match.
    await view.search.fill('nothing-like-this-zzqx');
    await expect(page.getByTestId('wa-list-no-match')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-inbox-no-match');
    await view.search.fill('');

    // An open conversation: text, a picture, a document card, a link, replies read / delivered / sent and one that failed.
    await view.goto(inbox.main.ulid);
    await expect(
        page
            .getByTestId(`wa-message-image-${inbox.main.pictureUlid}`)
            .locator('img'),
    ).toBeVisible();
    await expect(
        page.getByTestId(`wa-message-failure-${inbox.main.failedUlid}`),
    ).toBeVisible();
    await settleFonts(page);
    await scanDashboard(page, testInfo, 'wa-chat-open');

    // The details sheet.
    await page.getByTestId('wa-chat-info').click();
    await expect(page.getByTestId('wa-details')).toBeVisible();
    await settleFonts(page);
    await scanDashboard(page, testInfo, 'wa-chat-details');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('wa-details')).toBeHidden();

    // A linked chat's details name the website visit.
    await view.goto(inbox.linked.ulid);
    await page.getByTestId('wa-chat-info').click();
    await expect(page.getByTestId('wa-details-code')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-chat-details-linked');
    await page.keyboard.press('Escape');

    // An archived chat, with its note.
    await view.goto(inbox.archived.ulid);
    await expect(page.getByTestId('wa-chat-archived')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-chat-archived');

    // A chat the customer never started: the composer is replaced by the reason.
    const phoneOnly = uniquePhone();

    await openWa.inboundFromMe(
        inbox.session.name,
        phoneOnly,
        'Hello from the phone first',
    );

    const unanswerable = await waitForChat(wa, inbox.session, phoneOnly);

    await view.goto(unanswerable.ulid);
    await expect(page.getByTestId('wa-composer-disabled')).toBeVisible();
    await scanDashboard(page, testInfo, 'wa-chat-cannot-reply');

    // A disconnected number: the other reason (a chat the customer never started keeps its own, first).
    await openWa.setStatus(inbox.session.name, 'disconnected', {
        reason: 'LOGOUT',
    });
    await eventually(async () => {
        const session = data<WaSession>(
            await wa.session(inbox.session.ulid),
            'read the session',
        );

        return session.status === 'disconnected' ? session : undefined;
    }, 'the app to know the number is disconnected');
    await view.goto(inbox.main.ulid);
    await expect(page.getByTestId('wa-composer-disabled')).toHaveAttribute(
        'data-reason',
        'session_not_ready',
    );
    await scanDashboard(page, testInfo, 'wa-chat-session-down');

    if (phone) {
        // The phone's list screen with the chat row selected state is the same as above; nothing more to scan.
        await expect(page.getByTestId('wa-chat-back')).toBeVisible();
    }
});

test.describe('an inbox with nothing in it', () => {
    test.use({ waMode: 'exclusive', waWipe: true });

    test('the empty list and the "pick a chat" pane (WhatsApp off for visitors adds a notice)', async ({
        actors,
        wa,
    }, testInfo) => {
        const admin = await actors.staff('admin');
        const view = new WaInboxPage(admin.page);

        await view.goto();
        await expect(admin.page.getByTestId('wa-list-empty')).toBeVisible();
        await settleFonts(admin.page);
        await scanDashboard(admin.page, testInfo, 'wa-inbox-empty');

        data(
            await wa.saveSettings({ enabled: false }),
            'switch WhatsApp off for visitors',
        );
        await settleSettings();
        await view.goto();
        await expect(
            admin.page.getByTestId('wa-disabled-notice'),
        ).toBeVisible();
        await scanDashboard(
            admin.page,
            testInfo,
            'wa-inbox-empty-switched-off',
        );
    });
});

test('Settings > WhatsApp in every state: a session of each status, the QR dialog, the limits, the stop, delete and webhook dialogs', async ({
    actors,
    openWa,
    wa,
}, testInfo) => {
    test.slow();

    const names = {
        created: uniqueName('fresh'),
        starting: uniqueName('warm'),
        qr: uniqueName('scan'),
        failed: uniqueName('broken'),
    };
    const ready = await readySession(wa, openWa);
    const created = data<WaSession>(
        await wa.createSession(names.created),
        'create',
    );
    const starting = data<WaSession>(
        await wa.createSession(names.starting),
        'create',
    );
    const qr = data<WaSession>(await wa.createSession(names.qr), 'create');
    const failed = data<WaSession>(
        await wa.createSession(names.failed),
        'create',
    );

    // `qr`: started, waiting for a scan. `starting` and `failed`: the mock says so and the webhook tells the app.
    expect((await wa.startSession(qr.ulid)).status).toBe(202);
    expect((await wa.startSession(starting.ulid)).status).toBe(202);
    await openWa.setStatus(names.starting, 'initializing');
    expect((await wa.startSession(failed.ulid)).status).toBe(202);
    await openWa.setStatus(names.failed, 'failed', {
        reason: 'Chromium crashed: Protocol error (Target.setAutoAttach): Target closed',
    });

    const admin = await actors.staff('admin');
    const settings = new WaSettingsPage(admin.page);

    await settings.goto();

    for (const [ulid, status] of [
        [created.ulid, 'created'],
        [starting.ulid, 'starting'],
        [qr.ulid, 'qr'],
        [failed.ulid, 'failed'],
        [ready.ulid, 'ready'],
    ] as const) {
        await settings.expectStatus(ulid, status);
    }

    await expect(admin.page.getByTestId('wa-risk-notice')).toBeVisible();
    await settleFonts(admin.page);
    await scanDashboard(admin.page, testInfo, 'wa-settings');

    // Dialogs: the QR code, the limits, stop, delete, the webhook.
    await settings.button('qr', qr.ulid).click();
    await expect(admin.page.getByTestId('wa-qr-image')).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-qr');
    await admin.page.getByTestId('wa-qr-close').click();
    await admin.page.getByTestId(`wa-session-pacing-${ready.ulid}`).click();
    await expect(admin.page.getByTestId('wa-pacing-dialog')).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-limits');
    await admin.page.getByTestId('wa-pacing-cancel').click();
    await settings.button('stop', ready.ulid).click();
    await expect(admin.page.getByTestId('wa-stop-dialog')).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-stop');
    await admin.page.getByRole('button', { name: 'Cancel' }).click();
    await settings.button('webhook-reregister', ready.ulid).click();
    await expect(admin.page.getByTestId('wa-webhook-dialog')).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-webhook');
    await admin.page.getByRole('button', { name: 'Cancel' }).click();
    await settings.button('delete', ready.ulid).click();
    await expect(admin.page.getByTestId('wa-delete-dialog')).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-delete');
    await admin.page.getByRole('button', { name: 'Cancel' }).click();

    // Validation: a bad session name, an empty hand-off text.
    await settings.createSession('x');
    await expect(admin.page.getByTestId('wa-sessions-card')).toContainText(
        'Use 3 to 50 characters.',
    );
    await scanDashboard(admin.page, testInfo, 'wa-settings-name-error');
    await admin.page
        .getByTestId('wa-setting-handoff-text')
        .fill('no placeholder here');
    await admin.page.getByTestId('wa-behavior-save').click();
    await expect(
        admin.page.getByText('The message must contain :code', {
            exact: false,
        }),
    ).toBeVisible();
    await scanDashboard(admin.page, testInfo, 'wa-settings-behavior-error');

    // The connection test result.
    await settings.goto();
    await admin.page.getByTestId('wa-connection-test').click();
    await expect(admin.page.getByTestId('wa-test-result')).toHaveAttribute(
        'data-status',
        'ok',
    );
    await scanDashboard(admin.page, testInfo, 'wa-settings-test-ok');
});

test.describe('the connection test failing', () => {
    test.use({ waMode: 'exclusive' });

    test('a wrong key and an unreachable address, with their explanations', async ({
        actors,
        openWa,
        wa,
    }, testInfo) => {
        const admin = await actors.staff('admin');
        const settings = new WaSettingsPage(admin.page);

        try {
            await settings.goto();
            await admin.page.getByTestId('wa-api-key').fill('owa_k1_wrong');
            await admin.page.getByTestId('wa-connection-save').click();
            await expect(admin.page.getByTestId('wa-api-key')).toHaveValue('');
            await settleSettings();
            await admin.page.getByTestId('wa-connection-test').click();
            await expect(
                admin.page.getByTestId('wa-test-result'),
            ).toHaveAttribute('data-reason', 'unauthorized');
            await scanDashboard(
                admin.page,
                testInfo,
                'wa-settings-test-unauthorized',
            );

            const viewer = await openWa.createKey('viewer');

            await admin.page.getByTestId('wa-api-key').fill(viewer.key);
            await admin.page.getByTestId('wa-connection-save').click();
            await settleSettings();
            await admin.page.getByTestId('wa-connection-test').click();
            await expect(
                admin.page.getByTestId('wa-test-cannot-operate'),
            ).toBeVisible();
            await scanDashboard(
                admin.page,
                testInfo,
                'wa-settings-test-viewer',
            );

            await admin.page
                .getByTestId('wa-base-url')
                .fill('http://127.0.0.1:8368');
            await admin.page.getByTestId('wa-api-key').fill(openWa.apiKey);
            await admin.page.getByTestId('wa-connection-save').click();
            await settleSettings();
            await admin.page.getByTestId('wa-connection-test').click();
            await expect(
                admin.page.getByTestId('wa-test-result'),
            ).toHaveAttribute('data-reason', 'unreachable');
            await scanDashboard(
                admin.page,
                testInfo,
                'wa-settings-test-unreachable',
            );
        } finally {
            await restoreConnection(wa, openWa);
        }
    });
});

test("the widget builder's WhatsApp tab: nothing chosen, serving, and a number that went away", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: false } },
    });
    const admin = await actors.staff('admin');
    const page = admin.page;
    const open = async () => {
        await page.goto(`/widgets/${world.widget.ulid}`);
        await expect(page.getByTestId('builder-page')).toBeVisible();
        await page.getByTestId('builder-tab-whatsapp').click();
        await expect(
            page.getByTestId('builder-whatsapp-session'),
        ).toBeVisible();
    };

    await open();
    await scanDashboard(page, testInfo, 'wa-builder-nothing');

    await page
        .getByTestId('builder-whatsapp-session')
        .selectOption(session.ulid);
    await page.getByTestId('builder-whatsapp-feature').click();
    await page.getByTestId('builder-save').click();
    await expect(page.getByTestId('builder-status-message')).toHaveAttribute(
        'data-tone',
        'success',
    );
    await page.getByTestId('builder-publish').click();
    await page.getByTestId('builder-publish-confirm').click();
    await expect(page.getByTestId('builder-badge-published')).toBeVisible();
    await expect(page.getByTestId('builder-whatsapp-checks')).toHaveAttribute(
        'data-serving',
        'true',
    );
    await scanDashboard(page, testInfo, 'wa-builder-serving');

    await openWa.setStatus(session.name, 'disconnected', { reason: 'LOGOUT' });
    await eventually(
        async () =>
            data<WaSession>(await wa.session(session.ulid), 'read').status ===
                'disconnected' || undefined,
        'the disconnect',
    );
    await open();
    await expect(page.getByTestId('builder-whatsapp-checks')).toHaveAttribute(
        'data-serving',
        'false',
    );
    await scanDashboard(page, testInfo, 'wa-builder-disconnected');
});

test("the visitor's screens: the channel choice, the topic picker, the code, an expired code, the offline choice and the closing note", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}, testInfo) => {
    test.slow();

    const session = await readySession(wa, openWa);
    const world = await createWorld(adminApi, instance, {
        categories: ['billing', 'sales'],
        agents: { ann: ['billing', 'sales'] },
        config: { features: { whatsapp: true } },
    });
    const offline = await createWorld(adminApi, instance, {
        agents: {},
        config: { features: { whatsapp: true } },
    });

    await wa.linkWidget(world.widget.ulid, session.ulid);
    await wa.linkWidget(offline.widget.ulid, session.ulid);
    await actors.account(world.agents.ann, {
        presence: 'online',
        keepAlive: true,
    });

    // Online: the choice, the topic picker, the code.
    const visitor = await actors.visitor();
    let expire = false;

    await visitor.page.route(
        '**/api/v1/public/widgets/*/whatsapp-handoff',
        async (route) => {
            const response = await route.fetch();
            const body = await response.json();

            if (expire) {
                body.data.expiresAt = new Date(
                    Date.now() + 2_500,
                ).toISOString();
            }

            await route.fulfill({ response, json: body });
        },
    );

    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
    });

    await expect(panel.tid('channel-chooser')).toBeVisible();
    await settlePanel(panel);
    await scanPanel(panel, testInfo, 'wa-panel-choice');
    await panel.tid('channel-whatsapp').click();
    await expect(
        panel.tid(`category-option-${world.categories.billing.slug}`),
    ).toBeVisible();
    await scanPanel(panel, testInfo, 'wa-panel-topics');
    await panel.tid(`category-option-${world.categories.billing.slug}`).click();
    await expect(panel.tid('whatsapp-code')).toBeVisible();
    await scanPanel(panel, testInfo, 'wa-panel-code');

    // After the code has run out.
    await panel.tid('whatsapp-back').click();
    expire = true;
    await panel.tid('channel-whatsapp').click();
    await panel.tid(`category-option-${world.categories.sales.slug}`).click();
    await expect(panel.tid('whatsapp-expiry')).toHaveAttribute(
        'data-expired',
        'true',
        // The panel's clock ticks every 15 s.
        { timeout: 30_000 },
    );
    await scanPanel(panel, testInfo, 'wa-panel-expired');
    expire = false;
    await panel.tid('whatsapp-new-code').click();
    await expect(panel.tid('whatsapp-open')).toBeVisible();

    // The closing note.
    await panel.tid('whatsapp-sent').click();
    await expect(
        panel.frame.getByText("We'll reply on WhatsApp"),
    ).toBeVisible();
    await scanPanel(panel, testInfo, 'wa-panel-closed');

    // Nobody online: the offline form with the WhatsApp alternative, and the code from there.
    const lonely = await actors.visitor();
    const second = await openCustomerSite(lonely.page, instance, {
        key: offline.widget.key,
        open: true,
    });

    await second.expectState('offline');
    await expect(second.tid('channel-chooser')).toBeVisible();
    await scanPanel(second, testInfo, 'wa-panel-offline-choice');
    await second.tid('channel-whatsapp').click();
    await expect(second.tid('whatsapp-code')).toBeVisible();
    await scanPanel(second, testInfo, 'wa-panel-offline-code');
});
