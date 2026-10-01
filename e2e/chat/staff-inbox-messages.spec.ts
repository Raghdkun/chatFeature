import type { StaffActor } from '../support/actors';
import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { readMessages, rows, bubble, png } from '../support/staff-ui';
import { shiftConversationDays } from '../support/staff-db';
import { startChat } from '../support/staff-flow';

/**
 * The open conversation in the agent's inbox, with a real visitor panel on the other side: grouping and date separators, delivered /
 * seen ticks as the visitor reads, the typing indicator in both directions, the image lightbox and the composer keys. Every test has
 * its own world (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

/** The messages people wrote (the system lines "<agent> joined the chat." are left out). */
async function writtenMessages(agent: StaffActor, ulid: string) {
    return (await readMessages(agent, ulid)).filter(
        (message) => message.sender.type !== 'system',
    );
}

test('consecutive messages are grouped, a day separator splits old from new, and the ticks follow the visitor reading', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel, ulid, visitorName } = await startChat({
        actors,
        adminApi,
        instance,
    });

    await panel.send('Hello, I have a question.');
    await panel.send('It is about my invoice.');
    await agent.inbox.expectMessage('about my invoice');

    // Two visitor messages in a row form one group: the name once, the time once (under the last one).
    const visitorRows = agent.inbox.conversation.locator(
        'li[data-testid^="message-"][data-sender="visitor"]',
    );

    await expect(visitorRows).toHaveCount(2);
    await expect(
        agent.inbox.conversation
            .getByTestId('message-list')
            .getByText(visitorName, { exact: true }),
    ).toHaveCount(1);
    await expect(visitorRows.first().locator('time')).toHaveCount(0);
    await expect(visitorRows.last().locator('time')).toHaveCount(1);

    // The agent answers twice; the visitor's panel is open and in view, so the ticks climb to "seen".
    await agent.inbox.send('Hi, happy to help.');
    await agent.inbox.send('Which invoice is it?');
    await panel.expectMessage('Which invoice', 'agent');

    const first = bubble(agent, 'Hi, happy to help.', 'agent');
    const second = bubble(agent, 'Which invoice is it?', 'agent');

    await expect(first).toHaveAttribute('data-status', 'seen');
    await expect(second).toHaveAttribute('data-status', 'seen');
    await expect(second.getByTestId(/^message-status-/)).toContainText('Seen');

    // The stored receipts agree.
    const stored = await expectEventually(
        () => readMessages(agent, ulid),
        (messages) =>
            messages
                .filter((message) => message.sender.type === 'agent')
                .every((message) => message.seenAt !== null),
        { message: 'the visitor panel marked both agent messages seen' },
    );

    // Seq 1 is the system line "<agent> joined the chat." written when the chat was accepted.
    expect(stored.map((message) => message.sender.type)).toEqual([
        'system',
        'visitor',
        'visitor',
        'agent',
        'agent',
    ]);
    expect(stored.map((message) => message.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(
        stored
            .filter((message) => message.sender.type === 'agent')
            .every((message) => message.deliveredAt !== null),
    ).toBe(true);

    // Everything so far happened today: one separator, "Today". Move the visitor's two messages two days back and the transcript
    // reads yesterday's-and-before first, then today's.
    await expect(
        agent.inbox.conversation
            .getByTestId('message-list')
            .locator('li:not([data-testid])'),
    ).toHaveCount(1);

    await shiftConversationDays(instance, ulid, 2, { upToSeq: 3 });
    await agent.inbox.goto(ulid);

    const separators = agent.inbox.conversation
        .getByTestId('message-list')
        .locator('li:not([data-testid])');

    await expect(separators).toHaveCount(2);
    await expect(separators.first()).not.toContainText('Today');
    await expect(separators.last()).toContainText('Today');
    await expect(rows(agent)).toHaveCount(5);
});

test('delivered, then seen: a visitor with the panel closed has received the message but not read it', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel, ulid } = await startChat({
        actors,
        adminApi,
        instance,
    });

    // The visitor minimises the chat (the panel's own X: on a phone the full-screen panel covers the launcher), the agent writes.
    const frame = panel.page.locator('pne-chat-widget .panel');

    await panel.frame.getByRole('button', { name: 'Close chat' }).click();
    await expect(frame).toHaveAttribute('data-open', 'false');
    await agent.inbox.send('Are you still there?');

    // The visitor's browser received it (a delivery receipt) but nobody looked: stored as delivered, not seen.
    const stored = await expectEventually(
        () => readMessages(agent, ulid),
        (messages) =>
            messages.some(
                (message) =>
                    message.body === 'Are you still there?' &&
                    message.deliveredAt !== null,
            ),
        { message: 'the visitor panel confirmed delivery while closed' },
    );

    expect(
        stored.find((message) => message.body === 'Are you still there?')
            ?.seenAt,
    ).toBeNull();

    // A reload shows the stored state: two ticks, not yet the "seen" colour.
    await agent.inbox.goto(ulid);

    const sent = bubble(agent, 'Are you still there?', 'agent');

    await expect(sent).toHaveAttribute('data-status', 'delivered');
    await expect(sent.getByTestId(/^message-status-/)).toContainText(
        'Delivered',
    );

    // Opening the panel again shows the message and marks it seen, live.
    await panel.launcher.click();
    await expect(frame).toHaveAttribute('data-open', 'true');
    await panel.expectMessage('Are you still there?', 'agent');
    await expect(sent).toHaveAttribute('data-status', 'seen');
});

// Delivery receipts are broadcast (`message.delivered`): an open conversation ticks sent -> delivered live, without a reload, while the
// visitor's panel is closed (the panel confirms delivery but nobody has read the message, so it never reaches "seen").
test('the agent sees "delivered" live, without a reload, when the visitor panel is closed', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel } = await startChat({ actors, adminApi, instance });

    await panel.frame.getByRole('button', { name: 'Close chat' }).click();
    await expect(panel.page.locator('pne-chat-widget .panel')).toHaveAttribute(
        'data-open',
        'false',
    );
    await agent.inbox.send('Are you still there?');

    const sent = bubble(agent, 'Are you still there?', 'agent');

    await expect(sent).toHaveAttribute('data-status', 'delivered');
    await expect(sent.getByTestId(/^message-status-/)).toContainText(
        'Delivered',
    );

    // Opening the panel marks it read, live: delivered -> seen.
    await panel.launcher.click();
    await expect(sent).toHaveAttribute('data-status', 'seen');
});

test('typing is shown in both directions and goes away by itself', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel } = await startChat({ actors, adminApi, instance });
    const agentSees = agent.inbox.tid('typing-indicator');
    const visitorSees = panel.tid('typing-indicator');

    await expect(agentSees).toHaveCount(0);

    // The visitor types: the agent sees the three dots, which expire a few seconds after the last key. The whisper repeats every 3 s
    // while the visitor keeps typing, so a first one that left before the agent's browser had subscribed to the chat (the page is
    // there, but the channel authorisation is still on its way: the visitor panel turns active at the claim, before the agent's page
    // has even loaded) is made up for by the next keystrokes.
    await expect(async () => {
        await panel.composerInput.pressSequentially('I think I was charged');
        await expect(agentSees).toBeVisible({ timeout: 3_500 });
    }).toPass({ timeout: 25_000 });
    await expect(agentSees).toBeHidden({ timeout: 15_000 });

    // The agent types: the visitor sees it.
    await agent.inbox.composerInput.pressSequentially('Let me check that');
    await expect(visitorSees).toBeVisible();

    // Sending the message clears the indicator at once (the agent stopped typing).
    await agent.inbox.composerInput.press('Enter');
    await expect(visitorSees).toBeHidden({ timeout: 15_000 });
    await panel.expectMessage('Let me check that', 'agent');
});

test('Enter sends, Shift+Enter breaks the line, an empty message is never sent', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel, ulid } = await startChat({
        actors,
        adminApi,
        instance,
    });
    const input = agent.inbox.composerInput;
    const send = agent.inbox.tid('composer-send');

    // Nothing typed (or only blanks): the button is disabled and Enter does nothing.
    await expect(send).toBeDisabled();
    await input.fill('   ');
    await expect(send).toBeDisabled();
    await input.press('Enter');
    expect(await writtenMessages(agent, ulid)).toHaveLength(0);

    // Shift+Enter keeps writing on a new line, Enter sends the whole thing.
    await input.fill('First line');
    await input.press('Shift+Enter');
    await input.pressSequentially('Second line');
    await expect(input).toHaveValue('First line\nSecond line');
    await input.press('Enter');
    await expect(input).toHaveValue('');
    await panel.expectMessage(/First line\s+Second line/, 'agent');

    const stored = await writtenMessages(agent, ulid);

    expect(stored).toHaveLength(1);
    expect(stored[0].body).toBe('First line\nSecond line');
});

test('an image the visitor sends opens in the lightbox', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel } = await startChat({ actors, adminApi, instance });

    await panel.tid('composer-file').setInputFiles({
        name: 'receipt.png',
        mimeType: 'image/png',
        buffer: png(64, 48),
    });
    await expect(panel.tid('composer-attachment')).toHaveCount(1);
    await expect(panel.tid('composer-send')).toBeEnabled();
    await panel.tid('composer-send').click();

    const thumbnail = agent.inbox.conversation.locator(
        '[data-testid^="attachment-"]',
    );

    await expect(thumbnail).toHaveCount(1);
    await expect(thumbnail.locator('img')).toBeVisible();

    await thumbnail.click();

    const lightbox = agent.inbox.tid('lightbox');

    await expect(lightbox).toBeVisible();
    await expect(lightbox.locator('img')).toBeVisible();

    await agent.page.keyboard.press('Escape');
    await expect(lightbox).toBeHidden();
});
