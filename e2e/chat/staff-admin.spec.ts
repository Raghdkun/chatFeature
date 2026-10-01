import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must } from '../support/chat-api';
import { readConversationRow } from '../support/chat-db';
import { startChat } from '../support/staff-flow';
import { readConversation, showList } from '../support/staff-ui';

/**
 * What the administrator sees of everybody's chats, live: another agent's chat in "My chats" marked as theirs, a read-only look inside
 * it that follows the conversation over the websocket, and the power to close a chat that is still waiting (the visitor and the agents
 * see it end at once). The administrator is the seeded one (`actors.staff('admin')`); everything else is the test's own world.
 */
test.use({ scenario: 'p4-staff' });

test("the administrator sees an agent's chat appear, opens it as a watcher and follows it live", async ({
    actors,
    adminApi,
    instance,
}) => {
    const admin = await actors.staff('admin', { open: '/inbox' });
    const { agent, panel, ulid, world } = await startChat({
        actors,
        adminApi,
        instance,
    });

    // The chat shows up in the administrator's list without a reload, marked as the agent's.
    await showList(admin);
    await expect(admin.inbox.chatRow(ulid)).toBeVisible();
    await expect(admin.inbox.chatRow(ulid)).toContainText(
        `With ${world.agents.ann.name}`,
    );

    // Opening it: a watcher's notice with the agent's name, the transcript, no way to take the chat over.
    await admin.inbox.chatRow(ulid).click();
    await expect(admin.inbox.conversation).toBeVisible();
    await expect(admin.inbox.tid('conversation-monitoring')).toContainText(
        world.agents.ann.name,
    );
    await expect(admin.inbox.tid('conversation-claim')).toHaveCount(0);

    // What is said afterwards arrives in the watcher's view too (the conversation channel is open to administrators).
    await panel.send('Can the manager see this?');
    await admin.inbox.expectMessage('manager see this');
    await agent.inbox.send('Yes, a colleague is watching.');
    await admin.inbox.expectMessage('colleague is watching');

    // The administrator's presence in the chat does not mark anything read for the agent (receipts are the assigned agent's).
    const stored = await expectEventually(
        () => readConversation(agent, ulid),
        (conversation) => conversation.unseenByAgent === 0,
        { message: 'the assigned agent read the visitor message' },
    );

    expect(stored.assignedAgent?.id).toBe(world.agents.ann.id);
});

test('an administrator closes a chat nobody picked up: the visitor and every agent see it end', async ({
    actors,
    adminApi,
    instance,
}) => {
    const admin = await actors.staff('admin');
    const { agent, panel, ulid } = await startChat(
        { actors, adminApi, instance },
        { accept: false },
    );

    // Dismissed by an administrator (an agent may not: nobody owns a queued chat).
    expect((await agent.api.close(ulid)).status).toBe(403);
    must(await admin.api.close(ulid), 'the administrator closes the chat');

    await agent.inbox.expectNoOffer(ulid);
    await panel.expectState(['closed', 'offline']);

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'system',
    });

    // Nobody can take it afterwards.
    expect((await agent.api.claim(ulid)).status).toBe(409);
});
