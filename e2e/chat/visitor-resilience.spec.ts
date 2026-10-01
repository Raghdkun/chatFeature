import { must, type Message, VisitorApi } from '../support/chat-api';
import { endVisitorSession, readConversationRow } from '../support/chat-db';
import {
    acceptAs,
    createTeam,
    expect,
    soloChat,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { chatFeature, recordedEvents, widget } from '../support/host';
import { openCustomerSite } from '../support/panel';
import { expectEventually } from '../support/wait';

/**
 * A visitor's chat has to survive what browsers do: the network drops, the page reloads, a second tab opens, the storage is
 * cleared, the session is revoked, Reverb is not reachable. Each test is its own isolated team (`createTeam()` / `soloChat()`);
 * the stored messages and the number of conversations are the persisted truth.
 */
test.use({ scenario: 'p4-chat' });

const bodies = (messages: Message[], sender: Message['sender']['type']) =>
    messages
        .filter((message) => message.sender.type === sender)
        .map((message) => message.body);

test("the network drops mid-chat: messages sent meanwhile fail with Retry, the agent's arrive when the visitor is back, nothing is duplicated and the order is the server's", async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid, visitor } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );

    await panel.send('Before the outage');
    await agent.inbox.expectMessage('Before the outage');

    visitor.watch.allow(/ERR_INTERNET_DISCONNECTED|WebSocket|Failed to fetch/);
    await visitor.context.setOffline(true);

    // Offline the visitor keeps typing: each message is shown as not sent, with a way to retry.
    await panel.send('Typed while offline 1');
    await panel.send('Typed while offline 2');
    await expect(
        panel.messageList.locator('[data-status="failed"]'),
    ).toHaveCount(2);

    // The agent writes meanwhile (stored and published; the visitor's socket is down).
    must(await agent.api.send(ulid, 'Agent while you were away 1'), 'reply 1');
    must(await agent.api.send(ulid, 'Agent while you were away 2'), 'reply 2');

    await visitor.context.setOffline(false);

    // Back online the panel catches up by itself: the agent's messages show, in order.
    await panel.expectMessage('Agent while you were away 2', 'agent');
    await panel.expectMessage('Agent while you were away 1', 'agent');

    // The failed ones are still the visitor's to retry; each goes through exactly once.
    for (const text of ['Typed while offline 1', 'Typed while offline 2']) {
        const failed = panel.message(text, 'visitor');

        if ((await failed.getAttribute('data-status')) === 'failed') {
            await failed.getByTestId('message-retry').click();
        }

        await expect(failed).not.toHaveAttribute('data-status', 'failed');
    }

    await agent.inbox.expectMessage('Typed while offline 2');

    const stored = await expectEventually(
        async () =>
            must<Message[]>(
                await agent.api.messages(ulid),
                'the stored messages',
            ).filter((message) => message.type === 'text'),
        (messages) => messages.length === 5,
        { message: 'every message is stored exactly once' },
    );

    expect(bodies(stored, 'visitor')).toEqual([
        'Before the outage',
        'Typed while offline 1',
        'Typed while offline 2',
    ]);
    expect(bodies(stored, 'agent')).toEqual([
        'Agent while you were away 1',
        'Agent while you were away 2',
    ]);

    // The panel shows the stored order: seq, with what could not be sent behind the agent's messages that were stored first.
    await expect
        .poll(() =>
            panel.messageList
                .locator(
                    '[data-testid^="message-"][data-sender="visitor"], [data-testid^="message-"][data-sender="agent"]',
                )
                .evaluateAll((nodes) =>
                    nodes.map((node) => node.getAttribute('data-sender')),
                ),
        )
        .toEqual(stored.map((message) => message.sender.type));
    await expect(
        panel.messageList.locator(
            '[data-status="sending"], [data-status="failed"]',
        ),
    ).toHaveCount(0);
});

test('a page reload resumes the same chat: while queued, and while active with the transcript', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Rae'] });
    const rae = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const flow = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Rex Reload',
    });
    const { panel, ulid, visitor } = flow;

    // Queued: reload, open, and it is the same waiting chat (the same ticket, no second chat, the offer still there).
    await visitor.page.reload();
    await panel.open();
    await panel.expectState('queued');
    await expect(panel.tid('queued-timer')).toBeVisible();

    const waiting = await VisitorApi.withToken(
        instance,
        (await panel.visitorToken())!,
        visitor.address,
    );

    expect(
        must<{ ulid: string }>(
            await waiting.conversation(),
            "the visitor's conversation",
        ).ulid,
    ).toBe(ulid);
    await waiting.dispose();
    await rae.inbox.expectOffer(ulid);

    // Accepted, a few messages, reload again: still active with every message, the agent's header and a working composer.
    await rae.inbox.accept(ulid);
    await panel.expectState('active');
    await panel.send('I am here before the reload');
    await rae.inbox.expectMessage('before the reload');
    await rae.inbox.send('Noted, carry on.');
    await panel.expectMessage('Noted, carry on', 'agent');

    await visitor.page.reload();
    await panel.open();
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: team.agents[0].name }),
    ).toBeVisible();
    await panel.expectMessage('I am here before the reload', 'visitor');
    await panel.expectMessage('Noted, carry on', 'agent');
    await panel.send('And after the reload');
    await rae.inbox.expectMessage('And after the reload');

    // One conversation for the visitor on this widget, whatever happened to the token on the way.
    const all = must<{ ulid: string }[]>(
        await adminApi.get(
            `/api/v1/conversations?widget=${team.widget.ulid}&limit=50`,
        ),
        "the widget's conversations",
    );

    expect(all.map((conversation) => conversation.ulid)).toEqual([ulid]);
});

test('a new visit is a new ticket: with the storage cleared the old transcript is not shown and a new chat starts', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid, ticketNo, visitor, team } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );

    await panel.send('Secret order number 99183');
    await agent.inbox.expectMessage('Secret order number 99183');

    // The next visit: same browser, nothing stored for this site.
    await visitor.page.evaluate(() => window.localStorage.clear());
    await visitor.page.reload();
    await panel.open();

    await expect(panel.messageList).toHaveCount(0);
    await expect(panel.frame.getByText('Secret order number')).toHaveCount(0);
    await panel.expectState(['idle', 'prechat', 'category']);

    const second = await panel.startChat({
        category: team.category.slug,
        name: 'Vera Visitor',
    });

    chats.track(second.ulid);
    expect(second.status).toBe(201);
    expect(second.ulid).not.toBe(ulid);
    expect(second.ticketNo).not.toBe(ticketNo);

    // The first chat is untouched (the agent still has it); the new one is a separate ticket waiting for an agent.
    expect(
        must<{ status: string }>(
            await agent.api.conversation(ulid),
            'the first chat',
        ).status,
    ).toBe('active');
    await agent.inbox.goto();
    await agent.inbox.expectOffer(second.ulid!);
    await expect(panel.frame.getByText('Secret order number')).toHaveCount(0);
});

test('two tabs of the same visitor: the second tab resumes the chat and rotates the token; the first tab keeps the chat (no "chat ended", no second chat), keeps the stored session and can send again', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const {
        agent,
        panel: tabA,
        ulid,
        visitor,
        team,
    } = await soloChat(actors, adminApi, instance, chats);

    await tabA.send('Message from tab A');
    await agent.inbox.expectMessage('Message from tab A');

    const first = (await tabA.visitorToken())!;

    // Tab B of the same browser (same storage): its panel resumes the chat and the server rotates the token. The chat now belongs to
    // the new session; the old token still works for a minute but no longer reaches the conversation.
    const pageB = await visitor.context.newPage();
    const tabB = await openCustomerSite(pageB, instance, {
        key: team.widget.key,
        open: true,
    });

    await tabB.expectState('active');
    await tabB.expectMessage('Message from tab A', 'visitor');

    const rotated = (await tabB.visitorToken())!;

    expect(rotated).toMatch(/^vt_/);
    expect(rotated).not.toBe(first);
    // The one stored entry is shared: tab A sees the new token too.
    expect(await tabA.visitorToken()).toBe(rotated);

    await tabB.send('Message from tab B');
    await agent.inbox.expectMessage('Message from tab B');

    // The visitor goes back to tab A: the browser tells its panel it is visible again and the panel reads the chat from the server.
    // It must not decide "the chat is over" because its old session has no conversation any more.
    await tabA.frame.locator('body').evaluate(() => {
        document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(tabA.message('Message from tab B', 'visitor')).toBeVisible();
    await tabA.expectState('active');
    await expect(tabA.frame.getByText('This chat has ended.')).toHaveCount(0);
    expect(await tabA.visitorToken()).not.toBeNull();

    // Tab A writes again (it carries on with the stored session): once, in order, in the same chat.
    await tabA.send('Message from tab A, again');
    await agent.inbox.expectMessage('Message from tab A, again');
    await expect(
        tabA.messageList.locator('[data-status="failed"]'),
    ).toHaveCount(0);

    // The grace window of the first token runs out: nothing changes for either tab.
    await endVisitorSession(instance, first, 'expire');
    await tabA.send('Message from tab A after the overlap');
    await agent.inbox.expectMessage('after the overlap');
    await tabB.send('Message from tab B after the overlap');
    await agent.inbox.expectMessage('Message from tab B after the overlap');

    const stored = must<Message[]>(
        await agent.api.messages(ulid),
        'the stored messages',
    );

    expect(bodies(stored, 'visitor')).toEqual([
        'Message from tab A',
        'Message from tab B',
        'Message from tab A, again',
        'Message from tab A after the overlap',
        'Message from tab B after the overlap',
    ]);
    await tabA.expectState('active');
    await tabB.expectState('active');

    const all = must<{ ulid: string }[]>(
        await adminApi.get(
            `/api/v1/conversations?widget=${team.widget.ulid}&limit=50`,
        ),
        "the widget's conversations",
    );

    expect(all.map((conversation) => conversation.ulid)).toEqual([ulid]);
});

test('a message sent from the older tab before it noticed the rotation fails with Retry (404: the chat moved) and the retry goes through with the stored session', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const {
        agent,
        panel: tabA,
        ulid,
        visitor,
        team,
    } = await soloChat(actors, adminApi, instance, chats);

    await tabA.send('Message from tab A');
    await agent.inbox.expectMessage('Message from tab A');

    const pageB = await visitor.context.newPage();
    const tabB = await openCustomerSite(pageB, instance, {
        key: team.widget.key,
        open: true,
    });

    await tabB.expectState('active');

    // Tab A did not hear about it: its first send with the rotated-out token is refused (the chat is not its session's any more).
    await tabA.send('Typed in the stale tab');

    const stale = tabA.message('Typed in the stale tab', 'visitor');

    await expect(stale).toHaveAttribute('data-status', 'failed');
    expect(
        visitor.watch.statuses.filter((entry) =>
            entry.endsWith(`/conversations/${ulid}/messages -> 404`),
        ),
    ).toHaveLength(1);

    // The panel asked the host for the current session and adopted it: Retry now works, once, and the chat is still the same one.
    await expect(stale.getByTestId('message-retry')).toBeVisible();
    await stale.getByTestId('message-retry').click();
    await expect(stale).not.toHaveAttribute('data-status', 'failed');
    await agent.inbox.expectMessage('Typed in the stale tab');
    await tabA.expectState('active');
    expect(await tabA.visitorToken()).toBe(await tabB.visitorToken());
    expect(
        bodies(
            must<Message[]>(await agent.api.messages(ulid), 'the messages'),
            'visitor',
        ),
    ).toEqual(['Message from tab A', 'Typed in the stale tab']);
});

test('a revoked session ends the chat view without a crash and the visitor can start over with a fresh session; a reload with a dead token comes up clean', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, visitor, team } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const token = (await panel.visitorToken())!;

    await panel.send('Before the revocation');
    await agent.inbox.expectMessage('Before the revocation');

    // The session is revoked behind the visitor's back (a sign-out elsewhere, an expired lifetime).
    await endVisitorSession(instance, token, 'revoke');
    await panel.send('After the revocation');

    await panel.expectState('closed');
    await expect(
        panel.frame.getByText(
            'Your session expired. Start a new chat to continue.',
        ),
    ).toBeVisible();
    expect(await panel.visitorToken()).toBeNull();

    // A new chat is a fresh session and a new ticket, and an agent can take it.
    await panel.newChat();

    const again = await panel.startChat({
        category: team.category.slug,
        name: 'Vera Visitor',
    });

    chats.track(again.ulid);
    expect(again.status).toBe(201);
    await agent.inbox.goto();
    await agent.inbox.expectOffer(again.ulid!);
    await agent.inbox.accept(again.ulid!);
    await panel.expectState('active');

    // Now the reload with a stored token that the server no longer knows (expired in the database): no crash, a clean start.
    const fresh = (await panel.visitorToken())!;

    await endVisitorSession(instance, fresh, 'expire');
    await visitor.page.reload();
    await panel.open();
    await panel.expectState(['closed', 'idle', 'prechat', 'category']);
    await expect(panel.tid('panel-error')).toHaveCount(0);
    expect(await panel.visitorToken()).toBeNull();
});

test('the host page API: startChat on a cold start, open / close / toggle, getState, and shutdown that forgets the visitor', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Hal'] });
    const hal = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        visitor: { name: 'Hosty McHost', email: 'hosty@example.test' },
    });
    const { page } = visitor;

    // open / close / toggle drive the panel; getState tells what the page can know.
    expect(
        await chatFeature<{ open: boolean }>(page, 'getState'),
    ).toMatchObject({
        open: false,
        status: 'idle',
    });
    await chatFeature(page, 'open');
    await expect(widget(page).panel).toBeVisible();
    await chatFeature(page, 'close');
    await expect(widget(page).panel).toBeHidden();
    await chatFeature(page, 'toggle');
    await expect(widget(page).panel).toBeVisible();
    await chatFeature(page, 'close');

    // startChat from the host page (a "Chat with sales" button): opens the panel and starts with the topic and the first message.
    await chatFeature(page, 'startChat', {
        category: team.category.slug,
        message: 'Do you have size 42 in stock?',
    });
    await expect(widget(page).panel).toBeVisible();
    await panel.expectState(['queued', 'prechat', 'category']);

    if ((await panel.state()) !== 'queued') {
        await panel.startChat({
            category: team.category.slug,
            name: 'Hosty McHost',
        });
    }

    await panel.expectState('queued');

    const queued = await expectEventually(
        async () =>
            must<{ ulid: string }[]>(
                await hal.api.queue(),
                'Hal reads the queue',
            ),
        (items) => items.length > 0,
        { message: 'the host-started chat is offered to the agent' },
    );
    const ulid = chats.track(queued[0].ulid);

    await hal.inbox.expectOffer(ulid);
    await hal.inbox.accept(ulid);
    await panel.expectState('active');
    await hal.inbox.expectMessage('size 42');

    const first = must<Message[]>(
        await hal.api.messages(ulid),
        'the first message',
    ).find((message) => message.sender.type === 'visitor');

    expect(first?.body).toBe('Do you have size 42 in stock?');
    expect(
        await chatFeature<{ status: string }>(page, 'getState'),
    ).toMatchObject({ status: 'active' });
    expect((await recordedEvents(page)).map((event) => event.name)).toEqual(
        expect.arrayContaining(['chat-started', 'agent-joined']),
    );

    // shutdown tears the widget down and forgets the visitor: the stored session is gone, the chat itself stays with the agent.
    expect(await panel.visitorToken(team.widget.key)).toMatch(/^vt_/);
    await chatFeature(page, 'shutdown');
    await expect(page.locator('pne-chat-widget')).toHaveCount(0);
    expect(
        await page.evaluate(
            (key) => window.localStorage.getItem(`chatfeature:${key}:session`),
            team.widget.key,
        ),
    ).toBeNull();
    expect(
        must<{ status: string }>(
            await hal.api.conversation(ulid),
            'the chat after shutdown',
        ).status,
    ).toBe('active');
});

test('Reverb is unreachable: the visitor still chats over REST, learns the chat was accepted by polling, and the typing reaches the agent through the server', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Pia'] });
    const pia = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();

    // Every websocket the visitor's browser tries to open is closed at once: as if the realtime server were down.
    visitor.watch.allow(/WebSocket/);
    await visitor.context.routeWebSocket(/\/app\//, (socket) => socket.close());

    const flow = await startQueuedChat(actors, instance, chats, {
        actor: visitor,
        key: team.widget.key,
        category: team.category.slug,
        name: 'Poll Visitor',
    });
    const { panel, ulid } = flow;

    await pia.inbox.expectOffer(ulid);
    await pia.inbox.accept(ulid);

    // No event can arrive: the panel's fallback asks the server every 10 s and finds out the chat is active.
    await panel.expectState('active', 30_000);
    await expect(panel.tid('panel-error')).toHaveCount(0);

    // Messages: the visitor's go over REST at once; the agent's arrive with the next poll.
    await panel.send('Sent without a websocket');
    await pia.inbox.expectMessage('Sent without a websocket');
    must(await pia.api.send(ulid, 'Answer through the poll'), 'reply');
    await expect(panel.message('Answer through the poll', 'agent')).toBeVisible(
        {
            timeout: 30_000,
        },
    );

    // Typing falls back to the server too (`POST .../typing`, published by the server to the agent's socket).
    const typing = pia.inbox.conversation.getByTestId('typing-indicator');

    await expect(async () => {
        await panel.composerInput.pressSequentially('t');
        await expect(typing).toBeVisible({ timeout: 3500 });
    }).toPass({ timeout: 20_000 });

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation.status).toBe('active');
    await acceptedOnce(pia, ulid);
});

async function acceptedOnce(
    agent: Parameters<typeof acceptAs>[0],
    ulid: string,
): Promise<void> {
    const result = await agent.api.claim(ulid);

    // Claiming a chat you already hold is a no-op (`200`), never a second assignment.
    expect(result.status).toBe(200);
}
