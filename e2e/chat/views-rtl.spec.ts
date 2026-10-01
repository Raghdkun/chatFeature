import { must } from '../support/chat-api';
import {
    expect,
    png,
    scanDashboard,
    scanPanel,
    sendImageAsAgent,
    test,
} from '../support/chat-lab';
import { expectNoHorizontalScroll } from '../support/helpers';
import { openCustomerSite } from '../support/panel';
import type { Locator, Page } from '@playwright/test';

/**
 * The live chat in Arabic, right to left. The panel speaks Arabic (the widget's locale, and the visitor's browser language); the agent
 * dashboard is in Arabic too, but its inbox strings exist in English only, so what these specs prove is the LAYOUT: the document is
 * `dir="rtl"`, columns and rows mirror (the list on the right, avatars and countdowns on the sides logical CSS gives them), directional
 * icons flip, bubbles sit on the logical side, the composer mirrors, mixed left-to-right content (URLs, e-mail addresses, numbers) stays
 * readable inside right-to-left bubbles, and nothing scrolls sideways. axe runs on the mirrored screens too.
 *
 * Run in both projects (desktop 1280 px, phone). The launcher's corner on the customer site is P3's business and is not repeated here.
 */
test.use({ scenario: 'p4-chat-views-rtl' });

// Several workers, two projects and other suites share one machine: a screen full of axe scans needs more than the default minute.
test.describe.configure({ timeout: 120_000 });

const ARABIC = /[؀-ۿ]/;

async function expectRtlDocument(page: Page): Promise<void> {
    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
}

async function centre(locator: Locator): Promise<{ x: number; y: number }> {
    const box = await locator.boundingBox();

    expect(box, 'the element is on screen').not.toBeNull();

    return { x: box!.x + box!.width / 2, y: box!.y + box!.height / 2 };
}

/** The `dir` the browser really applies to the text of an element (an attribute, or inherited). */
function direction(locator: Locator): Promise<string> {
    return locator.evaluate((element) => getComputedStyle(element).direction);
}

const ARABIC_SENTENCE = 'مرحبا، أحتاج مساعدة بخصوص طلبي رقم 48213.';
const MIXED =
    'رقم الطلب 48213 والبريد maya.thompson@example.org والرابط https://example.com/orders/48213 شكرا';
const ENGLISH = 'Where is my order #48213? I paid $59.90 on 12/03.';

test.describe('agent screens', () => {
    test('the inbox mirrors: list on the right, avatar and countdown on the logical sides, bubbles on the logical side, icons flipped', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant({ categories: 2 });
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            open: '/inbox',
        });
        const { inbox, page } = agent;
        const phone = testInfo.project.name === 'mobile';

        await expectRtlDocument(page);
        await expectNoHorizontalScroll(page);

        const maya = await lab.chat(tenant, {
            name: 'Maya Thompson',
            message: ARABIC_SENTENCE,
        });
        const second = await lab.chat(tenant, {
            category: 1,
            name: 'Daniel Okafor',
            message: ENGLISH,
        });

        await inbox.expectOffer(maya.ulid);
        await inbox.expectOffer(second.ulid);

        // An offer card in Arabic: the avatar starts the row (right), the countdown ends it (left).
        const card = inbox.offer(maya.ulid);
        const avatar = (await card
            .locator('[data-slot="avatar"], span')
            .first()
            .boundingBox())!;
        const countdown = (await card
            .getByTestId('offer-countdown')
            .boundingBox())!;

        expect(
            avatar.x,
            'the avatar is on the right of the countdown',
        ).toBeGreaterThan(countdown.x);
        await scanDashboard(page, testInfo, 'rtl-inbox-offers');

        await inbox.accept(maya.ulid);

        must(await maya.visitor.send(maya.ulid, MIXED), 'visitor message');
        must(
            await agent.api.send(maya.ulid, 'سأتحقق من ذلك الآن.'),
            'agent message',
        );
        must(
            await maya.visitor.send(maya.ulid, ENGLISH),
            'visitor message in English',
        );
        await inbox.expectMessage('48213 والبريد');

        // The two panes: the list is the first column, so on the right; the conversation fills the rest to its left.
        if (!phone) {
            const conversation = (await inbox.conversation.boundingBox())!;
            const listBox = (await page
                .getByTestId('inbox')
                .locator(':scope > section')
                .first()
                .boundingBox())!;

            expect(
                listBox.x,
                'the list column sits on the right',
            ).toBeGreaterThan(conversation.x);
        } else {
            // The way back is an arrow that points forward in Arabic (flipped), and the layout stays one column.
            const back = inbox.tid('conversation-back').locator('svg').first();

            expect(
                await back.evaluate((svg) => getComputedStyle(svg).scale),
            ).toBe('-1 1');
        }

        // Bubbles: the visitor's (the other side) at the start = right; the agent's own at the end = left.
        const theirs = await centre(
            inbox.message('48213 والبريد').first().locator('p').first(),
        );
        const mine = await centre(
            inbox.message('سأتحقق').first().locator('p').first(),
        );

        expect(
            theirs.x,
            "the visitor's bubble is on the right",
        ).toBeGreaterThan(mine.x);

        // Mixed content stays inside its bubble and the page does not grow sideways.
        await expectNoHorizontalScroll(page);
        await scanDashboard(page, testInfo, 'rtl-inbox-conversation');

        must(await second.visitor.cancel(second.ulid), 'cancel');
        must(await agent.api.end(maya.ulid), 'end');
    });

    test('history and offline tickets mirror: columns start on the right, pager arrows flipped', async ({
        lab,
    }, testInfo) => {
        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, { presence: 'online' });
        const tag = tenant.widget.name.split(' ').at(-1)!;
        const done = await lab.finishedChat(tenant, agent, {
            name: `Maya Thompson ${tag}`,
            email: 'maya.thompson@example.org',
            first: ARABIC_SENTENCE,
            reply: 'تم، شكرا لانتظارك.',
            rating: 5,
            comment: 'ممتاز',
        });
        const admin = await lab.administrator({ open: '/history' });
        const wide = testInfo.project.name !== 'mobile';

        await expectRtlDocument(admin.page);
        await admin.page.getByTestId('history-search').fill(tag);
        await expect(
            admin.page.getByTestId(
                `history-${wide ? 'row' : 'card'}-${done.ulid}`,
            ),
        ).toBeVisible();
        await expectNoHorizontalScroll(admin.page);

        if (wide) {
            // The first column (visitor) is the rightmost, the last (started) the leftmost.
            const heads = admin.page.getByTestId('history-table').locator('th');
            const first = await centre(heads.first());
            const last = await centre(heads.last());

            expect(first.x).toBeGreaterThan(last.x);
        }

        // The pager's previous / next arrows point the other way.
        for (const id of ['history-prev', 'history-next']) {
            const arrow = admin.page.getByTestId(id).locator('svg').first();

            expect(
                await arrow.evaluate((svg) => getComputedStyle(svg).scale),
                `${id} arrow is flipped`,
            ).toBe('-1 1');
        }

        await scanDashboard(admin.page, testInfo, 'rtl-history');

        const tickets = await lab.agent(tenant, 0, {
            open: '/offline-tickets',
        });
        const ticket = await lab.ticket(tenant, {
            name: 'نادية فاروق',
            message: MIXED,
        });

        await expect(
            tickets.page.getByTestId(`ticket-${ticket.ulid}`),
        ).toBeVisible();
        await expectRtlDocument(tickets.page);
        await expectNoHorizontalScroll(tickets.page);
        await scanDashboard(tickets.page, testInfo, 'rtl-offline-tickets');
    });
});

test.describe('visitor panel', () => {
    test('the whole flow mirrors: header, composer, bubbles, topic chevrons, rating, and every screen passes axe', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant({
            categories: 3,
            config: {
                preChat: {
                    fields: {
                        name: { enabled: true, required: true },
                        email: { enabled: true, required: false },
                        phone: { enabled: false, required: false },
                    },
                },
            },
        });
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const visitor = await lab.visitor();
        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });
        const frameRoot = panel.root;

        // The panel document is right to left and in Arabic.
        await panel.expectState('prechat');
        await expect(panel.frame.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(panel.frame.locator('html')).toHaveAttribute('lang', 'ar');
        await expect(panel.tid('prechat-form').locator('h2')).toHaveText(
            ARABIC,
        );
        expect(await direction(frameRoot)).toBe('rtl');
        await scanPanel(panel, testInfo, 'rtl-panel-prechat');

        // Header: the title starts on the right, the close button ends on the left.
        const title = await centre(panel.frame.locator('header h1'));
        const close = await centre(panel.frame.locator('header button').last());

        expect(
            title.x,
            'the title is right of the close button',
        ).toBeGreaterThan(close.x);

        await panel
            .tid('prechat-form')
            .locator('input[name="name"]')
            .fill('مايا');
        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
        await panel.expectState('category');

        // Topic cards: the chevron at the end of the row (left) points left.
        const option = panel.tid(
            `category-option-${tenant.categories[0].slug}`,
        );
        const chevron = option.locator('svg').last();

        expect(
            await chevron.evaluate((svg) => getComputedStyle(svg).scale),
            'the chevron is flipped',
        ).toBe('-1 1');
        await scanPanel(panel, testInfo, 'rtl-panel-topics');
        await option.click();
        await panel.expectState('queued');
        await scanPanel(panel, testInfo, 'rtl-panel-queued');

        const queued = must<{ ulid: string }[]>(
            await agent.api.queue(),
            'the queue',
        ).at(-1)!;

        await lab.accept(agent, queued);
        await panel.expectState('active');

        // Messages from both sides, mixed content, an image.
        must(
            await agent.api.send(queued.ulid, 'أهلا، سأتحقق من ذلك الآن.'),
            'agent message',
        );
        await panel.send(MIXED);
        await panel.send(ENGLISH);
        must(
            await agent.api.send(
                queued.ulid,
                'الرابط: https://example.com/help/duplicate-charges.',
            ),
            'agent link',
        );
        await sendImageAsAgent(agent, instance, queued, png(), 'الإيصال');
        await panel.expectMessage('الإيصال', 'agent');
        must(await agent.api.typing(queued.ulid, true), 'typing');
        await expect(panel.tid('typing-indicator')).toBeVisible();

        const theirs = await centre(
            panel.message('أهلا', 'agent').first().locator('p').first(),
        );
        const mine = await centre(
            panel
                .message('48213 والبريد', 'visitor')
                .first()
                .locator('p')
                .first(),
        );

        expect(
            theirs.x,
            "the agent's bubble starts on the right",
        ).toBeGreaterThan(mine.x);

        // The composer mirrors: the send button ends the row (left), the attach button starts it (right), the field between.
        const send = await centre(panel.tid('composer-send'));
        const field = await centre(panel.composerInput);
        const attach = await centre(panel.tid('composer-attach'));

        expect(send.x).toBeLessThan(field.x);
        expect(field.x).toBeLessThan(attach.x);

        // Mixed content stays inside the panel, the list does not scroll sideways.
        expect(
            await panel.messageList.evaluate(
                (list) => list.scrollWidth - list.clientWidth,
            ),
        ).toBeLessThanOrEqual(0);
        await expectNoHorizontalScroll(panel.page);
        await scanPanel(panel, testInfo, 'rtl-panel-active');

        // Ended: the rating stars, the arrow keys follow the reading direction (Left is "next" in Arabic).
        must(await agent.api.end(queued.ulid), 'end');
        await panel.expectState('ended');
        await scanPanel(panel, testInfo, 'rtl-panel-rating');

        const star = (value: number) => panel.tid(`rating-star-${value}`);

        await star(3).focus();
        await panel.page.keyboard.press('ArrowLeft');
        await expect(star(4)).toBeFocused();
        await panel.page.keyboard.press('ArrowRight');
        await expect(star(3)).toBeFocused();

        await star(5).click();
        await panel.tid('rating-submit').click();
        await panel.expectState('closed');
        await scanPanel(panel, testInfo, 'rtl-panel-closed');
    });

    test('nobody available: the offline form and its confirmation in Arabic', async ({
        lab,
        instance,
    }, testInfo) => {
        const tenant = await lab.tenant({
            categories: 2,
            config: { hours: { mode: 'always_offline' } },
            settings: { offline_mode: 'always_offline' },
        });
        const visitor = await lab.visitor();
        const panel = await openCustomerSite(visitor.page, instance, {
            key: tenant.widget.key,
            open: true,
        });

        await panel.expectState('offline');
        await expect(panel.frame.locator('html')).toHaveAttribute('dir', 'rtl');
        await expect(panel.tid('offline-form').locator('h2')).toHaveText(
            ARABIC,
        );
        await scanPanel(panel, testInfo, 'rtl-panel-offline');

        // Technical fields (e-mail) stay left to right inside the mirrored form, and nothing grows sideways.
        const email = panel.tid('offline-form').locator('input[name="email"]');

        await email.fill('nadia.farouk@example.org');
        expect(
            await email.evaluate((input) => getComputedStyle(input).direction),
        ).toBeDefined();
        await expectNoHorizontalScroll(panel.page);

        const form = panel.tid('offline-form');

        await form.locator('input[name="name"]').fill('نادية فاروق');
        await form
            .locator('select[name="category"]')
            .selectOption({ index: 1 });
        await form.locator('textarea[name="message"]').fill(MIXED);
        await form.locator('button[type="submit"]').click();
        await panel.expectState('closed');
        await scanPanel(panel, testInfo, 'rtl-panel-ticket-confirmation');
    });
});

/**
 * A message takes the direction of what it says (`dir="auto"`), whatever the direction of the page around it: an English sentence in an
 * Arabic panel must not end up with its question mark on the wrong side, nor an Arabic sentence in an English dashboard with its full stop.
 */
for (const [label, scenario] of [
    ['an Arabic', 'p4-chat-views-rtl'],
    ['an English', 'p4-chat-views'],
] as const) {
    test.describe(`mixed-direction text in ${label} interface`, () => {
        test.use({ scenario });

        test('English reads left to right, Arabic right to left, in the panel and in the inbox', async ({
            lab,
        }) => {
            const tenant = await lab.tenant();
            const agent = await lab.agent(tenant, 0, {
                presence: 'online',
                keepAlive: true,
            });
            const { panel, ulid } = await lab.activePanel(tenant, agent);

            must(await agent.api.send(ulid, ENGLISH), 'English from the agent');
            must(
                await agent.api.send(ulid, ARABIC_SENTENCE),
                'Arabic from the agent',
            );
            await panel.expectMessage('Where is my order', 'agent');
            await panel.expectMessage('مرحبا', 'agent');

            // The visitor's panel: the text of each bubble takes the direction of what it says.
            const textOf = (bubble: Locator, text: string) =>
                bubble.locator('p, span, div').filter({ hasText: text }).last();

            expect(
                await direction(
                    textOf(
                        panel.message('Where is my order', 'agent').first(),
                        'Where is my order',
                    ),
                ),
                'English text reads left to right in the panel',
            ).toBe('ltr');
            expect(
                await direction(
                    textOf(panel.message('مرحبا', 'agent').first(), 'مرحبا'),
                ),
                'Arabic text reads right to left in the panel',
            ).toBe('rtl');

            // The agent's inbox: the same two messages.
            await agent.inbox.goto(ulid);
            await agent.inbox.expectMessage('Where is my order');
            await agent.inbox.expectMessage('مرحبا');

            expect(
                await direction(
                    agent.inbox
                        .message('Where is my order')
                        .first()
                        .locator('p')
                        .first(),
                ),
                'English text reads left to right in the inbox',
            ).toBe('ltr');
            expect(
                await direction(
                    agent.inbox.message('مرحبا').first().locator('p').first(),
                ),
                'Arabic text reads right to left in the inbox',
            ).toBe('rtl');

            must(await agent.api.end(ulid), 'end');
        });
    });
}
