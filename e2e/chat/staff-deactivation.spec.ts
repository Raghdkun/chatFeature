import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must } from '../support/chat-api';
import { readConversationRow } from '../support/chat-db';
import { createAdminAgent } from '../support/staff-db';
import { startChat } from '../support/staff-flow';
import { PASSWORD } from '../support/users';
import { createWorld } from '../support/world';
import { unique } from '../support/helpers';

/**
 * An agent is taken away from their chats while they are in them (mode 1): an administrator deactivates Alice in the dashboard, or
 * switches off "takes chats" for an administrator who was serving. The open inbox of the person is signed out (the `session.revoked`
 * event, then a REST 401), the chat goes back to the queue, a colleague is offered it, and the visitor is told that they are being
 * connected to another agent. Own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

test('an administrator deactivates an agent in the middle of a chat: her inbox is signed out, the chat is requeued to Bob, the visitor is told', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], bob: ['main'] },
    });
    const bob = await actors.account(world.agents.bob, {
        presence: 'online',
        open: '/inbox',
    });
    const {
        agent: ann,
        panel,
        ulid,
    } = await startChat(
        { actors, adminApi, instance },
        { world, agent: 'ann' },
    );

    // The chat is under way: a message each way.
    await panel.send('Can you help me with my order?');
    await ann.inbox.expectMessage('help me with my order');
    await ann.inbox.send('Of course, one moment.');
    await panel.expectMessage('one moment', 'agent');

    // An administrator switches Ann off in the Agents page of the dashboard.
    const admin = await actors.staff('admin');

    await admin.page.goto('/agents');

    const toggle = admin.page.getByTestId(
        `agent-active-${world.agents.ann.id}`,
    );

    await expect(toggle).toBeChecked();
    await toggle.click();
    await expect(toggle).not.toBeChecked();

    // Ann's open inbox is signed out: the event makes the page ask the server, which says 401, and the page leaves for the login screen.
    await expect(ann.page).toHaveURL(/\/login/, { timeout: 20_000 });
    expect((await ann.api.presence()).status).toBe(401);
    expect((await ann.api.conversation(ulid)).status).toBe(401);

    // The chat is back in the queue with nobody assigned; Bob is offered it, Ann (inactive) is not.
    const requeued = await expectEventually(
        async () =>
            must<{ status: string; assignedAgent: unknown }>(
                await adminApi.get(`/api/v1/conversations/${ulid}`),
                'the administrator reads the chat',
            ),
        (conversation) => conversation.status === 'queued',
        { message: 'the chat of the deactivated agent is requeued' },
    );

    expect(requeued.assignedAgent).toBeNull();

    await bob.inbox.expectOffer(ulid);

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation.assigned_agent_id).toBeNull();
    expect(row.events.map((event) => event.type)).toContain('requeued');
    // Ann's own row is the one that keeps her from being offered the chat again; Bob's offer is open.
    const response = (id: number) =>
        row.offers.find((offer) => offer.user_id === id)?.response ?? null;

    expect(response(world.agents.ann.id)).toBe('dismissed');
    expect(
        row.offers.some((offer) => offer.user_id === world.agents.bob.id),
    ).toBe(true);
    expect(response(world.agents.bob.id)).toBeNull();

    // The visitor's panel goes back to waiting, and says why.
    await panel.expectState('queued');
    await expect(panel.root).toContainText('Connecting you to another agent');

    // Bob takes it: the visitor is active again, the history is still there, and the agent is Bob.
    await bob.inbox.accept(ulid);
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: world.agents.bob.name }),
    ).toBeVisible();
    await panel.expectMessage('help me with my order', 'visitor');
    await panel.expectMessage('one moment', 'agent');
    await bob.inbox.expectMessage('help me with my order');

    // A deactivated account cannot sign in again.
    const again = await adminApi.get('/api/v1/agents');
    const staff = (again.data as { id: number; is_active: boolean }[]).find(
        (member) => member.id === world.agents.ann.id,
    );

    expect(staff?.is_active).toBe(false);
});

test('an administrator who stops taking chats hands them back to the queue but stays signed in', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { bob: ['main'] },
    });
    const account = {
        name: unique('Dana Admin'),
        email: `dana.${Math.random().toString(36).slice(2, 8)}@example.test`,
        password: PASSWORD,
    };
    const danaId = await createAdminAgent(instance, account);
    const {
        agent: bob,
        panel,
        ulid,
    } = await startChat(
        { actors, adminApi, instance },
        { world, agent: 'bob', accept: false },
    );
    const dana = await actors.account(account, {
        presence: 'online',
        open: '/inbox',
    });

    // Dana (an administrator who takes chats) accepts the chat before Bob does.
    must(await dana.api.claim(ulid), 'Dana claims the chat');
    await panel.expectState('active');
    await bob.inbox.expectNoOffer(ulid);

    // Her "takes chats" switch goes off in the Agents page.
    const admin = await actors.staff('admin');

    await admin.page.goto('/agents');

    const takes = admin.page.getByTestId(`agent-role-${danaId}`);

    await expect(takes).toBeChecked();
    await takes.click();
    await expect(takes).not.toBeChecked();

    // The chat is back in the queue, Bob is offered it, and the visitor is told.
    await expectEventually(
        async () =>
            must<{ status: string }>(
                await adminApi.get(`/api/v1/conversations/${ulid}`),
                'read',
            ).status,
        (status) => status === 'queued',
        { message: 'the chat is requeued when the agent role is removed' },
    );
    await bob.inbox.expectOffer(ulid);
    await panel.expectState('queued');
    await expect(panel.root).toContainText('Connecting you to another agent');

    // She is still an administrator: her session lives (no sign-out) and the API answers.
    await expect(dana.page).not.toHaveURL(/\/login/);
    expect((await dana.api.presence()).status).toBe(200);
    expect((await dana.api.claim(ulid)).status).toBe(403);

    await bob.inbox.accept(ulid);
    await panel.expectState('active');
});
