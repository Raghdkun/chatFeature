import type { Page } from '@playwright/test';
import type { Panel } from '../support/panel';
import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import { openCustomerSite } from '../support/panel';

/**
 * Everything works with NO websocket server at all (`p4-poll`: `BROADCAST_CONNECTION=null`, no Reverb): the visitor's panel gets no
 * `ws` block and polls every 10 s, the dashboard polls every 15 s and says so. Time is the page's own clock (`page.clock`: a poll
 * interval passes at once, as often as needed), the server's clock is real, so a poll tick is exactly what the browser would do.
 * The scenario is shared by the tests of this file only, which therefore use the seeded Alice and the seeded widget. The server says
 * so in the shared `realtime` prop (`null`), which wins over the Reverb address baked into the build: the dashboard makes no connection
 * attempt at all, so no spec here tolerates a console error.
 */
test.use({ scenario: 'p4-poll' });

/** Runs `check` until it holds, letting one poll interval of page time pass between attempts. */
async function afterPolls(
    page: Page,
    intervalMs: number,
    check: () => Promise<unknown>,
    attempts = 8,
): Promise<void> {
    for (let attempt = 1; attempt < attempts; attempt += 1) {
        try {
            await check();

            return;
        } catch {
            await page.clock.fastForward(intervalMs);
        }
    }

    await check();
}

const AGENT_POLL_MS = 15_000;
const VISITOR_POLL_MS = 10_000;

/** No error banner and no "reconnecting" line in the visitor's panel. */
async function expectCalmPanel(panel: Panel): Promise<void> {
    await expect(panel.frame.locator('[role="alert"]')).toHaveCount(0);
    await expect(panel.tid('connection-status')).toHaveCount(0);
    await expect(panel.tid('panel-error')).toHaveCount(0);
}

test('the whole chat works over REST polling on both sides: queue, accept, messages both ways, end, rating', async ({
    actors,
    instance,
}) => {
    test.setTimeout(150_000);

    const alice = await actors.staff('alice', { presence: 'online' });
    const visitor = await actors.visitor();

    await alice.page.clock.install();
    await visitor.page.clock.install();
    await alice.inbox.goto();

    // The dashboard knows it has no live connection and says so, with the polling interval.
    const banner = alice.inbox.tid('connection-banner');

    await expect(banner).toBeVisible();
    await expect(banner).toContainText('every 15 seconds');
    await expect(banner).not.toHaveAttribute('data-status', 'connected');

    // The visitor opens the widget: no error, no "reconnecting".
    const panel = await openCustomerSite(visitor.page, instance, {
        open: true,
    });
    const chat = await panel.startChat({
        category: 'billing',
        name: 'Polling Pia',
    });

    expect(chat.status).toBe(201);

    const ulid = chat.ulid!;

    await panel.expectState('queued');
    await expectCalmPanel(panel);

    // Alice's next poll brings the request into her queue; she accepts it.
    await afterPolls(alice.page, AGENT_POLL_MS, () =>
        expect(alice.inbox.offer(ulid)).toBeVisible({ timeout: 1_500 }),
    );
    await expect(alice.inbox.tid(`offer-category-${ulid}`)).toContainText(
        'Billing',
    );
    await alice.inbox.accept(ulid);

    // The visitor's next poll shows the active chat with Alice.
    await afterPolls(visitor.page, VISITOR_POLL_MS, () =>
        panel.expectState('active', 1_500),
    );
    await expect(
        panel.root.getByRole('heading', { name: alice.user.name }),
    ).toBeVisible();

    // A message each way, each one picked up by the other side's poll.
    await panel.send('Hello, polling works for me.');
    await afterPolls(alice.page, AGENT_POLL_MS, () =>
        expect(alice.inbox.message('polling works').first()).toBeVisible({
            timeout: 1_500,
        }),
    );
    await alice.inbox.send('Great, and it works for me too.');
    await afterPolls(visitor.page, VISITOR_POLL_MS, () =>
        expect(panel.message('works for me too', 'agent').first()).toBeVisible({
            timeout: 1_500,
        }),
    );

    // The visitor's poll also marks the message as seen, which Alice's next poll shows.
    await afterPolls(alice.page, AGENT_POLL_MS, () =>
        expect(
            alice.inbox.conversation.locator(
                'li[data-sender="agent"][data-status="seen"]',
            ),
        ).toHaveCount(1, { timeout: 1_500 }),
    );

    // And the other way round: Alice has the chat open, so her receipt marks the visitor's message as seen, which the visitor's
    // next poll shows.
    await afterPolls(visitor.page, VISITOR_POLL_MS, () =>
        expect(
            panel.message('polling works for me', 'visitor').first(),
        ).toHaveAttribute('data-status', 'seen', { timeout: 1_500 }),
    );
    await expectCalmPanel(panel);

    // Alice ends the chat; the visitor's poll shows the rating card, the rating closes it.
    await alice.inbox.endChat();
    await afterPolls(visitor.page, VISITOR_POLL_MS, () =>
        panel.expectState('ended', 1_500),
    );
    await panel.rate(4, 'Fine, even without sockets.');
    await panel.expectState('closed');

    const row = await expectEventually(
        () => readConversationRow(instance, ulid),
        (value) => value.conversation.status === 'closed',
        { message: 'the rated chat is closed' },
    );

    expect(row.conversation).toMatchObject({
        close_reason: 'rated',
        ended_by: 'agent',
    });
    expect(row.rating).toMatchObject({
        score: 4,
        comment: 'Fine, even without sockets.',
    });
    await expectCalmPanel(panel);

    // Nothing the polling does failed: no 4xx or 5xx on the visitor's side.
    expect(
        visitor.watch.statuses.filter((status) => /-> [45]\d\d$/.test(status)),
    ).toEqual([]);
});

test('a chat nobody accepts is noticed over polling: the offer leaves the dashboard and the visitor is offered the offline form', async ({
    actors,
    adminApi,
    instance,
}) => {
    test.setTimeout(120_000);

    const alice = await actors.staff('alice', { presence: 'online' });
    const visitor = await actors.visitor();

    await alice.page.clock.install();
    await visitor.page.clock.install();
    await alice.inbox.goto();

    const panel = await openCustomerSite(visitor.page, instance, {
        open: true,
    });
    const chat = await panel.startChat({
        category: 'billing',
        name: 'Missed Milo',
    });
    const ulid = chat.ulid!;

    await afterPolls(alice.page, AGENT_POLL_MS, () =>
        expect(alice.inbox.offer(ulid)).toBeVisible({ timeout: 1_500 }),
    );

    // The queue runs out (time moved by hand, the sweep run as the scheduler would).
    await ageConversation(instance, ulid, { queueExpired: true });
    await runSweep(instance, 'chat:expire-queued');

    // Both sides find out on their next poll; the visitor's waiting screen turns into the offline form.
    await afterPolls(visitor.page, VISITOR_POLL_MS, () =>
        panel.expectState('offline', 1_500),
    );
    await expect(panel.tid('offline-form')).toBeVisible();
    await afterPolls(alice.page, AGENT_POLL_MS, () =>
        expect(alice.inbox.offer(ulid)).toHaveCount(0, { timeout: 1_500 }),
    );
    await expectCalmPanel(panel);

    expect(
        must<{ status: string }>(
            await adminApi.get(`/api/v1/conversations/${ulid}`),
            'the administrator reads the chat',
        ).status,
    ).toBe('missed');
});
