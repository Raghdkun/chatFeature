import type { BrowserContext, Locator, Page } from '@playwright/test';
import { must } from '../support/chat-api';
import { expect, test } from '../support/chat-lab';
import { expectEventually } from '../support/wait';
import { openCustomerSite, type Panel } from '../support/panel';

/**
 * A long conversation and a flaky connection, with generous limits (the point is "no freeze", not a benchmark): a 300-message transcript
 * opens and scrolls in the agent's inbox and in the visitor's panel without a long task (> 50 ms by the browser's definition) above
 * 500 ms, and a socket that drops and reconnects over and over neither duplicates messages nor grows the DOM.
 *
 * Desktop only: the budget is a desktop budget (a phone profile in headless Chrome shares the same CPU and would only measure the host),
 * and 300 API calls per test are enough load on the scenario's server.
 */
test.use({ scenario: 'p4-chat-views' });

test.skip(
    ({ isMobile }) => isMobile,
    'a desktop performance budget (the same CPU renders both profiles)',
);

const LONG_TASK_LIMIT_MS = 500;
const MESSAGES = 300;

type LongTasks = { duration: number; startTime: number }[];

/** Collects the browser's long tasks (> 50 ms) in `window.__longTasks` of every frame of the context, from the first script on. */
async function observeLongTasks(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
        const store: LongTasks = [];

        (window as unknown as { __longTasks: LongTasks }).__longTasks = store;

        try {
            new PerformanceObserver((list) => {
                for (const entry of list.getEntries()) {
                    store.push({
                        duration: entry.duration,
                        startTime: entry.startTime,
                    });
                }
            }).observe({ type: 'longtask', buffered: true });
        } catch {
            // The browser has no long-task API: the assertions below then see an empty list (and the control assertion fails loudly).
        }
    });
}

const longestOf = (tasks: LongTasks): number =>
    tasks.reduce((longest, task) => Math.max(longest, task.duration), 0);

/** Scrolls a list from its end to its start and back in twelve steps, one painted frame each (a person flicking through it). */
async function scrollThrough(list: Locator): Promise<void> {
    await list.evaluate(async (element) => {
        const frame = () =>
            new Promise<void>((resolve) =>
                requestAnimationFrame(() => resolve()),
            );

        for (const direction of [-1, 1]) {
            for (let step = 0; step < 12; step += 1) {
                element.scrollTop += (direction * element.scrollHeight) / 12;
                await frame();
            }
        }
    });
}

async function inboxTasks(page: Page): Promise<LongTasks> {
    return page.evaluate(
        () => (window as unknown as { __longTasks: LongTasks }).__longTasks,
    );
}

async function panelTasks(panel: Panel): Promise<LongTasks> {
    return panel.root.evaluate(
        () => (window as unknown as { __longTasks: LongTasks }).__longTasks,
    );
}

test.describe('a 300-message conversation', () => {
    test('opens and scrolls in the inbox and in the panel without a long task above 500 ms', async ({
        lab,
        instance,
    }, testInfo) => {
        test.setTimeout(300_000);

        const tenant = await lab.tenant({ agents: 1 });
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const admin = await lab.administrator();
        const visitor = await lab.visitor();

        await observeLongTasks(visitor.context);
        await observeLongTasks(agent.context);

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

        // 20 messages typed by the visitor (30 a minute is the limit of a session), 280 from the two staff accounts (600 a minute each).
        for (let index = 1; index <= 20; index += 1) {
            await panel.send(
                `Visitor message ${index}: still waiting for the refund.`,
            );
        }

        for (let index = 1; index <= MESSAGES - 20; index += 1) {
            const sender = index % 2 === 0 ? agent : admin;

            must(
                await sender.api.send(
                    ulid,
                    `Staff message ${index}: I am looking at order #48213 right now.`,
                ),
                `message ${index}`,
            );
        }

        // The panel after a reload: the whole transcript comes back from the server (paged) and is rendered.
        await visitor.page.reload();
        await expect(panel.launcher).toBeVisible();

        // The panel of a returning visitor exists (closed) from the start: `panel.open()` takes its iframe for open, so press the
        // launcher unless the widget says it is open (a closed panel does not paint, and nothing in it animates or scrolls).
        const widgetPanel = visitor.page.locator('pne-chat-widget .panel');

        if ((await widgetPanel.getAttribute('data-open')) !== 'true') {
            await panel.launcher.click();
        }

        await expect(widgetPanel).toHaveAttribute('data-open', 'true');
        await panel.expectState('active');
        await expectEventually(
            () =>
                panel.messageList.locator('[data-testid^="message-"]').count(),
            (count) => count >= MESSAGES,
            {
                timeout: 30_000,
                message: 'the panel rendered the whole transcript',
            },
        );

        // Scroll the whole transcript up and down again in steps, as a visitor flicking through it.
        await scrollThrough(panel.messageList);

        const panelLongest = longestOf(await panelTasks(panel));

        testInfo.annotations.push({
            type: 'panel longest task',
            description: `${Math.round(panelLongest)} ms`,
        });
        expect(
            panelLongest,
            'the panel never blocks for more than 500 ms',
        ).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);

        // The inbox: the same conversation as a page load, then scrolled.
        await agent.inbox.goto(ulid);
        await expect(agent.inbox.conversation).toBeVisible();
        await agent.inbox.expectMessage('Staff message 280');

        const list = agent.inbox.tid('message-list');

        await scrollThrough(list);

        const rendered = await agent.inbox.conversation
            .locator('[data-testid^="message-"]')
            .count();
        const inboxLongest = longestOf(await inboxTasks(agent.page));

        testInfo.annotations.push({
            type: 'inbox longest task',
            description: `${Math.round(inboxLongest)} ms, ${rendered} messages in the DOM`,
        });
        expect(rendered, 'the inbox shows a long transcript').toBeGreaterThan(
            50,
        );
        expect(
            inboxLongest,
            'the inbox never blocks for more than 500 ms',
        ).toBeLessThanOrEqual(LONG_TASK_LIMIT_MS);

        must(await agent.api.end(ulid), 'end');
    });

    test('a socket that keeps dropping neither duplicates messages nor grows the DOM, and every message sent meanwhile arrives', async ({
        lab,
        instance,
    }) => {
        test.setTimeout(180_000);

        const tenant = await lab.tenant();
        const agent = await lab.agent(tenant, 0, {
            presence: 'online',
            keepAlive: true,
        });
        const visitor = await lab.visitor();
        const sockets: {
            close: (options?: { code?: number; reason?: string }) => void;
        }[] = [];

        // Every websocket of the page goes through a route we can cut.
        await visitor.context.routeWebSocket(/\/app\//, (route) => {
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

        for (let index = 1; index <= 30; index += 1) {
            must(
                await agent.api.send(ulid, `Before the drops ${index}`),
                'message',
            );
        }

        await panel.expectMessage('Before the drops 30', 'agent');

        const nodes = () =>
            panel.root.evaluate(() => document.querySelectorAll('*').length);
        const messages = () =>
            panel.messageList.locator('[data-testid^="message-"]').count();
        const baseline = { nodes: await nodes(), messages: await messages() };

        for (let round = 1; round <= 5; round += 1) {
            // Cut every socket (the Pusher "reconnect at once" close code), say something while the panel is blind, and see it arrive.
            sockets
                .splice(0)
                .forEach((socket) =>
                    socket.close({ code: 4200, reason: 'test: reconnect' }),
                );
            must(
                await agent.api.send(ulid, `While disconnected ${round}`),
                'message while disconnected',
            );
            await panel.expectMessage(`While disconnected ${round}`, 'agent');
        }

        const after = { nodes: await nodes(), messages: await messages() };

        // Exactly the five new messages (no duplicates from re-subscribing or the catch-up fetch), and the DOM grew by those only.
        expect(after.messages).toBe(baseline.messages + 5);
        expect(
            after.nodes,
            'the DOM did not grow beyond the five new messages',
        ).toBeLessThan(baseline.nodes * 1.25);
        expect(
            await panel.messageList
                .getByText('Before the drops 7', { exact: true })
                .count(),
        ).toBe(1);

        must(await agent.api.end(ulid), 'end');
    });
});
