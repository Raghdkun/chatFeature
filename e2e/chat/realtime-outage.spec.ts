import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import { SEED_ROUTING } from '../support/chat-seed';
import { SocketGate } from '../support/realtime';
import { startChat } from '../support/staff-flow';
import { isPhone, readMessages, showList } from '../support/staff-ui';

/**
 * The websocket fails in the middle of a session and comes back. Only the browser of ONE person loses its socket
 * (`BrowserContext.routeWebSocket` in front of Reverb: the socket is cut and every reconnection refused until the spec lets it
 * through), the server and everybody else stay up. The page must say so, keep working over REST polling (15 s for the dashboard, 10 s
 * for the visitor's panel; the page's own clock, so a poll interval passes at once) and, when the socket is back, catch up on what it
 * missed with `after_seq` and go live again. Own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

/** A queue that outlasts a few jumps of the page clock (the seeded 45 s would lapse the offer of the second visitor). */
const LONG_QUEUE = {
    settings: { queue_timeout_seconds: 600 },
    config: { routing: { ...SEED_ROUTING, queueTimeoutSeconds: 600 } },
};

/** Chrome logs every refused / cut websocket as a console error: this is the very thing the specs cause. */
const SOCKET_NOISE = [/WebSocket/i];

test('the dashboard loses its socket mid-chat: it says so, polls for the missed messages and offers, and goes live again when the socket returns', async ({
    actors,
    adminApi,
    instance,
}) => {
    test.setTimeout(120_000);

    let gate!: SocketGate;
    const afterSeqCalls: number[] = [];
    const { agent, panel, ulid, world } = await startChat(
        { actors, adminApi, instance },
        {
            // The page clock jumps by 15 s a poll: keep the waiting offer of the second visitor alive on it.
            plan: LONG_QUEUE,
            allowAgent: SOCKET_NOISE,
            prepareAgent: async (actor) => {
                gate = await SocketGate.install(actor.context, instance);
                await actor.page.clock.install();
                actor.page.on('request', (request) => {
                    const url = new URL(request.url());
                    const match =
                        /^\/api\/v1\/conversations\/[0-9a-z]{26}\/messages$/.exec(
                            url.pathname,
                        );

                    if (match && request.method() === 'GET') {
                        afterSeqCalls.push(
                            Number(url.searchParams.get('after_seq')),
                        );
                    }
                });
            },
        },
    );
    const banner = agent.inbox.tid('connection-banner');

    // Connected: no banner, a message arrives live.
    await expect(banner).toHaveCount(0);
    await panel.send('Before the outage.');
    await agent.inbox.expectMessage('Before the outage.');
    expect(gate.attempts).toBeGreaterThan(0);

    // The socket is cut and cannot come back. The banner lives in the list column: on a phone that is the screen behind the open
    // conversation (BUG E2-3 below), so step back to read it and go into the chat again.
    await gate.block();

    if (isPhone(agent.page)) {
        await showList(agent);
    }

    await expect(banner).toBeVisible();
    await expect(banner).toContainText('every 15 seconds');
    await expect(banner).not.toHaveAttribute('data-status', 'connected');

    if (isPhone(agent.page)) {
        await agent.inbox.chatRow(ulid).click();
        await expect(agent.inbox.conversation).toBeVisible();
    }

    // While it is down the visitor writes twice and a second visitor asks for a chat: only REST can bring any of it ...
    await panel.send('First message during the outage.');
    await panel.send('Second message during the outage.');

    const other = await VisitorApi.start(instance, { key: world.widget.key });
    const second = must<{ ulid: string }>(
        await other.startChat({
            category: world.categories.main.slug,
            name: 'Outage Olga',
        }),
        'a second visitor starts a chat',
    );

    // ... until the next poll tick: the open conversation asks for what came after the last message it holds, the lists are read again.
    const held = afterSeqCalls.length;

    await expect(async () => {
        await agent.page.clock.fastForward(15_000);
        await expect(
            agent.inbox.message('Second message during the outage.').first(),
        ).toBeVisible({ timeout: 2_000 });
    }).toPass({ timeout: 30_000, intervals: [500] });
    await agent.inbox.expectMessage('First message during the outage.');
    expect(afterSeqCalls.length).toBeGreaterThan(held);
    expect(afterSeqCalls.slice(held).every((seq) => seq >= 1)).toBe(true);

    // The server's order is intact: no duplicates, no holes (seq 1 is "<agent> joined the chat").
    const stored = await readMessages(agent, ulid);

    expect(stored.map((message) => message.seq)).toEqual(
        stored.map((_, index) => index + 1),
    );

    // The offer of the second visitor came with the same poll tick (the lists are read on the dashboard's own 15 s timer).
    // On a phone the list is behind the back arrow.
    await showList(agent);
    await agent.inbox.expectOffer(second.ulid);

    // The socket returns: let the client's retry through. The banner goes, and the next message is live again (no clock help).
    gate.allow();
    await expect(async () => {
        await agent.page.clock.fastForward(5_000);
        await expect(banner).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 40_000, intervals: [500] });

    // Back on the conversation of the first chat (the second offer is still waiting) and live: a message with the clock standing still.
    await agent.inbox.goto(ulid);
    await panel.send('After the outage, live again.');
    await agent.inbox.expectMessage('After the outage, live again.');

    const afterRecovery = await expectEventually(
        () => readMessages(agent, ulid),
        (messages) =>
            messages.some(
                (message) => message.body === 'After the outage, live again.',
            ),
    );

    expect(afterRecovery.map((message) => message.seq)).toEqual(
        afterRecovery.map((_, index) => index + 1),
    );

    await other.dispose();
});

// BUG E2-3 (open): the "live updates are off / checks every 15 seconds" notice is part of the list column. On a phone the list and an
// open conversation are separate screens, so an agent inside a chat gets no sign that the page is no longer live (messages arrive up to
// 15 s late). On a desktop the list is next to the chat and the notice is in view.
test('the notice that live updates are off stays in view while a conversation is open (BUG E2-3 on phones)', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    test.fixme(
        testInfo.project.name === 'mobile',
        'BUG E2-3: on a phone the connection banner is only in the list column, not inside an open conversation',
    );

    let gate!: SocketGate;
    const { agent } = await startChat(
        { actors, adminApi, instance },
        {
            allowAgent: SOCKET_NOISE,
            prepareAgent: async (actor) => {
                gate = await SocketGate.install(actor.context, instance);
            },
        },
    );

    await expect(agent.inbox.conversation).toBeVisible();
    await gate.block();
    await expect(agent.inbox.tid('connection-banner')).toBeVisible();
});

test('the visitor\'s panel loses its socket mid-chat: "Reconnecting…", the agent\'s messages arrive by polling, and the panel recovers', async ({
    actors,
    adminApi,
    instance,
}) => {
    test.setTimeout(120_000);

    let gate!: SocketGate;
    const { agent, panel } = await startChat(
        { actors, adminApi, instance },
        {
            allowVisitor: SOCKET_NOISE,
            prepareVisitor: async (visitor) => {
                gate = await SocketGate.install(visitor.context, instance);
                await visitor.page.clock.install();
            },
        },
    );

    // Connected: an agent message arrives live and the panel is calm.
    await agent.inbox.send('Live message.');
    await panel.expectMessage('Live message.', 'agent');
    await expect(panel.tid('connection-status')).toHaveCount(0);
    expect(gate.attempts).toBeGreaterThan(0);

    // The panel's socket is cut: it shows the quiet "Reconnecting…" line, not an error.
    await gate.block();
    await expect(panel.tid('connection-status')).toBeVisible();
    await expect(panel.tid('connection-status')).toContainText('Reconnecting');
    await expect(panel.frame.locator('[role="alert"]')).toHaveCount(0);

    // The agent writes while it is down: the panel's own 10 s poll brings it in.
    await agent.inbox.send('Sent during the outage.');
    await panel.page.clock.fastForward(10_000);
    await panel.expectMessage('Sent during the outage.', 'agent');

    // The visitor can still write (REST) and the agent gets it live (the agent's socket is fine).
    await panel.send('Visitor writing during the outage.');
    await agent.inbox.expectMessage('Visitor writing during the outage.');

    // The socket returns: the line goes away and messages are live again.
    gate.allow();
    await expect(async () => {
        await panel.page.clock.fastForward(5_000);
        await expect(panel.tid('connection-status')).toHaveCount(0, {
            timeout: 1_000,
        });
    }).toPass({ timeout: 40_000, intervals: [500] });

    await agent.inbox.send('Live again.');
    await panel.expectMessage('Live again.', 'agent');
    await expect(panel.frame.locator('[role="alert"]')).toHaveCount(0);
});
