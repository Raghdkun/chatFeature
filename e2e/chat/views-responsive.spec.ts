import { must } from '../support/chat-api';
import {
    expect,
    expectInsideViewportWidth,
    png,
    sendImageAsAgent,
    sendImageAsVisitor,
    test,
    type Tenant,
} from '../support/chat-lab';
import { dismiss, expectNoHorizontalScroll, settle } from '../support/helpers';
import { settleWidget, widget } from '../support/host';
import { openCustomerSite, type Panel } from '../support/panel';

/**
 * The live chat on a small screen: an agent's inbox at 375 and 320 px (the list -> conversation drill-down and back, the offers and their
 * Accept buttons always reachable, long unbroken names / tokens / URLs in cards and transcript, dialogs and sheets inside the screen,
 * the history as cards, and the table at tablet widths), and the visitor panel (full screen below 480 px, the composer never covered,
 * the keyboard inset, long tokens inside the bubbles). Run in both Playwright projects: the `mobile` project adds touch and a phone user
 * agent to the same explicit viewport sizes.
 */
test.use({ scenario: 'p4-chat-views' });

// Several workers, two projects and other suites share one machine: a screen full of axe scans needs more than the default minute.
test.describe.configure({ timeout: 120_000 });

const SIZES = [
    { width: 375, height: 812 },
    { width: 320, height: 568 },
];

/** The agent's phone with the on-screen keyboard open: what is left of the screen is short. */
const INBOX_SIZES = [...SIZES, { width: 375, height: 420 }];

/** Names and text that never break: the layout has to cope, not the data. */
const LONG_NAME = 'Wolfeschlegelsteinhausenbergerdorff'.repeat(2);
const LONG_TOKEN = `ORDER-REF-${'0123456789'.repeat(30)}`;
const LONG_URL = `https://example.com/orders/48213/receipt/${'segment-'.repeat(40)}end?utm_source=support&utm_medium=chat`;

async function documentOverflow(page: import('@playwright/test').Page) {
    return page.evaluate(
        () =>
            document.documentElement.scrollWidth -
            Math.min(window.innerWidth, document.documentElement.clientWidth),
    );
}

/** Nothing inside the panel's iframe is wider than the panel (no inner horizontal scrolling anywhere on the screen). */
async function expectPanelContained(
    panel: Panel,
    message: string,
): Promise<void> {
    const overflow = await panel.root.evaluate((root) => {
        const wide: string[] = [];

        for (const element of root.querySelectorAll<HTMLElement>('*')) {
            if (element.scrollWidth > element.clientWidth + 1) {
                const style = getComputedStyle(element);

                if (
                    style.overflowX === 'visible' ||
                    style.overflowX === 'auto' ||
                    style.overflowX === 'scroll'
                ) {
                    // Elements that clip or scroll horizontally by design are fine; everything else that spills is a layout bug.
                    if (style.overflowX !== 'visible') {
                        wide.push(
                            `${element.tagName.toLowerCase()}[${element.getAttribute('data-testid') ?? element.className.toString().slice(0, 40)}] scrolls horizontally (${element.scrollWidth} > ${element.clientWidth})`,
                        );
                    } else if (
                        element.children.length === 0 ||
                        element.scrollWidth > root.clientWidth
                    ) {
                        wide.push(
                            `${element.tagName.toLowerCase()}[${element.getAttribute('data-testid') ?? element.className.toString().slice(0, 40)}] spills (${element.scrollWidth} > ${element.clientWidth})`,
                        );
                    }
                }
            }
        }

        return {
            wide,
            root: root.scrollWidth - root.clientWidth,
        };
    });

    expect(
        overflow.root,
        `${message}: the panel root does not scroll sideways`,
    ).toBeLessThanOrEqual(0);
    expect(overflow.wide, `${message}: nothing spills out of its box`).toEqual(
        [],
    );
}

async function agentWithTwoOffers(
    lab: import('../support/chat-lab').Lab,
    tenant: Tenant,
    size: { width: number; height: number },
) {
    const agent = await lab.agent(tenant, 0, {
        presence: 'online',
        viewport: size,
        open: '/inbox',
    });
    const long = await lab.chat(tenant, {
        name: LONG_NAME,
        email: 'a.very.long.address.that.keeps.going@subdomain.example-company-with-a-long-name.example.org',
        message: `${LONG_TOKEN} ${LONG_URL}`,
    });
    const short = await lab.chat(tenant, {
        category: 1,
        name: 'Daniel Okafor',
        message: 'Do you ship to Lagos?',
    });

    await agent.inbox.expectOffer(long.ulid);
    await agent.inbox.expectOffer(short.ulid);

    return { agent, long, short };
}

for (const size of INBOX_SIZES) {
    test.describe(`agent inbox at ${size.width}x${size.height}px`, () => {
        test('list -> conversation -> back: offers stay reachable, nothing scrolls sideways, the composer is on screen', async ({
            lab,
        }) => {
            const tenant = await lab.tenant({ categories: 2 });
            const { agent, long, short } = await agentWithTwoOffers(
                lab,
                tenant,
                size,
            );
            const { inbox, page } = agent;

            // The list screen: queue cards with long content, Accept inside the screen and reachable.
            await expectNoHorizontalScroll(page);
            await expectInsideViewportWidth(
                inbox.offer(long.ulid),
                page,
                'the long offer card',
            );
            await inbox
                .tid(`offer-accept-${short.ulid}`)
                .scrollIntoViewIfNeeded();
            await expect(
                inbox.tid(`offer-accept-${short.ulid}`),
            ).toBeInViewport({ ratio: 1 });
            await expectInsideViewportWidth(
                inbox.tid(`offer-accept-${short.ulid}`),
                page,
                'Accept',
            );
            await expect(inbox.tid('presence-select')).toBeVisible();
            await expect(inbox.conversation).toBeHidden();

            // Accepting opens the conversation as its own screen (list hidden), with the way back.
            await inbox.accept(long.ulid);
            await expect(inbox.queue).toBeHidden();
            await expect(inbox.tid('conversation-back')).toBeVisible();
            await expectNoHorizontalScroll(page);

            // Long unbroken content in the transcript stays inside the bubbles.
            must(
                await long.visitor.send(long.ulid, `${LONG_TOKEN} ${LONG_URL}`),
                'visitor message',
            );
            must(
                await agent.api.send(long.ulid, `${LONG_URL} ${LONG_TOKEN}`),
                'agent message',
            );
            await sendImageAsVisitor(
                long,
                png(640, 480),
                'Screenshot of the error',
            );
            await inbox.expectMessage('Screenshot of the error');
            await expect(
                inbox.message(LONG_TOKEN.slice(0, 20)).first(),
            ).toBeVisible();
            await expectNoHorizontalScroll(page);

            const list = inbox.tid('message-list');

            expect(
                await list.evaluate(
                    (element) => element.scrollWidth - element.clientWidth,
                ),
                'the transcript does not scroll sideways',
            ).toBeLessThanOrEqual(0);

            for (const bubble of await inbox.conversation
                .locator('[data-testid^="message-"]')
                .all()) {
                if (await bubble.isVisible()) {
                    await expectInsideViewportWidth(
                        bubble,
                        page,
                        'a message bubble',
                    );
                }
            }

            // The header actions and the composer are on screen, the composer's bottom edge is inside the viewport.
            await expect(inbox.tid('conversation-info')).toBeInViewport();
            await expect(inbox.tid('end-chat')).toBeInViewport();
            await expect(inbox.composerInput).toBeInViewport();
            await expect(inbox.tid('composer-send')).toBeInViewport();
            await expectInsideViewportWidth(
                inbox.tid('composer-send'),
                page,
                'the send button',
            );

            const composer = (await inbox.composerInput.boundingBox())!;

            expect(composer.y + composer.height).toBeLessThanOrEqual(
                size.height,
            );

            // Another chat is waiting: the queue pill in the header keeps Accept one tap away, and leads to the list.
            await expect(inbox.tid('conversation-queue-pill')).toBeVisible();
            await inbox.tid('conversation-queue-pill').click();
            await expect(inbox.queue).toBeVisible();
            await expect(inbox.offer(short.ulid)).toBeVisible();
            await expect(inbox.conversation).toBeHidden();

            // Back to the chat from "My chats", and back to the list with the arrow.
            await inbox.chatRow(long.ulid).click();
            await expect(inbox.conversation).toBeVisible();
            await inbox.tid('conversation-back').click();
            await expect(inbox.queue).toBeVisible();
            await expect(inbox.conversation).toBeHidden();
            await expectNoHorizontalScroll(page);

            must(await short.visitor.cancel(short.ulid), 'cancel');
            must(await agent.api.end(long.ulid), 'end');
        });

        test('dialogs and sheets fit the screen and keep their primary action reachable', async ({
            lab,
        }) => {
            const tenant = await lab.tenant({ agents: 2, categories: 2 });
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                viewport: size,
                open: '/inbox',
            });

            await lab.agent(tenant, 1, { presence: 'online', keepAlive: true });

            const chat = await lab.chat(tenant, {
                name: LONG_NAME,
                email: 'maya.thompson@example.org',
                message: `${LONG_TOKEN}`,
            });

            await agent.inbox.expectOffer(chat.ulid);
            await agent.inbox.accept(chat.ulid);
            await sendImageAsVisitor(chat, png(900, 600), 'The statement');
            await agent.inbox.expectMessage('The statement');

            const { inbox, page } = agent;
            const fits = async (testId: string, action?: string) => {
                const surface = inbox.tid(testId);

                await expect(surface).toBeVisible();
                // Sheets slide in and dialogs zoom in: measure them at rest.
                await settle(page);
                await expectInsideViewportWidth(surface, page, testId);
                await expectNoHorizontalScroll(page);

                if (action) {
                    await inbox.tid(action).scrollIntoViewIfNeeded();
                    await expect(inbox.tid(action)).toBeInViewport();
                }
            };

            await inbox.tid('conversation-info').click();
            await fits('conversation-details');
            await dismiss(page);

            await inbox.tid('transfer-chat').click();
            await expect(inbox.tid('transfer-loading')).toHaveCount(0);
            await fits('transfer-dialog');
            await inbox.tid('transfer-tab-category').click();
            await fits('transfer-dialog');
            await dismiss(page);

            await inbox.tid('end-chat').click();
            await fits('end-chat-dialog', 'end-chat-confirm');
            await dismiss(page);

            await inbox.conversation
                .locator('[data-testid^="attachment-"]')
                .first()
                .click();
            await fits('lightbox');
            await dismiss(page);

            must(await agent.api.end(chat.ulid), 'end');
        });

        test('history: cards, a filter bar that wraps, a pager inside the screen; offline tickets with a long message', async ({
            lab,
        }) => {
            const tenant = await lab.tenant();
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                viewport: size,
            });
            const done = await lab.finishedChat(tenant, agent, {
                name: LONG_NAME,
                email: 'maya.thompson@example.org',
                first: LONG_TOKEN,
                reply: 'Done.',
                rating: 4,
                comment: LONG_TOKEN,
            });
            const admin = await lab.administrator({
                open: '/history',
                viewport: size,
            });
            const tag = tenant.widget.name.split(' ').at(-1)!;

            await expect(admin.page.getByTestId('history-page')).toBeVisible();
            await admin.page
                .getByTestId('history-search')
                .fill(LONG_NAME.slice(0, 20));
            await expect(
                admin.page.getByTestId(`history-card-${done.ulid}`),
            ).toBeVisible();
            await expectNoHorizontalScroll(admin.page);
            await expectInsideViewportWidth(
                admin.page.getByTestId(`history-card-${done.ulid}`),
                admin.page,
                'a history card',
            );
            await expectInsideViewportWidth(
                admin.page.getByTestId('history-pager'),
                admin.page,
                'the pager',
            );
            await expectInsideViewportWidth(
                admin.page.getByTestId('history-filters'),
                admin.page,
                'the filters',
            );
            expect(tag).not.toBe('');

            const tickets = await lab.agent(tenant, 0, {
                viewport: size,
                open: '/offline-tickets',
            });
            const ticket = await lab.ticket(tenant, {
                name: LONG_NAME,
                email: 'a.very.long.address.that.keeps.going@subdomain.example-company-with-a-long-name.example.org',
                message: `${LONG_TOKEN} ${LONG_URL}`,
            });

            await expect(
                tickets.page.getByTestId(`ticket-${ticket.ulid}`),
            ).toBeVisible();
            await expectNoHorizontalScroll(tickets.page);
            await expectInsideViewportWidth(
                tickets.page.getByTestId(`ticket-${ticket.ulid}`),
                tickets.page,
                'a ticket card',
            );
        });
    });
}

test.describe('history table at tablet and laptop widths', () => {
    for (const width of [768, 1024, 1280, 1536]) {
        test(`${width}px: the filter bar and the table stay inside the page`, async ({
            lab,
        }, testInfo) => {
            test.skip(
                testInfo.project.name === 'mobile' && width > 768,
                'the same layout as the desktop project at this width',
            );

            const tenant = await lab.tenant();
            const agent = await lab.agent(tenant, 0, { presence: 'online' });
            const done = await lab.finishedChat(tenant, agent, {
                name: LONG_NAME,
                email: 'a.very.long.address.that.keeps.going@subdomain.example-company-with-a-long-name.example.org',
                first: 'Hello',
                reply: 'Hi',
                rating: 5,
                comment: 'Great',
            });
            const admin = await lab.administrator({
                open: '/history',
                viewport: { width, height: 800 },
            });

            await admin.page
                .getByTestId('history-search')
                .fill(LONG_NAME.slice(0, 20));
            await expect(
                admin.page.getByTestId(`history-row-${done.ulid}`),
            ).toBeVisible();
            expect(
                await documentOverflow(admin.page),
                'the page does not scroll sideways',
            ).toBeLessThanOrEqual(0);

            // The filter bar: no control sits on top of another (eight controls in one row once pushed Reset over the date fields).
            const boxes: {
                id: string;
                x: number;
                y: number;
                width: number;
                height: number;
            }[] = [];

            for (const id of [
                'history-search',
                'history-filter-status',
                'history-filter-type',
                'history-filter-category',
                'history-filter-widget',
                'history-filter-agent',
                'history-filter-from',
                'history-filter-to',
                'history-reset',
                'history-export',
            ]) {
                const box = await admin.page.getByTestId(id).boundingBox();

                expect(box, `${id} is on screen`).not.toBeNull();
                boxes.push({ id, ...box! });
            }

            for (const [index, a] of boxes.entries()) {
                for (const b of boxes.slice(index + 1)) {
                    const across =
                        Math.min(a.x + a.width, b.x + b.width) -
                        Math.max(a.x, b.x);
                    const down =
                        Math.min(a.y + a.height, b.y + b.height) -
                        Math.max(a.y, b.y);

                    expect(
                        across > 1 && down > 1,
                        `${a.id} and ${b.id} do not overlap at ${width}px`,
                    ).toBe(false);
                }
            }

            // A table wider than the page scrolls inside its own container (the shadcn table wrapper), never the page.
            const container = admin.page
                .getByTestId('history-table')
                .locator('xpath=ancestor::*[@data-slot="table-container"]');
            const box = (await container.boundingBox())!;

            expect(
                box.x + box.width,
                'the table container ends inside the viewport',
            ).toBeLessThanOrEqual(width + 0.5);
            expect(
                await container.evaluate(
                    (element) => getComputedStyle(element).overflowX,
                ),
                'a wide table scrolls inside its container',
            ).toMatch(/auto|scroll/);
        });
    }
});

for (const size of SIZES) {
    test.describe(`visitor panel at ${size.width}px`, () => {
        test('full screen, every screen contained, the composer above the keyboard, long tokens inside the bubbles', async ({
            lab,
            instance,
        }) => {
            const tenant = await lab.tenant({
                categories: 3,
                config: {
                    preChat: {
                        fields: {
                            name: { enabled: true, required: true },
                            email: { enabled: true, required: true },
                            phone: { enabled: true, required: false },
                        },
                        consentText:
                            'I agree that Acme Storefront may keep a copy of this conversation for support purposes.',
                    },
                },
            });
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                keepAlive: true,
            });
            const visitor = await lab.visitor();

            await visitor.page.setViewportSize(size);

            const panel = await openCustomerSite(visitor.page, instance, {
                key: tenant.widget.key,
                open: true,
            });

            // Below 480 px the loader makes the iframe cover the whole screen and locks the host's scrolling.
            await expect(widget(visitor.page).panel).toHaveAttribute(
                'data-mode',
                'fullscreen',
            );

            await settleWidget(visitor.page);

            const settled = (await widget(visitor.page).iframe.boundingBox())!;

            expect(settled.width).toBeCloseTo(size.width, -0.5);
            expect(settled.height).toBeCloseTo(size.height, -0.5);
            expect(await documentOverflow(visitor.page)).toBeLessThanOrEqual(0);

            await panel.expectState('prechat');
            await expectPanelContained(panel, 'pre-chat');

            // The error state of the form is the tallest: still contained, and the scroll container reaches the submit button.
            await panel
                .tid('prechat-form')
                .locator('button[type="submit"]')
                .click();
            await expectPanelContained(panel, 'pre-chat with errors');
            await panel
                .tid('prechat-form')
                .locator('button[type="submit"]')
                .scrollIntoViewIfNeeded();
            await expect(
                panel.tid('prechat-form').locator('button[type="submit"]'),
            ).toBeInViewport();

            const form = panel.tid('prechat-form');

            await form.locator('input[name="name"]').fill(LONG_NAME);
            await form
                .locator('input[name="email"]')
                .fill(
                    'a.very.long.address.that.keeps.going@subdomain.example-company-with-a-long-name.example.org',
                );
            await form.locator('input[name="consent"]').check();
            await expectPanelContained(
                panel,
                'pre-chat filled with long values',
            );
            // Submitted from the keyboard (Enter in a field): on the phone profile a mouse click on a button in the lowest part of the
            // screen sometimes never reaches the page (an emulation quirk, not the panel's), and the layout is what this test is about.
            await form.locator('input[name="email"]').press('Enter');

            await panel.expectState('category', 45_000).catch(async (error) => {
                // What the visitor was looking at, for a failure that only happens now and then.
                throw new Error(
                    `${error.message}\nThe panel says: ${JSON.stringify(
                        await panel.root.evaluate((root) => ({
                            text: (root as HTMLElement).innerText.slice(0, 500),
                            invalid: root.querySelectorAll(
                                '[aria-invalid="true"]',
                            ).length,
                            focus:
                                document.activeElement?.getAttribute('name') ??
                                document.activeElement?.tagName,
                        })),
                    )}`,
                );
            });
            await expectPanelContained(panel, 'topics');
            await panel
                .tid(`category-option-${tenant.categories[0].slug}`)
                .click();
            await panel.expectState('queued', 45_000);
            await expectPanelContained(panel, 'queued');

            // Accepted: the transcript with long unbroken content and an image from each side.
            const queued = must<{ ulid: string }[]>(
                await agent.api.queue(),
                'the queue',
            ).at(-1)!;

            await lab.accept(agent, queued);
            await panel.expectState('active', 45_000);
            must(
                await agent.api.send(queued.ulid, `${LONG_TOKEN} ${LONG_URL}`),
                'agent message',
            );
            await panel.send(`${LONG_URL} ${LONG_TOKEN}`);
            await sendImageAsAgent(
                agent,
                instance,
                queued,
                png(900, 600),
                'Here is the receipt',
            );
            await panel.expectMessage('Here is the receipt', 'agent');
            await expect(panel.tid('message-image').first()).toBeVisible();
            must(await agent.api.typing(queued.ulid, true), 'typing');
            await expect(panel.tid('typing-indicator')).toBeVisible();

            await expectPanelContained(panel, 'active transcript');
            expect(
                await panel.messageList.evaluate(
                    (list) => list.scrollWidth - list.clientWidth,
                ),
                'the transcript does not scroll sideways',
            ).toBeLessThanOrEqual(0);

            // The composer: inside the screen, above the bottom edge, and nothing sits on top of the send button.
            const send = (await panel.tid('composer-send').boundingBox())!;

            expect(send.y + send.height).toBeLessThanOrEqual(size.height + 0.5);
            await expect(panel.tid('composer-input')).toBeInViewport();
            expect(
                await panel.tid('composer-send').evaluate((button) => {
                    const box = button.getBoundingClientRect();
                    const hit = document.elementFromPoint(
                        box.x + box.width / 2,
                        box.y + box.height / 2,
                    );

                    return button === hit || button.contains(hit);
                }),
                'the send button is not covered',
            ).toBe(true);

            // The keyboard opens: the host reports it (visualViewport) and the panel lifts the composer above it.
            await visitor.page.evaluate(
                ({ origin, height }) => {
                    const frameElement = document
                        .querySelector('pne-chat-widget')!
                        .shadowRoot!.querySelector<HTMLIFrameElement>(
                            '.panel iframe',
                        )!;

                    frameElement.contentWindow!.postMessage(
                        {
                            ns: 'chatfeature',
                            v: 1,
                            type: 'viewport',
                            payload: {
                                width: window.innerWidth,
                                height: height - 280,
                                keyboardInset: 280,
                            },
                        },
                        origin,
                    );
                },
                { origin: instance.url, height: size.height },
            );
            await expect
                .poll(async () => {
                    const box = await panel.tid('composer-send').boundingBox();

                    return box === null ? Infinity : box.y + box.height;
                })
                .toBeLessThanOrEqual(size.height - 280 + 0.5);
            await expect(panel.tid('composer-input')).toBeInViewport();

            must(await agent.api.end(queued.ulid), 'end');
        });
    });
}
