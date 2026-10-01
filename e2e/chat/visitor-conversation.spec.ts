import { must, type Message } from '../support/chat-api';
import { expect, soloChat, test } from '../support/chat-flows';
import { widget } from '../support/host';
import { expectEventually } from '../support/wait';

/**
 * What happens inside a running conversation, between the real panel on the customer site and the agent's inbox, with the stored
 * messages (`GET .../messages`) as the persisted truth: typing indicators both ways, delivered / seen receipts, rapid sends keep
 * their order, plain-text safety (HTML-like text, 150-character unbroken tokens, URLs and what is linked), the "new messages" pill
 * and a failed send that is retried. Each test is its own isolated team (`soloChat()`), so nothing else in the scenario interferes.
 */
test.use({ scenario: 'p4-chat' });
// Several browsers per test, and the machine also runs other suites: the per-test budget is generous (a test takes 3-12 s on a quiet machine).
test.setTimeout(120_000);

/** The bubbles of the two people in the panel's list (the system lines such as "joined the chat" are not messages of theirs). */
const PEOPLE =
    '[data-testid^="message-"][data-sender="visitor"], [data-testid^="message-"][data-sender="agent"]';

const bodies = (messages: Message[], sender: Message['sender']['type']) =>
    messages
        .filter((message) => message.sender.type === sender)
        .map((message) => message.body);

test('typing shows both ways: the visitor typing reaches the agent, the agent typing reaches the visitor, sending or emptying the box clears it', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel } = await soloChat(actors, adminApi, instance, chats);
    const agentSees = agent.inbox.conversation.getByTestId('typing-indicator');

    // Visitor -> agent (a client whisper over the socket). The whisper repeats every 3 s while the visitor keeps typing, so a first one
    // that left before the agent's browser had subscribed to the chat is made up for by the next keystroke.
    await expect(async () => {
        await panel.composerInput.pressSequentially('typing');
        await expect(agentSees).toBeVisible({ timeout: 3500 });
    }).toPass({ timeout: 20_000 });
    await panel.composerInput.fill('');
    await expect(agentSees).toBeHidden();

    // Sending a message clears it as well.
    await panel.composerInput.pressSequentially('and another');
    await expect(agentSees).toBeVisible();
    await panel.composerInput.press('Enter');
    await agent.inbox.expectMessage('and another');
    await expect(agentSees).toBeHidden();

    // Agent -> visitor: the indicator in the list and the polite status line for screen readers.
    await expect(async () => {
        await agent.inbox.composerInput.pressSequentially('Let me');
        await expect(panel.tid('typing-indicator')).toBeVisible({
            timeout: 3500,
        });
    }).toPass({ timeout: 20_000 });
    await expect(
        panel.frame
            .getByRole('status')
            .filter({ hasText: `${agent.user.name} is typing` }),
    ).toHaveCount(1);
    await agent.inbox.composerInput.fill('');
    await expect(panel.tid('typing-indicator')).toBeHidden();
});

test('receipts: a message the agent is looking at turns seen on the visitor side, one the agent has not opened stays sent until they open the chat', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );

    // The agent has the conversation open and the tab in front: the visitor's message is seen at once (ticks and the word).
    await panel.send('First message, you are looking at this one.');

    const first = panel.message('First message', 'visitor');

    await expect(first).toHaveAttribute('data-status', 'seen');
    await expect(first.getByTestId('message-receipt')).toContainText('Seen');

    // The agent goes back to the list: the next message is stored and delivered to the agent's inbox, but not seen.
    await agent.inbox.goto();
    await panel.send('Second message, nobody is reading yet.');

    const second = panel.message('Second message', 'visitor');

    await expect(second).toHaveAttribute('data-status', /^(sent|delivered)$/);
    await expect(agent.inbox.chatRow(ulid)).toContainText('Second message');
    await expect(agent.inbox.tid(`chat-unseen-${ulid}`)).toHaveText(/^1/);

    const unread = must<Message[]>(
        await agent.api.messages(ulid),
        'the agent reads the messages',
    ).filter((message) => message.body?.startsWith('Second'));

    expect(unread[0].seenAt).toBeNull();

    // Opening the chat marks it seen: the visitor's bubble follows and the agent's badge goes.
    await agent.inbox.chatRow(ulid).click();
    await expect(second).toHaveAttribute('data-status', 'seen');
    await expect(agent.inbox.tid(`chat-unseen-${ulid}`)).toHaveCount(0);

    const stored = must<Message[]>(
        await agent.api.messages(ulid),
        'the stored receipts',
    ).filter((message) => message.sender.type === 'visitor');

    expect(stored.every((message) => message.seenAt !== null)).toBe(true);
    expect(stored.every((message) => message.deliveredAt !== null)).toBe(true);

    // And the other way round: the visitor's open panel reads the agent's reply, the agent's own bubble turns seen.
    await agent.inbox.send('Third message, from the agent.');
    await panel.expectMessage('Third message', 'agent');
    await expect(agent.inbox.message('Third message').first()).toHaveAttribute(
        'data-status',
        'seen',
    );
});

test('a reply sent while the visitor has the panel closed is stored as delivered but not seen until they open it', async ({
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

    await panel.send('Ping from the visitor.');
    await agent.inbox.expectMessage('Ping from the visitor');

    // The visitor minimises the chat (the panel stays alive in its iframe).
    await visitor.page.evaluate(() =>
        (
            window as unknown as { ChatFeature: (...call: unknown[]) => void }
        ).ChatFeature('close'),
    );
    await expect(widget(visitor.page).panel).toBeHidden();

    await agent.inbox.send('Reply while you are away.');

    const reply = await expectEventually(
        async () =>
            must<Message[]>(
                await agent.api.messages(ulid),
                'the agent reads the messages',
            ).find((message) => message.body === 'Reply while you are away.'),
        (message) => message?.deliveredAt != null,
        { message: 'the visitor panel confirms delivery without being open' },
    );

    expect(reply?.seenAt).toBeNull();
    // `delivered` is broadcast (`message.delivered`): the agent's open inbox shows it live, without a reload.
    await expect(
        agent.inbox.message('Reply while you are away').first(),
    ).toHaveAttribute('data-status', 'delivered');

    // Opening the panel shows the message and marks it seen.
    await panel.launcher.click();
    await panel.expectMessage('Reply while you are away', 'agent');
    await expect(
        agent.inbox.message('Reply while you are away').first(),
    ).toHaveAttribute('data-status', 'seen');
});

test('rapid sends from both sides keep their order everywhere: panel, inbox and the stored sequence numbers', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );
    const visitorTexts = Array.from(
        { length: 8 },
        (_, index) => `visitor ${index + 1}`,
    );
    const agentTexts = Array.from(
        { length: 5 },
        (_, index) => `agent ${index + 1}`,
    );

    // Typed as fast as the box takes them, nothing waits for an acknowledgement in between.
    for (const text of visitorTexts) {
        await panel.composerInput.fill(text);
        await panel.composerInput.press('Enter');
    }

    for (const text of agentTexts) {
        await agent.inbox.composerInput.fill(text);
        await agent.inbox.composerInput.press('Enter');
    }

    const stored = await expectEventually(
        async () =>
            must<Message[]>(
                await agent.api.messages(ulid),
                'the stored messages',
            ).filter((message) => message.type === 'text'),
        (messages) =>
            messages.length === visitorTexts.length + agentTexts.length,
        { message: 'every message is stored once' },
    );

    // Each side's own messages are in typing order and the sequence numbers are strictly increasing.
    expect(bodies(stored, 'visitor')).toEqual(visitorTexts);
    expect(bodies(stored, 'agent')).toEqual(agentTexts);
    expect(stored.map((message) => message.seq)).toEqual(
        stored.map((message) => message.seq).sort((a, b) => a - b),
    );
    expect(new Set(stored.map((message) => message.seq)).size).toBe(
        stored.length,
    );

    // The panel and the inbox show exactly the stored order.
    const expected = stored.map((message) => message.body);

    await expect
        .poll(
            () =>
                panel.messageList.locator(PEOPLE).evaluateAll((nodes) =>
                    nodes.map((node) => {
                        // the text of the bubble without its time and receipt (a "1:05 PM" would otherwise swallow a trailing digit)
                        const copy = node.cloneNode(true) as HTMLElement;

                        copy.querySelectorAll(
                            'time, [data-testid="message-receipt"]',
                        ).forEach((element) => element.remove());

                        return (copy.textContent ?? '').trim();
                    }),
                ),
            { message: 'the panel lists the messages in the stored order' },
        )
        .toEqual(expected.map((text) => expect.stringContaining(text!)));

    await expect(
        agent.inbox.conversation
            .getByTestId('message-list')
            .locator('[data-testid^="message-"][data-sender]'),
    ).toHaveCount(expected.length);
    expect(
        await agent.inbox.conversation
            .getByTestId('message-list')
            .locator('[data-testid^="message-"][data-sender]')
            .evaluateAll((nodes) =>
                nodes.map((node) => node.textContent ?? ''),
            ),
    ).toEqual(expected.map((text) => expect.stringContaining(text!)));

    // Nothing is left "sending" or "failed" in the panel.
    await expect(
        panel.messageList.locator(
            '[data-status="sending"], [data-status="failed"]',
        ),
    ).toHaveCount(0);
});

test('Enter sends, Shift+Enter breaks the line, and the line break survives to the agent', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );

    await panel.composerInput.fill('first line');
    await panel.composerInput.press('Shift+Enter');
    await panel.composerInput.pressSequentially('second line');
    await panel.composerInput.press('Enter');

    await agent.inbox.expectMessage('second line');

    const stored = must<Message[]>(
        await agent.api.messages(ulid),
        'the stored message',
    ).find((message) => message.sender.type === 'visitor');

    expect(stored?.body).toBe('first line\nsecond line');

    // An empty or blank message is never sent.
    await panel.composerInput.fill('   ');
    await expect(panel.tid('composer-send')).toBeDisabled();
});

test('text is plain text: HTML-like markup, template syntax and 150-character unbroken tokens render literally, wrap inside the bubble and run nothing, in the panel and in the dashboard', async ({
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
    const token = 'W'.repeat(150);
    const url = `https://example.com/${'path-segment/'.repeat(12)}end`;
    const markup =
        '<img src=x onerror="window.__pwned=1"> <script>window.__pwned=1</script> "><svg onload=window.__pwned=1> {{7*7}} ${7*7} &lt;b&gt;bold&lt;/b&gt;';
    const fromVisitor = `V1 ${markup} ${token} ${url}`;
    const fromAgent = `A1 ${markup} ${token} ${url}`;

    await panel.send(fromVisitor);
    await agent.inbox.expectMessage('V1');
    await agent.inbox.send(fromAgent);
    await panel.expectMessage('A1', 'agent');

    const bubbles = [
        {
            where: 'the panel (visitor)',
            list: panel.messageList,
            bubbles: panel.messageList.locator(PEOPLE),
        },
        {
            where: 'the dashboard (agent)',
            list: agent.inbox.conversation.getByTestId('message-list'),
            bubbles: agent.inbox.conversation
                .getByTestId('message-list')
                .locator('[data-testid^="message-"][data-sender]'),
        },
    ];

    for (const { where, list, bubbles: items } of bubbles) {
        await expect(items).toHaveCount(2);

        for (const [index, prefix] of ['V1', 'A1'].entries()) {
            const bubble = items.nth(index);

            // Literal text, no elements created from it.
            await expect(bubble).toContainText(markup);
            await expect(bubble).toContainText(token);
            await expect(
                bubble.locator(
                    'img, script, iframe, b, svg:not([aria-hidden])',
                ),
                `${where}: ${prefix} creates no elements from its text`,
            ).toHaveCount(0);

            // The whole bubble stays inside the list: nothing is wider than its container and the list never scrolls sideways.
            const inside = await bubble.evaluate((node) => {
                const box = node.getBoundingClientRect();
                const container = node
                    .closest('[data-testid="message-list"]')!
                    .getBoundingClientRect();

                return (
                    box.left >= container.left - 1 &&
                    box.right <= container.right + 1
                );
            });

            expect(inside, `${where}: ${prefix} fits the list`).toBe(true);
        }

        expect(
            await list.evaluate(
                (node) => node.scrollWidth <= node.clientWidth + 1,
            ),
            `${where}: the message list has no horizontal scroll`,
        ).toBe(true);
    }

    // Nothing ran: not in the panel, the customer's page or the dashboard.
    expect(
        await panel.frame
            .locator('body')
            .evaluate(() => (window as any).__pwned),
    ).toBeUndefined();
    expect(
        await visitor.page.evaluate(() => (window as any).__pwned),
    ).toBeUndefined();
    expect(
        await agent.page.evaluate(() => (window as any).__pwned),
    ).toBeUndefined();

    // The stored text is exactly what was typed (nothing was escaped, stripped or "sanitised" on the way).
    const stored = must<Message[]>(
        await agent.api.messages(ulid),
        'the stored messages',
    );

    expect(bodies(stored, 'visitor')).toEqual([fromVisitor]);
    expect(bodies(stored, 'agent')).toEqual([fromAgent]);
});

test('URLs become safe links: rel noopener noreferrer nofollow, new tab, only http(s), never javascript: or credentials', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel } = await soloChat(actors, adminApi, instance, chats);
    const text =
        'Docs https://example.com/guide?a=1&b=2, also www.example.org/path. Bad: javascript:alert(1) and https://user:secret@evil.example/x';

    await panel.send(text);
    await agent.inbox.expectMessage('Docs');
    await agent.inbox.send(text);
    await panel.expectMessage('Docs', 'agent');

    const scopes = [
        panel.messageList.locator(PEOPLE),
        agent.inbox.conversation
            .getByTestId('message-list')
            .locator('[data-testid^="message-"][data-sender]'),
    ];

    for (const bubbles of scopes) {
        await expect(bubbles).toHaveCount(2);

        const links = bubbles.first().locator('a');

        await expect(links).toHaveCount(2);
        await expect(links.nth(0)).toHaveAttribute(
            'href',
            'https://example.com/guide?a=1&b=2',
        );
        await expect(links.nth(1)).toHaveAttribute(
            'href',
            'https://www.example.org/path',
        );

        for (const index of [0, 1]) {
            await expect(links.nth(index)).toHaveAttribute('target', '_blank');
            await expect(links.nth(index)).toHaveAttribute(
                'rel',
                'noopener noreferrer nofollow',
            );
        }

        // Neither the script URL nor the one with a password became a link.
        await expect(bubbles.first()).toContainText('javascript:alert(1)');
        await expect(bubbles.first()).toContainText('user:secret@evil.example');
        await expect(
            bubbles
                .first()
                .locator('a[href^="javascript:"], a[href*="secret"]'),
        ).toHaveCount(0);
    }
});

test('a long conversation: the panel follows new messages at the bottom, and when the visitor scrolled up a "New messages" pill counts them and jumps back', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const { agent, panel, ulid } = await soloChat(
        actors,
        adminApi,
        instance,
        chats,
    );

    // Forty replies through the API: the list grows well past its height.
    for (let index = 1; index <= 40; index += 1) {
        must(
            await agent.api.send(ulid, `Filler message number ${index}`),
            `agent message ${index}`,
        );
    }

    await panel.expectMessage('Filler message number 40', 'agent');

    const atBottom = () =>
        panel.messageList.evaluate(
            (node) =>
                node.scrollHeight - node.scrollTop - node.clientHeight < 8,
        );

    await expect
        .poll(atBottom, { message: 'the panel stays at the end' })
        .toBe(true);

    // Scrolled to the very top: new messages do not drag the visitor down; a pill says how many came.
    await panel.messageList.evaluate((node) => {
        node.scrollTop = 0;
    });
    await expect(panel.tid('new-messages-pill')).toHaveCount(0);

    for (let index = 1; index <= 3; index += 1) {
        must(
            await agent.api.send(ulid, `Late message ${index}`),
            `late message ${index}`,
        );
    }

    await expect(panel.tid('new-messages-pill')).toBeVisible();
    await expect(panel.tid('new-messages-pill')).toContainText('(3)');
    expect(await atBottom()).toBe(false);

    await panel.tid('new-messages-pill').click();
    await expect.poll(atBottom).toBe(true);
    await expect(panel.tid('new-messages-pill')).toHaveCount(0);

    // Back at the bottom the list keeps following.
    must(await agent.api.send(ulid, 'One more at the bottom'), 'last message');
    await panel.expectMessage('One more at the bottom', 'agent');
    await expect.poll(atBottom).toBe(true);
});

test('a send that fails shows why with Retry; the retry goes through once, in order, with no duplicate for the agent', async ({
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

    // The network drops the message request (the browser logs the failed fetch: expected here).
    visitor.watch.allow(/ERR_FAILED/);
    await visitor.page.route(
        /\/api\/v1\/public\/conversations\/[^/]+\/messages$/,
        (route) =>
            route.request().method() === 'POST'
                ? route.abort('failed')
                : route.continue(),
    );

    await panel.send('This one has to be retried.');

    const failed = panel.message('This one has to be retried', 'visitor');

    await expect(failed).toHaveAttribute('data-status', 'failed');
    await expect(failed.getByTestId('message-retry')).toBeVisible();
    await expect(
        panel.frame.getByText('Not sent. Tap to retry.'),
    ).toBeVisible();
    expect(
        bodies(
            must<Message[]>(
                await agent.api.messages(ulid),
                'nothing stored yet',
            ),
            'visitor',
        ),
    ).toEqual([]);

    // A message sent after it queues behind in the panel's order; the network comes back and the retry succeeds.
    await visitor.page.unroute(
        /\/api\/v1\/public\/conversations\/[^/]+\/messages$/,
    );
    await failed.getByTestId('message-retry').click();
    await expect(failed).not.toHaveAttribute('data-status', 'failed');
    await agent.inbox.expectMessage('has to be retried');

    await panel.send('And this one follows.');
    await agent.inbox.expectMessage('And this one follows');

    const stored = bodies(
        must<Message[]>(await agent.api.messages(ulid), 'the stored messages'),
        'visitor',
    );

    expect(stored).toEqual([
        'This one has to be retried.',
        'And this one follows.',
    ]);
    await expect(
        panel.messageList.locator('[data-status="failed"]'),
    ).toHaveCount(0);
    await expect(
        agent.inbox.conversation.getByText('This one has to be retried'),
    ).toHaveCount(1);
});
