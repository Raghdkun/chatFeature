import {
    expect,
    png,
    scanDashboard,
    scanPanel,
    scanToasts,
    sendImageAsAgent,
    sendImageAsVisitor,
    test,
} from '../support/chat-lab';
import { openCustomerSite } from '../support/panel';
import { must } from '../support/chat-api';
import { dismiss, setTheme } from '../support/helpers';

/**
 * axe (WCAG A/AA, plus the best-practice rules reported) on the agent screens of the live chat, each in the light and the dark theme,
 * in the states a real shift produces them: an empty inbox, offers waiting, an open conversation with an image, a typing visitor and
 * the system line of the claim, the dialogs behind the header buttons, the history with filters and results, the offline tickets.
 *
 * Every test builds its own tenant (`lab.tenant()`: categories, agents and a widget that belong to the test alone), so the shared
 * scenario never changes what another spec or the other project sees. Violations are product bugs: a WCAG A/AA failure fails the test.
 */
test.use({ scenario: 'p4-chat-views' });

// Several workers, two projects and other suites share one machine: a screen full of axe scans needs more than the default minute.
test.describe.configure({ timeout: 120_000 });

test.describe('agent inbox', () => {
    test('empty, with offers, and with an open conversation (image, typing, system line)', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant({ agents: 2, categories: 2 });
        const alice = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });

        // Empty: nothing waiting, no chats yet.
        await expect(alice.inbox.tid('inbox-queue-empty')).toBeVisible();
        await expect(alice.inbox.tid('inbox-mine-empty')).toBeVisible();
        await scanDashboard(alice.page, testInfo, 'inbox-empty');

        // Two offers (different topics, one with a long first message).
        const maya = await lab.chat(tenant, {
            name: 'Maya Thompson',
            email: 'maya.thompson@example.org',
            message:
                'Hi, I was charged twice for order #48213 and I would like to understand why before I contact my bank about it.',
        });
        const daniel = await lab.chat(tenant, {
            category: 1,
            name: 'Daniel Okafor',
            message: 'Do you ship to Lagos?',
        });

        await alice.inbox.expectOffer(maya.ulid);
        await alice.inbox.expectOffer(daniel.ulid);
        await scanDashboard(alice.page, testInfo, 'inbox-offers');

        // Accept Maya's chat the way an agent does (the Accept button), then fill the conversation.
        await alice.inbox.accept(maya.ulid);
        must(
            await maya.visitor.send(
                maya.ulid,
                'Here is the email from my bank.',
            ),
            'visitor message',
        );
        must(
            await alice.api.send(
                maya.ulid,
                'Hello Maya, let me check that for you. See https://example.com/help/duplicate-charges for how holds work.',
            ),
            'agent message',
        );
        await sendImageAsVisitor(maya, png(), 'The statement');
        must(await maya.visitor.typing(maya.ulid, true), 'typing');

        await alice.inbox.expectMessage('Here is the email');
        await alice.inbox.expectMessage('The statement');
        await expect(alice.inbox.tid('typing-indicator')).toBeVisible();
        await scanDashboard(alice.page, testInfo, 'inbox-conversation');

        // Cleanup: end what this test started (the offer of Daniel is cancelled by the visitor).
        must(await daniel.visitor.cancel(daniel.ulid), 'cancel');
        must(await alice.api.end(maya.ulid), 'end');
    });
});

test.describe('agent inbox toasts', () => {
    test('the new chat request toast, with its Accept action, in both themes', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });

        for (const theme of ['light', 'dark'] as const) {
            await setTheme(agent.page, theme);

            // A request arrives while the theme is already set: its toast appears, and is looked at while it stays (12 s).
            const chat = await lab.chat(tenant, {
                name: 'Maya Thompson',
                message: `Hello (${theme})`,
            });
            const toast = agent.page.locator('[data-sonner-toast]');

            await agent.inbox.expectOffer(chat.ulid);
            await expect(toast.first()).toBeVisible();
            await expect(toast.first()).toContainText('New chat request');
            await expect(
                toast.first().getByRole('button', { name: 'Accept' }),
            ).toBeVisible();
            await scanToasts(agent.page, testInfo, `toast-${theme}`);
            must(await chat.visitor.cancel(chat.ulid), 'cancel');
        }
    });
});

test.describe('agent inbox dialogs', () => {
    test('details sheet, transfer dialog (both tabs), end-chat confirmation and the image lightbox', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant({ agents: 2, categories: 2 });
        const alice = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });

        // A colleague who can take a transfer (online, serves the topic) so the dialog has someone to show.
        await lab.agent(tenant, 1, { presence: 'online', keepAlive: true });

        const chat = await lab.chat(tenant, {
            name: 'Maya Thompson',
            email: 'maya.thompson@example.org',
            message: 'Hi, I was charged twice for order #48213.',
        });

        await alice.inbox.expectOffer(chat.ulid);
        await alice.inbox.accept(chat.ulid);
        await sendImageAsVisitor(chat, png(), 'The statement');
        await alice.inbox.expectMessage('The statement');

        // Details sheet.
        await alice.inbox.tid('conversation-info').click();
        await expect(alice.inbox.tid('conversation-details')).toBeVisible();
        await scanDashboard(alice.page, testInfo, 'details-sheet');
        await dismiss(alice.page);

        // Transfer dialog: the colleague tab, then the topic tab.
        await alice.inbox.tid('transfer-chat').click();
        await expect(alice.inbox.tid('transfer-dialog')).toBeVisible();
        await expect(alice.inbox.tid('transfer-loading')).toHaveCount(0);
        await scanDashboard(alice.page, testInfo, 'transfer-dialog-agents');
        await alice.inbox.tid('transfer-tab-category').click();
        await scanDashboard(alice.page, testInfo, 'transfer-dialog-topics');
        await dismiss(alice.page);

        // End-chat confirmation.
        await alice.inbox.tid('end-chat').click();
        await expect(alice.inbox.tid('end-chat-dialog')).toBeVisible();
        await scanDashboard(alice.page, testInfo, 'end-chat-dialog');
        await dismiss(alice.page);

        // The lightbox over the transcript.
        await alice.inbox.conversation
            .locator('[data-testid^="attachment-"]')
            .first()
            .click();
        await expect(alice.inbox.tid('lightbox')).toBeVisible();
        await scanDashboard(alice.page, testInfo, 'lightbox');
        await dismiss(alice.page);

        must(await alice.api.end(chat.ulid), 'end');
    });
});

test.describe('history and offline tickets', () => {
    test('history: results with ratings, a filtered result and the empty result', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant({ agents: 1, categories: 2 });
        const agent = await lab.agent(tenant, 0, { presence: 'online' });
        const tag = tenant.widget.name.split(' ').at(-1)!;
        const customers = [
            {
                name: `Maya Thompson ${tag}`,
                email: 'maya.thompson@example.org',
                first: 'I was charged twice for order #48213.',
                reply: 'Refund started, you will see it in 3 to 5 days.',
                rating: 5,
                comment: 'Quick and friendly, thank you!',
            },
            {
                name: `Daniel Okafor ${tag}`,
                category: 1,
                first: 'Do you ship to Lagos?',
                reply: 'We do, delivery takes about a week.',
                rating: 2,
                comment: 'Slow to answer.',
            },
            {
                name: `Priya Raman ${tag}`,
                first: 'Can I change the invoice address?',
                reply: 'Done, the new address is on the invoice.',
                rating: null,
            },
        ];
        const scenes = [];

        for (const customer of customers) {
            scenes.push(await lab.finishedChat(tenant, agent, customer));
        }

        const admin = await lab.administrator({ open: '/history' });
        const wide = testInfo.project.name !== 'mobile';
        const result = (ulid: string) =>
            admin.page.getByTestId(`history-${wide ? 'row' : 'card'}-${ulid}`);

        await expect(admin.page.getByTestId('history-page')).toBeVisible();

        // Search by the tenant's tag: every chat of this test, with their ratings.
        await admin.page.getByTestId('history-search').fill(tag);

        for (const scene of scenes) {
            await expect(result(scene.ulid)).toBeVisible();
        }

        await scanDashboard(admin.page, testInfo, 'history-results');

        // Filters applied on top: closed chats of the second topic.
        await admin.page
            .getByTestId('history-filter-status')
            .selectOption('closed');
        await expect(result(scenes[0].ulid)).toBeVisible();
        await scanDashboard(admin.page, testInfo, 'history-filtered');

        // Nothing matches.
        await admin.page
            .getByTestId('history-search')
            .fill('no-such-visitor-anywhere');
        await expect(admin.page.getByTestId('history-empty')).toBeVisible();
        await scanDashboard(admin.page, testInfo, 'history-empty');
    });

    test('offline tickets: the list and a claimed ticket with its e-mail notice', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/offline-tickets',
        });
        const ticket = await lab.ticket(tenant);

        await expect(
            agent.page.getByTestId(`ticket-${ticket.ulid}`),
        ).toBeVisible();
        await scanDashboard(agent.page, testInfo, 'offline-tickets');

        await agent.page.getByTestId(`ticket-claim-${ticket.ulid}`).click();
        await expect(agent.page).toHaveURL(
            new RegExp(`/inbox/${ticket.ulid}$`),
        );
        await expect(agent.inbox.tid('composer-email-notice')).toBeVisible();
        await scanDashboard(
            agent.page,
            testInfo,
            'offline-ticket-conversation',
        );

        must(await agent.api.close(ticket.ulid), 'closing the ticket');
    });
});

/** What a store would ask before chatting: name and e-mail required, phone optional, a consent line. */
const FULL_PRECHAT = {
    preChat: {
        fields: {
            name: { enabled: true, required: true },
            email: { enabled: true, required: true },
            phone: { enabled: true, required: false },
        },
        consentText:
            'I agree that Acme Storefront may keep a copy of this conversation.',
    },
};

test.describe('visitor panel', () => {
    test('welcome (a widget that asks nothing first)', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant({
            config: { features: { preChat: false } },
        });

        // Somebody is there to answer: with nobody online the panel opens on the offline form instead.
        await lab.agent(tenant, 0, { presence: 'online', keepAlive: true });

        const visitor = await lab.visitor();
        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });

        await panel.expectState('idle');
        await expect(panel.tid('idle-start')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-welcome');
    });

    test('pre-chat with errors, topic picker and the queued screen', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant({
            categories: 3,
            config: FULL_PRECHAT,
        });

        await lab.agent(tenant, 0, { presence: 'online', keepAlive: true });

        const visitor = await lab.visitor();
        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });

        // With a form to fill the panel opens on it (the welcome screen is for widgets that ask nothing first).
        await panel.expectState('prechat');
        await scanPanel(panel, testInfo, 'panel-prechat');

        // Submitting an empty form: every required field is flagged and the first one takes the focus.
        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
        await expect(
            panel.tid('prechat-form').locator('[aria-invalid="true"]').first(),
        ).toBeFocused();
        await scanPanel(panel, testInfo, 'panel-prechat-errors');

        const form = panel.tid('prechat-form');

        await form.locator('input[name="name"]').fill('Maya Thompson');
        await form
            .locator('input[name="email"]')
            .fill('maya.thompson@example.org');
        await form.locator('input[name="consent"]').check();
        await form.locator('button[type="submit"]').click();

        await panel.expectState('category');
        await scanPanel(panel, testInfo, 'panel-topics');

        await panel.tid(`category-option-${tenant.categories[0].slug}`).click();
        await panel.expectState('queued');
        await expect(panel.tid('queued-timer')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-queued');

        await panel.cancelQueued();
        await panel.expectState('closed');
    });

    test('an active chat: text, links, an image from each side, typing, receipts, the lightbox and the end-chat dialog', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const { panel, ulid } = await lab.activePanel(tenant, agent);

        must(
            await agent.api.send(
                ulid,
                'Hi Maya, thanks for reaching out. I can see order #48213. Details: https://example.com/orders/48213/receipt',
            ),
            'agent message',
        );
        await panel.send(
            'Great, thank you. My email is maya.thompson@example.org',
        );
        await sendImageAsAgent(
            agent,
            instance,
            { ulid },
            png(),
            'This is the receipt',
        );
        await panel.expectMessage('receipt', 'agent');
        await expect(panel.tid('message-image').first()).toBeVisible();
        must(await agent.api.typing(ulid, true), 'agent typing');
        await expect(panel.tid('typing-indicator')).toBeVisible();

        await scanPanel(panel, testInfo, 'panel-active');

        // The lightbox and the end-chat confirmation (both are modal dialogs inside the iframe).
        await panel.tid('message-image').first().click();
        await expect(panel.tid('lightbox')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-lightbox');
        await panel.tid('lightbox-close').click();
        await expect(panel.tid('lightbox')).toHaveCount(0);

        await panel.tid('end-chat').click();
        await expect(panel.tid('end-chat-dialog')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-end-chat-dialog');
        await panel.tid('end-chat-keep').click();

        must(await agent.api.end(ulid), 'end');
    });

    test('rating after the chat ended, then the thank-you screen', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const { panel, ulid } = await lab.activePanel(tenant, agent);

        must(await agent.api.send(ulid, 'Your refund is on its way.'), 'reply');
        must(await agent.api.end(ulid), 'end');

        await panel.expectState('ended');
        await scanPanel(panel, testInfo, 'panel-rating');

        await panel.tid('rating-star-4').click();
        await panel.tid('rating-comment').fill('Fast and friendly.');
        await scanPanel(panel, testInfo, 'panel-rating-filled');
        await panel.tid('rating-submit').click();

        await panel.expectState('closed');
        await scanPanel(panel, testInfo, 'panel-closed');
    });

    test('nobody available: the offline form with its errors and the confirmation, and the error screen with its retry', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant({
            categories: 2,
            config: { hours: { mode: 'always_offline' } },
            settings: { offline_mode: 'always_offline' },
        });
        const visitor = await lab.visitor();

        // The offline form is a lazily loaded chunk: block it first to see the error screen a failed load shows.
        let blocked = true;

        await visitor.context.route(
            '**/build/assets/offline-screen-*.js',
            (route) => (blocked ? route.abort('failed') : route.continue()),
        );
        visitor.watch.allow(
            /offline-screen/,
            /Failed to fetch dynamically imported module/,
        );

        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });

        await expect(panel.tid('panel-error')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-error-screen');

        blocked = false;
        await panel.tid('panel-error-retry').click();
        await panel.expectState('offline');
        await expect(panel.tid('offline-form')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-offline');

        await panel
            .tid('offline-form')
            .locator('button[type="submit"]')
            .click();
        await expect(
            panel.tid('offline-form').locator('[aria-invalid="true"]').first(),
        ).toBeFocused();
        await scanPanel(panel, testInfo, 'panel-offline-errors');

        const form = panel.tid('offline-form');

        await form.locator('input[name="name"]').fill('Nadia Farouk');
        await form
            .locator('input[name="email"]')
            .fill('nadia.farouk@example.org');
        await form
            .locator('select[name="category"]')
            .selectOption({ index: 1 });
        await form
            .locator('textarea[name="message"]')
            .fill(
                'My parcel has not arrived yet. Could you tell me when it will be delivered?',
            );
        await form.locator('button[type="submit"]').click();

        await panel.expectState('closed');
        await expect(panel.tid('new-chat')).toBeVisible();
        await scanPanel(panel, testInfo, 'panel-ticket-confirmation');
    });
});

test.describe('visitor panel, other looks', () => {
    // The panel's colours come from the widget: a very dark and a very light brand (each with the text colour an admin would pick),
    // and a widget locked to one scheme whatever the visitor's device prefers.
    const LOOKS = [
        {
            name: 'dark brand',
            theme: { primary: '#1e3a8a', primaryText: '#ffffff' },
        },
        {
            name: 'light brand',
            theme: { primary: '#fde047', primaryText: '#111827' },
        },
        {
            name: 'warm brand',
            theme: {
                primary: '#b45309',
                primaryText: '#ffffff',
                accent: '#be123c',
            },
        },
        { name: 'locked to dark', theme: { mode: 'dark' } },
        { name: 'locked to light', theme: { mode: 'light' } },
    ] as const;

    for (const look of LOOKS) {
        test(`${look.name}: welcome, an active chat with an image and typing, the rating and the thank-you`, async ({
            lab,
            instance,
        }, testInfo) => {
            const tenant = await lab.tenant({ config: { theme: look.theme } });
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                keepAlive: true,
            });
            const { panel, ulid } = await lab.activePanel(tenant, agent);
            const label = look.name.replaceAll(' ', '-');

            must(
                await agent.api.send(
                    ulid,
                    'Hi Maya, thanks for reaching out. Details: https://example.com/orders/48213/receipt',
                ),
                'agent message',
            );
            await panel.send(
                'Great, thank you. My email is maya.thompson@example.org',
            );
            await sendImageAsAgent(
                agent,
                instance,
                { ulid },
                png(),
                'The receipt',
            );
            await panel.expectMessage('receipt', 'agent');
            must(await agent.api.typing(ulid, true), 'typing');
            await expect(panel.tid('typing-indicator')).toBeVisible();
            await scanPanel(panel, testInfo, `panel-${label}-active`);

            must(await agent.api.end(ulid), 'end');
            await panel.expectState('ended');
            await panel.tid('rating-star-4').click();
            await scanPanel(panel, testInfo, `panel-${label}-rating`);
            await panel.tid('rating-submit').click();
            await panel.expectState('closed');
            await scanPanel(panel, testInfo, `panel-${label}-closed`);

            // The first screen of the same look (a visitor who has not started anything).
            const visitor = await lab.visitor();
            const welcome = await openCustomerSite(visitor.page, instance, {
                key: tenant.widget.key,
                open: true,
            });

            await welcome.expectState('prechat');
            await scanPanel(welcome, testInfo, `panel-${label}-prechat`);
        });
    }

    test('the reconnecting banner while the socket is down, and the chat catching up when it comes back', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const visitor = await lab.visitor();
        const sockets: { close: (options?: { code?: number }) => void }[] = [];
        let down = false;

        // Every websocket of the visitor's page goes through a route that can refuse it.
        await visitor.context.routeWebSocket(/\/app\//, (route) => {
            if (down) {
                void route.close({ code: 4100 });

                return;
            }

            route.connectToServer();
            sockets.push(route);
        });
        visitor.watch.allow(/WebSocket/i, /ERR_/);

        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });
        const started = await panel.startChat({
            category: tenant.categories[0].slug,
            name: 'Maya Thompson',
        });
        const ulid = started.ulid!;

        await lab.accept(agent, { ulid });
        await panel.expectState('active');
        must(await agent.api.send(ulid, 'Hello Maya'), 'agent message');
        await panel.expectMessage('Hello Maya', 'agent');

        down = true;
        sockets.splice(0).forEach((socket) => socket.close({ code: 4100 }));
        await expect(panel.tid('connection-status')).toBeVisible({
            timeout: 20_000,
        });
        await expect(panel.tid('connection-status')).toHaveAttribute(
            'role',
            'status',
        );
        await scanPanel(panel, testInfo, 'panel-reconnecting');

        // A message sent while the panel is blind is there once the socket is back (the panel catches up from the server).
        must(
            await agent.api.send(ulid, 'Sorry, one more thing'),
            'message while disconnected',
        );
        down = false;
        await panel.expectMessage('one more thing', 'agent');
        await expect(panel.tid('connection-status')).toHaveCount(0, {
            timeout: 30_000,
        });

        must(await agent.api.end(ulid), 'end');
    });
});
