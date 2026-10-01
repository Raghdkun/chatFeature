/**
 * Phase 4 screenshots for the project deck: `E2E_SCREENSHOTS=1 E2E_ONLY=p4-shots,p4-chat-views-rtl E2E_SKIP_PIZZASYS=1 npx playwright test
 * e2e/screenshots/p4.spec.ts --project=desktop` (or `npm run e2e:screenshots`, which runs every phase).
 *
 * One story told twice, on a laptop (1280 px) and on a phone (375 px @2x), each on its own server (`p4-shots`, `p4-shots-mobile`): a
 * customer of "Acme Storefront" opens the widget, fills the form, picks Billing and waits; Alice Carter sees the offer next to a second
 * one and accepts it; they talk, a bank statement goes over as an image, Alice types; Alice transfers nothing and ends the chat, the
 * customer rates it. A third customer arrives after hours and leaves a message that becomes an offline ticket; the administrator looks
 * at the history. Then the same screens in Arabic (`p4-chat-views-rtl`, a tenant of its own with Arabic names).
 *
 * Output: docs/screenshots/p4/NN-description-{desktop|mobile}-{light|dark}.png (the PNGs are git-ignored). Deterministic where the product
 * allows it: fixed names and messages, reduced motion (except the launcher's flip, which is part of the picture), web fonts and every finite
 * animation settled, carets hidden, toasts hidden, no error toasts. Times shown by the product ("Waiting 0:07", the offer countdown, "now")
 * are whatever the clock says.
 */
import { mkdirSync, readdirSync, rmSync } from 'node:fs';
import type { Browser, BrowserContext, Page, TestInfo } from '@playwright/test';
import { Api, createWidget } from '../support/api';
import { signInApi, StaffActor } from '../support/actors';
import { clientAddress, must, StaffApi, VisitorApi } from '../support/chat-api';
import { readSeed, SEED_ROUTING } from '../support/chat-seed';
import { Lab, settlePanel, type Scene, type Tenant } from '../support/chat-lab';
import { hostPage, settleWidget } from '../support/host';
import { Inbox } from '../support/inbox';
import { openCustomerSite, type Panel } from '../support/panel';
import { ROOT, type Instance } from '../support/scenarios';
import {
    captureTo,
    instance as instanceByKey,
    newContext,
    type Viewport,
} from '../support/shots';
import { expect, test } from '../support/test';
import { authStatePath } from '../support/users';
import { watchContext, type Watch } from '../support/watch';

const OUTPUT = `${ROOT}docs/screenshots/p4`;
const THEMES = ['light', 'dark'] as const;

/** Info toasts ("New chat request") are a real part of the product and a distraction in a picture. */
const HIDE_TOASTS = () => {
    const style = document.createElement('style');

    style.textContent = '[data-sonner-toaster] { display: none !important; }';
    document.addEventListener('DOMContentLoaded', () =>
        document.head.append(style),
    );
};

/** The browsers of one story, each watched for page errors / console errors / 5xx, and the heartbeats that keep the agents online. */
class Session {
    private readonly contexts: BrowserContext[] = [];
    private readonly watches: Watch[] = [];
    private readonly beats: ReturnType<typeof setInterval>[] = [];

    add<T extends BrowserContext>(context: T, who: string): T {
        this.contexts.push(context);
        this.watches.push(watchContext(context, who));

        return context;
    }

    keepOnline(api: StaffApi): void {
        this.beats.push(
            setInterval(
                () => void api.heartbeat().catch(() => undefined),
                20_000,
            ),
        );
    }

    problems(): string[] {
        return this.watches.flatMap((watch) => watch.problems);
    }

    async close(): Promise<void> {
        this.beats.forEach((beat) => clearInterval(beat));
        await Promise.all(
            this.contexts.map((context) =>
                context.close().catch(() => undefined),
            ),
        );
    }
}

/** The look of "Acme Storefront": an indigo brand, its own name and greeting. */
const BRAND = {
    theme: {
        primary: '#4f46e5',
        primaryText: '#ffffff',
        accent: '#f59e0b',
        radius: 16,
        launcherSize: 'lg',
    },
    launcher: { style: 'pill', label: 'Chat with us' },
    texts: {
        en: {
            title: 'Acme Support',
            subtitle: 'We usually reply in a few minutes',
            welcome: 'Hi there! How can we help you today?',
        },
    },
};

async function renderBankStatement(browser: Browser): Promise<Buffer> {
    const context = await browser.newContext({
        viewport: { width: 360, height: 420 },
        deviceScaleFactor: 2,
    });
    const page = await context.newPage();

    try {
        await page.setContent(`<!doctype html><meta charset="utf-8"><style>
            body { margin: 0; font: 15px/1.4 -apple-system, 'Segoe UI', sans-serif; background: #eef2ff; color: #0f172a; }
            .sheet { margin: 18px; padding: 20px; background: #fff; border-radius: 14px; box-shadow: 0 6px 24px rgb(15 23 42 / .12); }
            h1 { font-size: 17px; margin: 0 0 2px; } small { color: #64748b; }
            table { width: 100%; border-collapse: collapse; margin-top: 16px; }
            td { padding: 9px 0; border-bottom: 1px solid #e2e8f0; } td:last-child { text-align: right; font-variant-numeric: tabular-nums; }
            .dup td { background: #fef3c7; font-weight: 600; } .total td { border: 0; font-weight: 700; padding-top: 14px; }
        </style><div class="sheet"><h1>Card statement</h1><small>Visa ending 4242 · October</small>
            <table>
              <tr><td>Fresh Greens Market</td><td>-$24.10</td></tr>
              <tr class="dup"><td>ACME STOREFRONT #48213</td><td>-$59.90</td></tr>
              <tr class="dup"><td>ACME STOREFRONT #48213</td><td>-$59.90</td></tr>
              <tr><td>City Transit</td><td>-$12.00</td></tr>
              <tr><td>Blue Bottle Coffee</td><td>-$6.50</td></tr>
              <tr class="total"><td>Total this week</td><td>-$162.40</td></tr>
            </table></div>`);

        return await page.screenshot({ type: 'png' });
    } finally {
        await context.close();
    }
}

/** A visitor's browser: no login, its own network address (chat starts are limited per address). */
async function visitorContext(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
): Promise<BrowserContext> {
    const context = await newContext(browser, viewport, target);
    const address = clientAddress();

    await context.route(`${target.url}/**`, (route) =>
        route.continue({
            headers: {
                ...route.request().headers(),
                'x-forwarded-for': address,
            },
        }),
    );

    return context;
}

/** A staff browser with a saved login. */
async function staffContext(
    browser: Browser,
    viewport: Viewport,
    target: Instance,
    role: 'alice' | 'bob' | 'admin',
): Promise<BrowserContext> {
    const context = await newContext(
        browser,
        viewport,
        target,
        authStatePath(target, role),
    );

    await context.addInitScript(HIDE_TOASTS);

    return context;
}

/** The customer-site page (the widget lives in the corner): both themes, the page's colour scheme drives the panel too. */
async function shootSite(
    page: Page,
    viewport: Viewport,
    name: string,
    options: {
        panel?: Panel;
        motion?: 'reduce' | 'no-preference';
        before?: () => Promise<void>;
    } = {},
): Promise<void> {
    for (const theme of THEMES) {
        await page.emulateMedia({
            colorScheme: theme,
            reducedMotion: options.motion ?? 'reduce',
        });
        await options.before?.();
        await settleWidget(page);

        if (options.panel) {
            await settlePanel(options.panel);
        }

        await page.evaluate(() =>
            (document.activeElement as HTMLElement | null)?.blur(),
        );
        await page.screenshot({
            path: `${OUTPUT}/${name}-${viewport}-${theme}.png`,
            animations: 'disabled',
            caret: 'hide',
        });
    }

    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
}

/** Light and dark of a dashboard page (the whole page). */
const shootDashboard = (page: Page, viewport: Viewport, name: string) =>
    captureTo(OUTPUT, page, viewport, name);

/** What the agents' dashboard needs to be shown with: the customer widget in its brand, and two more widgets for the other screens. */
async function prepareWidgets(
    admin: Api,
    target: Instance,
): Promise<{ welcome: string; afterHours: string }> {
    const seed = readSeed(target);
    const home = [`localhost:${target.hostPort}`];

    await admin.ok('PUT', `/api/v1/widgets/${seed.widget.ulid}/greetings`, {
        greetings: [
            {
                body: 'Hi! Questions about an order? Ask me anything.',
                agent_name: 'Alice',
                weight: 1,
                is_active: true,
                sort_order: 0,
            },
        ],
    });
    // The draft is rebuilt from the defaults: everything the seed set (opening hours, routing, queue timeout) is said again.
    await admin.ok('PUT', `/api/v1/widgets/${seed.widget.ulid}/draft`, {
        config: {
            ...BRAND,
            hours: { mode: 'always_online' },
            routing: SEED_ROUTING,
            greetings: {
                enabled: true,
                delaySeconds: 1,
                autoHideSeconds: 120,
                dismissPolicy: 'session',
            },
        },
    });
    await admin.ok('POST', `/api/v1/widgets/${seed.widget.ulid}/publish`);

    const welcome = await createWidget(admin, {
        name: 'Acme Storefront (single topic)',
        domains: home,
        categories: ['general'],
        settings: { offline_mode: 'always_online', queue_timeout_seconds: 45 },
        config: {
            ...BRAND,
            features: { preChat: false },
            hours: { mode: 'always_online' },
            routing: SEED_ROUTING,
            greetings: { enabled: false },
        },
    });
    const afterHours = await createWidget(admin, {
        name: 'Acme Storefront (after hours)',
        domains: home,
        categories: ['general', 'billing', 'sales'],
        settings: { offline_mode: 'always_offline', queue_timeout_seconds: 45 },
        config: {
            ...BRAND,
            hours: { mode: 'always_offline' },
            routing: SEED_ROUTING,
            greetings: { enabled: false },
        },
    });

    return { welcome: welcome.key, afterHours: afterHours.key };
}

/** A chat that ran its course (for the history): started by `name`, answered by `agent`, rated or not. */
async function finishedChat(
    target: Instance,
    key: string,
    agent: StaffApi,
    chat: {
        name: string;
        email: string;
        category: string;
        first: string;
        reply: string;
        rating: number | null;
        comment?: string;
    },
): Promise<void> {
    const visitor = await VisitorApi.start(target, {
        key,
        visitor: { name: chat.name, email: chat.email },
    });

    try {
        const started = must<{ ulid: string }>(
            await visitor.startChat({
                category: chat.category,
                name: chat.name,
                email: chat.email,
                message: chat.first,
            }),
            'starting a chat',
        );

        must(await agent.claim(started.ulid), 'accepting');
        must(await agent.send(started.ulid, chat.reply), 'replying');
        must(await agent.end(started.ulid), 'ending');

        if (chat.rating === null) {
            must(await visitor.skipRating(started.ulid), 'skipping');
        } else {
            must(
                await visitor.rate(started.ulid, chat.rating, chat.comment),
                'rating',
            );
        }
    } finally {
        await visitor.dispose();
    }
}

async function tellTheStory(
    browser: Browser,
    viewport: Viewport,
    testInfo: TestInfo,
): Promise<void> {
    const target = instanceByKey(
        viewport === 'desktop' ? 'p4-shots' : 'p4-shots-mobile',
    );
    const seed = readSeed(target);
    const phone = viewport === 'mobile';
    const session = new Session();
    const track = <T extends BrowserContext>(context: T, who: string): T =>
        session.add(context, who);

    try {
        const adminContext = track(
            await staffContext(browser, viewport, target, 'admin'),
            'administrator',
        );
        const admin = new Api(adminContext.request, target.url);
        const widgets = await prepareWidgets(admin, target);
        const statement = await renderBankStatement(browser);

        // Alice and Bob start the day: online, and kept online for the length of the run.
        const aliceContext = track(
            await staffContext(browser, viewport, target, 'alice'),
            'Alice',
        );
        const bobContext = track(
            await staffContext(browser, viewport, target, 'bob'),
            'Bob',
        );
        const aliceApi = new StaffApi(
            new Api(aliceContext.request, target.url),
        );
        const bobApi = new StaffApi(new Api(bobContext.request, target.url));

        for (const api of [aliceApi, bobApi]) {
            must(await api.setPresence('online'), 'going online');
            session.keepOnline(api);
        }

        const alicePage = await aliceContext.newPage();
        const alice = new Inbox(alicePage);
        // Opens a chat from "My chats" (on a phone the list is a screen of its own: back to it first).
        const openChat = async (ulid: string, who: string): Promise<void> => {
            if (phone && (await alice.conversation.isVisible())) {
                await alice.tid('conversation-back').click();
                await expect(alice.mine).toBeVisible();
            }

            await alice.chatRow(ulid).click();
            // The page changes under the previous conversation's feet: wait for THIS one before touching its buttons.
            await expect(alicePage).toHaveURL(new RegExp(`/inbox/${ulid}$`));
            await expect(alice.tid('conversation-name')).toHaveText(who);
        };
        // Bob's page keeps his presence and sockets alive like a real colleague's open inbox.
        await (await bobContext.newPage()).goto('/inbox');

        // 01 -- Alice's inbox on a quiet morning.
        await alice.goto();
        await expect(alice.tid('inbox-queue-empty')).toBeVisible();
        await shootDashboard(alicePage, viewport, '01-inbox-empty');

        // 02, 03 -- the customer site: the launcher, then its greeting.
        const shopper = track(
            await visitorContext(browser, viewport, target),
            'launcher visitor',
        );
        const shopperPage = await shopper.newPage();

        await shopperPage.goto(
            hostPage(target, {
                key: seed.widget.key,
                height: 200,
                title: 'Acme Store',
                attrs: { greetings: 'off' },
            }),
        );
        await expect(
            shopperPage.locator('pne-chat-widget button.launcher'),
        ).toBeVisible();
        await shootSite(shopperPage, viewport, '02-launcher-on-site');

        await shopperPage.addInitScript(() => {
            Math.random = () => 0;
        });
        await shopperPage.goto(
            hostPage(target, {
                key: seed.widget.key,
                height: 200,
                title: 'Acme Store',
            }),
        );
        await expect(shopperPage.locator('pne-chat-widget .greet')).toBeVisible(
            {
                timeout: 15_000,
            },
        );
        await shootSite(shopperPage, viewport, '03-launcher-greeting', {
            motion: 'no-preference',
        });
        await shopper.close();

        // A customer with nothing to fill in: the welcome screen (a single-topic widget without a form).
        const newcomer = track(
            await visitorContext(browser, viewport, target),
            'welcome visitor',
        );
        const welcomePanel = await openCustomerSite(
            await newcomer.newPage(),
            target,
            {
                key: widgets.welcome,
                height: 200,
                title: 'Acme Store',
                open: true,
            },
        );

        await welcomePanel.expectState('idle');
        await shootSite(welcomePanel.page, viewport, '04-panel-welcome', {
            panel: welcomePanel,
        });
        await newcomer.close();

        // 05 .. 08 -- Maya Thompson opens the chat: the form, its validation, the topics, the waiting screen.
        const maya = track(
            await visitorContext(browser, viewport, target),
            'Maya',
        );
        const mayaPage = await maya.newPage();
        const panel = await openCustomerSite(mayaPage, target, {
            key: seed.widget.key,
            height: 200,
            title: 'Acme Store',
            attrs: { greetings: 'off' },
            open: true,
        });

        await panel.expectState('prechat');
        await shootSite(mayaPage, viewport, '05-panel-prechat', { panel });

        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
        await expect(
            panel.tid('prechat-form').locator('[aria-invalid="true"]').first(),
        ).toBeVisible();
        await shootSite(mayaPage, viewport, '06-panel-prechat-validation', {
            panel,
        });

        await panel
            .tid('prechat-form')
            .locator('input[name="name"]')
            .fill('Maya Thompson');
        await panel
            .tid('prechat-form')
            .locator('input[name="email"]')
            .fill('maya.thompson@example.com');
        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
        await panel.expectState('category');
        await shootSite(mayaPage, viewport, '07-panel-topics', { panel });

        const created = mayaPage.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    '/api/v1/public/conversations' &&
                response.request().method() === 'POST',
        );

        await panel.tid('category-option-billing').click();
        await panel.expectState('queued');

        const mayaChat = (
            (await (await created).json()) as {
                data: { ulid: string };
            }
        ).data.ulid;

        await shootSite(mayaPage, viewport, '08-panel-queued', { panel });

        // 09 -- a second customer is waiting too: Alice's queue with two offers.
        const daniel = await VisitorApi.start(target, {
            key: seed.widget.key,
            visitor: {
                name: 'Daniel Okafor',
                email: 'daniel.okafor@example.org',
            },
        });
        const danielChat = must<{ ulid: string }>(
            await daniel.startChat({
                category: 'general',
                name: 'Daniel Okafor',
                email: 'daniel.okafor@example.org',
                message:
                    'Do you ship to Lagos? I would like two pairs of the trail runners.',
            }),
            "Daniel's chat",
        );

        await alice.expectOffer(mayaChat);
        await alice.expectOffer(danielChat.ulid);
        await shootDashboard(alicePage, viewport, '09-inbox-two-offers');

        // 10 -- Alice accepts Maya's chat: the conversation opens (on a phone: as a screen of its own).
        await alice.accept(mayaChat);
        await panel.expectState('active');
        await alice.send(
            "Hello Maya, I'm Alice from Acme. Let me take a look at that for you.",
        );
        await panel.expectMessage("I'm Alice from Acme", 'agent');
        await panel.send('Hi Alice, I was charged twice for order #48213.');
        await alice.expectMessage('charged twice');

        // Maya sends the statement from her bank (through the composer's file picker), Alice answers and is typing again.
        await sendPicture(
            panel,
            statement,
            'Here is the statement from my bank.',
        );
        await alice.expectMessage('statement from my bank');
        await expect(panel.tid('message-image').first()).toBeVisible();

        must(
            await aliceApi.send(
                mayaChat,
                "Thanks, that helps. I can see the duplicate charge on October 12th. I've started a refund; it reaches your card in 3 to 5 business days.",
            ),
            "Alice's answer",
        );
        await panel.expectMessage('started a refund', 'agent');
        await panel.send('Perfect, thank you so much!');
        await alice.expectMessage('thank you so much');

        // Daniel is accepted too and writes twice while Alice reads Maya's chat: an unseen badge in "My chats".
        must(await aliceApi.claim(danielChat.ulid), "accepting Daniel's chat");
        must(
            await daniel.send(danielChat.ulid, 'Hello? Are you still there?'),
            "Daniel's message",
        );
        must(
            await daniel.send(
                danielChat.ulid,
                'I can also pay by bank transfer if that is easier.',
            ),
            "Daniel's second message",
        );
        // (on a phone the list is a screen of its own: the badge is there, behind the conversation)
        await expect(
            alice.tid(`chat-unseen-${danielChat.ulid}`),
        ).toBeAttached();

        // 11 -- the visitor's panel with text, an image and the agent typing (the typing signal fades after a few seconds: asked for again).
        await shootSite(mayaPage, viewport, '10-panel-active-chat', {
            panel,
            before: async () => {
                must(await aliceApi.typing(mayaChat, true), 'typing');
                await expect(panel.tid('typing-indicator')).toBeVisible();
            },
        });

        // 12 -- the picture in the lightbox.
        await panel.tid('message-image').first().click();
        await expect(panel.tid('lightbox')).toBeVisible();
        await shootSite(mayaPage, viewport, '11-panel-image-lightbox', {
            panel,
        });
        await panel.tid('lightbox-close').click();
        await expect(panel.tid('lightbox')).toHaveCount(0);

        // 13 -- the same conversation from Alice's chair: transcript, the image, the other chat with its unseen badge.
        await expect(alice.conversation).toBeVisible();
        await shootDashboard(alicePage, viewport, '12-inbox-conversation');

        if (phone) {
            // On a phone the list is its own screen: back to it, "My chats" with the unseen badge.
            await alice.tid('conversation-back').click();
            await expect(alice.mine).toBeVisible();
            await shootDashboard(alicePage, viewport, '13-inbox-list-unseen');
            await alice.chatRow(mayaChat).click();
            await expect(alice.conversation).toBeVisible();
        }

        // The image in the staff lightbox.
        await alice.conversation
            .locator('[data-testid^="attachment-"]')
            .first()
            .click();
        await expect(alice.tid('lightbox')).toBeVisible();
        await shootDashboard(alicePage, viewport, '14-inbox-image-lightbox');
        await alicePage.keyboard.press('Escape');
        await expect(alice.tid('lightbox')).toHaveCount(0);

        // 15 -- the details sheet of Maya's chat.
        await alice.tid('conversation-info').click();
        await expect(alice.tid('conversation-details')).toBeVisible();
        await shootDashboard(alicePage, viewport, '15-inbox-details-sheet');
        await alicePage.keyboard.press('Escape');
        await expect(alice.tid('conversation-details')).toHaveCount(0);

        // 16 -- the transfer dialog on Daniel's General chat (Bob serves General and is online).
        await openChat(danielChat.ulid, 'Daniel Okafor');
        await expect(alice.conversation).toHaveAttribute(
            'data-status',
            'active',
        );
        await alice.tid('transfer-chat').click();
        await expect(alice.tid('transfer-dialog')).toBeVisible();
        await expect(alice.tid('transfer-loading')).toHaveCount(0);
        await shootDashboard(alicePage, viewport, '16-inbox-transfer-dialog');
        await alicePage.keyboard.press('Escape');
        await expect(alice.tid('transfer-dialog')).toHaveCount(0);
        must(await daniel.end(danielChat.ulid), "Daniel's chat ends");

        // 17 -- Alice ends Maya's chat: the confirmation, then the customer is asked to rate it.
        await openChat(mayaChat, 'Maya Thompson');
        await alice.tid('end-chat').click();
        await expect(alice.tid('end-chat-dialog')).toBeVisible();
        await shootDashboard(alicePage, viewport, '17-inbox-end-chat-dialog');
        await alice.tid('end-chat-confirm').click();
        await panel.expectState('ended');
        await panel.tid('rating-star-5').click();
        await panel
            .tid('rating-comment')
            .fill('Quick and friendly, thank you!');
        await shootSite(mayaPage, viewport, '18-panel-rating', { panel });

        await panel.tid('rating-submit').click();
        await panel.expectState('closed');
        await shootSite(mayaPage, viewport, '19-panel-closed', { panel });
        await maya.close();

        // 20, 21 -- after hours: the offline form and the confirmation; the ticket reaches Alice's tickets page.
        const nadia = track(
            await visitorContext(browser, viewport, target),
            'Nadia',
        );
        const nadiaPage = await nadia.newPage();
        const offline = await openCustomerSite(nadiaPage, target, {
            key: widgets.afterHours,
            height: 200,
            title: 'Acme Store',
            open: true,
        });

        await offline.expectState('offline');
        await expect(offline.tid('offline-form')).toBeVisible();
        await shootSite(nadiaPage, viewport, '20-panel-offline-form', {
            panel: offline,
        });

        const form = offline.tid('offline-form');

        await form.locator('input[name="name"]').fill('Nadia Farouk');
        await form
            .locator('input[name="email"]')
            .fill('nadia.farouk@example.org');
        await form.locator('select[name="category"]').selectOption('billing');
        await form
            .locator('textarea[name="message"]')
            .fill(
                'Hello, my parcel (order #48390) has not arrived yet. Could you tell me when it will be delivered?',
            );
        await form.locator('button[type="submit"]').click();
        await offline.expectState('closed');
        await shootSite(nadiaPage, viewport, '21-panel-offline-confirmation', {
            panel: offline,
        });
        await nadia.close();

        // A second ticket from another customer, so the page is a list.
        const ticket = await VisitorApi.start(target, {
            key: widgets.afterHours,
        });

        must(
            await ticket.offlineTicket({
                name: 'Omar Haddad',
                email: 'omar.haddad@example.net',
                message:
                    'Can I change the delivery address of order #48402? I moved last week.',
                category: 'general',
            }),
            'a second ticket',
        );
        await ticket.dispose();

        await alicePage.goto('/offline-tickets');
        await expect(alicePage.getByTestId('tickets-count')).toBeVisible();
        await shootDashboard(alicePage, viewport, '22-offline-tickets');

        // 23 -- the history (administrator): finished chats with their ratings, filtered to the closed ones.
        const earlier = [
            {
                name: 'Priya Raman',
                email: 'priya.raman@example.com',
                category: 'general',
                first: 'Can I change the invoice address?',
                reply: 'Done, the new address is on the invoice.',
                rating: 4,
                comment: 'Thanks!',
                agent: aliceApi,
            },
            {
                name: 'Lucas Meyer',
                email: 'lucas.meyer@example.de',
                category: 'sales',
                first: 'Do you offer a bulk discount for 20 packs?',
                reply: 'Yes, 15% from 10 packs. I will send you the quote.',
                rating: 5,
                comment: 'Great service.',
                agent: bobApi,
            },
            {
                name: 'Hannah Lee',
                email: 'hannah.lee@example.com',
                category: 'billing',
                first: 'I need a copy of my last invoice.',
                reply: 'It is in your inbox now.',
                rating: null,
                agent: aliceApi,
            },
            {
                name: 'Tomás Rivera',
                email: 'tomas.rivera@example.es',
                category: 'sales',
                first: 'Is the rain shell available in green?',
                reply: 'Green is back in stock next week.',
                rating: 3,
                comment: 'Took a while.',
                agent: bobApi,
            },
        ];

        for (const chat of earlier) {
            await finishedChat(target, seed.widget.key, chat.agent, chat);
        }

        const historyContext = track(
            await staffContext(browser, viewport, target, 'admin'),
            'administrator (history)',
        );
        const historyPage = await historyContext.newPage();

        await historyPage.goto('/history');
        await expect(historyPage.getByTestId('history-page')).toBeVisible();
        await historyPage
            .getByTestId('history-filter-status')
            .selectOption('closed');
        await expect(
            historyPage.getByTestId(
                `history-${phone ? 'card' : 'row'}-${mayaChat}`,
            ),
        ).toBeVisible();
        await shootDashboard(historyPage, viewport, '23-history');

        testInfo.annotations.push({
            type: 'screenshots',
            description: `${OUTPUT} (${viewport})`,
        });
    } finally {
        await session.close();
    }

    expect(
        session.problems(),
        'no page threw, logged an error or got a 5xx while the pictures were taken',
    ).toEqual([]);
}

/** The customer sends a picture through the composer's file picker, with a line of text. */
async function sendPicture(
    panel: Panel,
    picture: Buffer,
    text: string,
): Promise<void> {
    await panel.tid('composer-file').setInputFiles({
        name: 'photo.png',
        mimeType: 'image/png',
        buffer: picture,
    });
    await expect(panel.tid('composer-attachment')).toHaveAttribute(
        'data-status',
        'ready',
    );
    await panel.composerInput.fill(text);
    await panel.tid('composer-send').click();
}

/**
 * The same screens in Arabic, on a tenant of their own in the right-to-left scenario: Arabic names for the shop, the categories, the
 * agent and the customers, so the pictures show a real Arabic shop's chat. The panel speaks Arabic by itself (the widget's locale).
 */
async function tellTheArabicStory(
    browser: Browser,
    viewport: Viewport,
    testInfo: TestInfo,
): Promise<void> {
    const target = instanceByKey('p4-chat-views-rtl');
    const session = new Session();
    const adminContext = session.add(
        await staffContext(browser, viewport, target, 'admin'),
        'administrator',
    );
    const lab = new Lab(
        target,
        testInfo,
        (options) => browser.newContext(options),
        new Api(adminContext.request, target.url),
        () =>
            Promise.reject(
                new Error('the Arabic story builds its own browsers'),
            ),
    );

    try {
        const tenant: Tenant = await lab.tenant({
            categories: 2,
            agents: 1,
            name: 'متجر الواحة',
            categoryNames: ['الفواتير', 'المبيعات'],
            agentNames: ['سارة الحداد'],
            config: BRAND,
        });
        const agentContext = session.add(
            await newContext(browser, viewport, target),
            'Arabic agent',
        );

        await agentContext.addInitScript(HIDE_TOASTS);
        await signInApi(agentContext, target, tenant.agents[0]);

        const agentPage = await agentContext.newPage();
        const agent = new StaffActor(
            'alice',
            tenant.agents[0],
            agentContext,
            agentPage,
            watchContext(agentContext, 'Arabic agent (actor)'),
            target,
        );

        must(await agent.api.setPresence('online'), 'going online');
        session.keepOnline(agent.api);
        await agent.inbox.goto();

        // The customer's side: the form, the topics and the chat.
        const shopper = session.add(
            await visitorContext(browser, viewport, target),
            'Arabic customer',
        );
        const shopperPage = await shopper.newPage();
        const panel = await openCustomerSite(shopperPage, target, {
            key: tenant.widget.key,
            height: 200,
            title: 'متجر الواحة',
            rtl: true,
            attrs: { greetings: 'off' },
            open: true,
        });

        await panel.expectState('prechat');
        await shootSite(shopperPage, viewport, '30-rtl-panel-prechat', {
            panel,
        });
        await panel
            .tid('prechat-form')
            .locator('input[name="name"]')
            .fill('ليلى منصور');
        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
        await panel.expectState('category');
        await shootSite(shopperPage, viewport, '31-rtl-panel-topics', {
            panel,
        });

        const created = shopperPage.waitForResponse(
            (response) =>
                new URL(response.url()).pathname ===
                    '/api/v1/public/conversations' &&
                response.request().method() === 'POST',
        );

        await panel.tid(`category-option-${tenant.categories[0].slug}`).click();
        await panel.expectState('queued');

        const ulid = (
            (await (await created).json()) as { data: { ulid: string } }
        ).data.ulid;

        // A second customer: two offers in the right-to-left inbox.
        const other: Scene = await lab.chat(tenant, {
            name: 'خالد العمري',
            message: 'هل يمكنني استبدال المنتج بمقاس آخر؟',
        });

        await agent.inbox.expectOffer(ulid);
        await agent.inbox.expectOffer(other.ulid);
        await shootDashboard(agentPage, viewport, '32-rtl-inbox-two-offers');

        await agent.inbox.accept(ulid);
        await panel.expectState('active');
        await agent.inbox.send(
            'مرحبا ليلى، أنا سارة من فريق الدعم. كيف يمكنني مساعدتك؟',
        );
        await panel.expectMessage('أنا سارة', 'agent');
        await panel.send(
            'مرحبا سارة، تم خصم المبلغ مرتين من بطاقتي عن الطلب رقم 48213.',
        );
        await agent.inbox.expectMessage('48213');
        await sendPicture(
            panel,
            await renderBankStatement(browser),
            'هذا كشف الحساب من البنك',
        );
        await agent.inbox.expectMessage('كشف الحساب');
        must(
            await agent.api.send(
                ulid,
                'شكرا لك، رأيت الخصم المكرر وبدأت إجراءات الاسترداد. سيصل المبلغ خلال 3 إلى 5 أيام عمل.',
            ),
            'the agent answers',
        );
        await panel.expectMessage('الاسترداد', 'agent');
        await shootSite(shopperPage, viewport, '33-rtl-panel-active-chat', {
            panel,
            before: async () => {
                must(await agent.api.typing(ulid, true), 'typing');
                await expect(panel.tid('typing-indicator')).toBeVisible();
            },
        });
        await shootDashboard(agentPage, viewport, '34-rtl-inbox-conversation');

        must(await agent.api.end(ulid), 'ending');
        await panel.expectState('ended');
        await shootSite(shopperPage, viewport, '35-rtl-panel-rating', {
            panel,
        });
        must(
            await other.visitor.cancel(other.ulid),
            'cancelling the second chat',
        );

        testInfo.annotations.push({
            type: 'screenshots',
            description: `${OUTPUT} (${viewport}, Arabic)`,
        });
    } finally {
        await lab.dispose();
        await session.close();
    }

    expect(
        session.problems(),
        'no page threw or got a 5xx while the pictures were taken',
    ).toEqual([]);
}

test.describe.configure({ mode: 'serial', retries: 0 });

test.beforeAll(() => {
    mkdirSync(OUTPUT, { recursive: true });

    // Names change between runs; do not leave stale files behind.
    for (const file of readdirSync(OUTPUT)) {
        if (file.endsWith('.png')) {
            rmSync(`${OUTPUT}/${file}`);
        }
    }
});

for (const viewport of ['desktop', 'mobile'] as const) {
    test(`the live chat, start to finish, ${viewport}`, async ({
        browser,
    }, testInfo) => {
        test.setTimeout(300_000);

        await tellTheStory(browser, viewport, testInfo);
    });

    test(`the live chat in Arabic, ${viewport}`, async ({
        browser,
    }, testInfo) => {
        test.setTimeout(240_000);

        await tellTheArabicStory(browser, viewport, testInfo);
    });
}
