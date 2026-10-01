import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { readMessages } from '../support/staff-ui';
import { setSetting } from '../support/staff-db';
import { png } from '../support/staff-ui';
import { startChat } from '../support/staff-flow';

/**
 * The agent's composer and the end of a chat: the reason shown for an oversized message, the attachment prechecks (type, size) and the
 * upload -> remove -> send path, the end-chat confirmation, and "Copy transcript". A real visitor panel sits on the other side. Own
 * world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

test('an oversized message is not sent and says why; the agent can discard it', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid } = await startChat({ actors, adminApi, instance });

    // The server's limit is a setting (default 4000, the composer's own cap): lower it for this test, and put it back.
    await setSetting(instance, 'chat.max_message_length', 100);

    try {
        // The server re-reads settings within 2 s: wait until it enforces the new limit.
        await expectEventually(
            () => agent.api.send(ulid, 'x'.repeat(150)),
            (answer) => answer.status === 422,
            { message: 'the server enforces the lowered message limit' },
        );

        const input = agent.inbox.composerInput;

        await input.fill(`${'This sentence is far too long. '.repeat(5)}end`);
        await input.press('Enter');

        const failure =
            agent.inbox.conversation.getByTestId(/^message-failure-/);

        await expect(failure).toBeVisible();
        await expect(failure).toHaveText('Not sent: the message is too long.');
        await expect(
            agent.inbox.conversation.getByTestId(/^message-retry-/),
            'a message that can never fit has no Retry',
        ).toHaveCount(0);
        await expect(
            agent.inbox.conversation.locator('li[data-status="failed"]'),
        ).toHaveCount(1);

        // Discard removes it from the list; nothing was stored.
        await agent.inbox.conversation.getByTestId(/^message-discard-/).click();
        await expect(failure).toHaveCount(0);
        await expect(
            agent.inbox.conversation.locator('li[data-status="failed"]'),
        ).toHaveCount(0);

        const stored = (await readMessages(agent, ulid)).filter(
            (message) => message.sender.type === 'agent',
        );

        expect(stored).toEqual([]);

        // A message that fits goes through while the limit is low.
        await agent.inbox.send('Short and sweet.');
        await agent.inbox.expectMessage('Short and sweet.');
    } finally {
        await setSetting(instance, 'chat.max_message_length', 4000);
    }
});

test('attachments: the wrong type and an oversized file are refused before any upload, a good image uploads, can be removed, and is sent', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel, ulid } = await startChat({
        actors,
        adminApi,
        instance,
    });
    const file = agent.inbox.tid('composer-file');
    const chips = agent.inbox.conversation.locator(
        '[data-testid^="composer-attachment-"]:not([data-testid^="composer-attachment-remove-"])',
    );
    const uploads: string[] = [];

    agent.page.on('request', (request) => {
        if (request.url().endsWith('/attachments')) {
            uploads.push(request.url());
        }
    });

    // A text file: refused by the type check, no request leaves the browser.
    await file.setInputFiles({
        name: 'notes.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('just text'),
    });
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute('data-status', 'error');
    await expect(chips.first()).toContainText(
        'Only JPEG, PNG, WebP or GIF images.',
    );
    await expect(agent.inbox.tid('composer-send')).toBeDisabled();

    // An image above 5 MB: refused by the size check.
    await file.setInputFiles({
        name: 'huge.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(5 * 1024 * 1024 + 1024, 1),
    });
    await expect(chips).toHaveCount(2);
    await expect(chips.nth(1)).toHaveAttribute('data-status', 'error');
    await expect(chips.nth(1)).toContainText('Larger than 5 MB.');
    expect(uploads, 'nothing was uploaded for the refused files').toEqual([]);

    // Both refusals can be removed.
    await agent.inbox
        .tid(/^composer-attachment-remove-/)
        .first()
        .click();
    await agent.inbox
        .tid(/^composer-attachment-remove-/)
        .first()
        .click();
    await expect(chips).toHaveCount(0);

    // A good image uploads (a chip that says "Ready"), and removing it before sending takes it back.
    await file.setInputFiles({
        name: 'first.png',
        mimeType: 'image/png',
        buffer: png(40, 30),
    });
    await expect(chips).toHaveCount(1);
    await expect(chips.first()).toHaveAttribute('data-status', 'ready');
    await expect(chips.first()).toContainText('Ready');
    expect(uploads).toHaveLength(1);
    await agent.inbox
        .tid(/^composer-attachment-remove-/)
        .first()
        .click();
    await expect(chips).toHaveCount(0);
    await expect(agent.inbox.tid('composer-send')).toBeDisabled();

    // Upload again, add a caption, send: the agent sees the picture in the list, the visitor sees it in the panel.
    await file.setInputFiles({
        name: 'second.png',
        mimeType: 'image/png',
        buffer: png(60, 40, [220, 38, 38]),
    });
    await expect(chips.first()).toHaveAttribute('data-status', 'ready');
    await agent.inbox.composerInput.fill('Here is the diagram.');
    await agent.inbox.tid('composer-send').click();

    await expect(
        agent.inbox.conversation.locator('[data-testid^="attachment-"] img'),
    ).toBeVisible();
    await expect(chips).toHaveCount(0);
    await expect(panel.tid('message-image')).toBeVisible();
    await panel.expectMessage('Here is the diagram.', 'agent');

    const stored = (await readMessages(agent, ulid)).find(
        (message) => message.sender.type === 'agent',
    );

    expect(stored?.body).toBe('Here is the diagram.');
});

test('ending a chat asks first: Cancel keeps it, End chat closes the composer and sends the visitor to the rating', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel, ulid } = await startChat({
        actors,
        adminApi,
        instance,
    });

    await panel.send('Thanks, that solved it.');
    await agent.inbox.expectMessage('that solved it');

    // The dialog says what ending does; Cancel changes nothing.
    await agent.inbox.tid('end-chat').click();

    const dialog = agent.inbox.tid('end-chat-dialog');

    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('End this chat?');
    await expect(dialog).toContainText('asked to rate it');
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toHaveCount(0);
    await expect(agent.inbox.conversation).toHaveAttribute(
        'data-status',
        'active',
    );
    await panel.expectState('active');

    // Confirm: the chat is ended, the agent can no longer write, transfer or end it, the visitor is asked to rate.
    await agent.inbox.endChat();
    await expect(agent.inbox.conversation).toHaveAttribute(
        'data-status',
        'ended',
    );
    await expect(agent.inbox.tid('composer-disabled')).toBeVisible();
    await expect(agent.inbox.tid('composer-input')).toHaveCount(0);
    await expect(agent.inbox.tid('end-chat')).toHaveCount(0);
    await expect(agent.inbox.tid('transfer-chat')).toHaveCount(0);
    await panel.expectState('ended');

    expect((await agent.api.send(ulid, 'one more thing')).error?.code).toBe(
        'conversation_not_active',
    );
    expect((await agent.api.end(ulid)).error?.code).toBe(
        'conversation_not_active',
    );

    // The rating closes it; the agent's view follows without a reload.
    await panel.rate(3, 'Fine.');
    await panel.expectState('closed');
    await expect(agent.inbox.conversation).toHaveAttribute(
        'data-status',
        'closed',
    );
});

test('"Copy transcript" puts the conversation on the clipboard', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, panel } = await startChat({ actors, adminApi, instance });

    await agent.context.grantPermissions(
        ['clipboard-read', 'clipboard-write'],
        {
            origin: instance.url,
        },
    );

    await panel.send('Where can I download my invoice?');
    await agent.inbox.expectMessage('download my invoice');
    await agent.inbox.send('In your account, under Billing.');
    await panel.expectMessage('under Billing', 'agent');

    await agent.inbox.tid('copy-transcript').click();
    await expect(agent.page.getByText('Transcript copied')).toBeVisible();

    const text = await agent.page.evaluate(() =>
        navigator.clipboard.readText(),
    );
    const lines = text.split('\n');

    // One line per message: `[time] who: text`; the system line of the chat opening is marked with a star.
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/^\[.+\] \*: .*joined the chat/);
    expect(lines[1]).toMatch(
        /^\[.+\] Vera Visitor: Where can I download my invoice\?$/,
    );
    expect(lines[2]).toMatch(
        new RegExp(
            `^\\[.+\\] ${agent.user.name}: In your account, under Billing\\.$`,
        ),
    );
});
