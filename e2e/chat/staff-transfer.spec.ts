import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import { readConversationRow } from '../support/chat-db';
import { startChat } from '../support/staff-flow';
import { readConversation } from '../support/staff-ui';

/**
 * Transferring a chat from the agent's inbox. The dialog lists only colleagues who serve the chat's category (the ones who cannot take
 * it right now greyed out with the reason) and only the widget's other topics that somebody can answer; the visitor sees "connecting
 * you to another agent"; and when the answer is `409 no_agents` the reason shows inside the dialog and the agent keeps the chat.
 * Own world per test (`world.ts`): Ann has the chat, Ben (main + other, online), Dee (main, offline), Eli (main, online but full) and
 * Cy (other only, online).
 */
test.use({ scenario: 'p4-staff' });

const PLAN = {
    categories: ['main', 'other'],
    agents: {
        ann: ['main'],
        ben: ['main', 'other'],
        dee: ['main'],
        eli: ['main'],
        cy: ['other'],
    },
};

test('the transfer dialog lists the colleagues who serve the topic, greys out the unreachable with the reason, and offers the topics somebody can answer', async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = await startChat({ actors, adminApi, instance }, { plan: PLAN });
    const { world, agent: ann, ulid } = rig;

    // Eli takes one chat and may only hold one: "online, but full".
    must(
        await adminApi.patch(`/api/v1/agents/${world.agents.eli.id}`, {
            max_concurrent_chats: 1,
        }),
        'Eli gets a limit of one chat',
    );

    const eli = await actors.account(world.agents.eli, { presence: 'online' });
    const filler = await VisitorApi.start(instance, { key: world.widget.key });
    const fill = must<{ ulid: string }>(
        await filler.startChat({
            category: world.categories.main.slug,
            name: 'Filler Fred',
        }),
        'a second chat to fill Eli',
    );

    must(await eli.api.claim(fill.ulid), 'Eli takes it');

    await actors.account(world.agents.ben, { presence: 'online' });
    await actors.account(world.agents.cy, { presence: 'online' });
    await actors.account(world.agents.dee, { presence: 'offline' });

    await ann.inbox.tid('transfer-chat').click();

    const dialog = ann.inbox.tid('transfer-dialog');

    await expect(dialog).toBeVisible();

    // Agents of "main" only: Ben reachable, Dee greyed out (offline), Eli greyed out (at capacity); Cy does not serve "main" at all.
    const radio = (id: number) => ann.inbox.tid(`transfer-agent-${id}`);

    await expect(radio(world.agents.ben.id)).toBeEnabled();
    await expect(radio(world.agents.dee.id)).toBeDisabled();
    await expect(radio(world.agents.eli.id)).toBeDisabled();
    await expect(radio(world.agents.cy.id)).toHaveCount(0);
    await expect(dialog).toContainText('Offline');
    await expect(dialog).toContainText('At capacity');
    await expect(
        ann.inbox.tid(`transfer-load-${world.agents.eli.id}`),
    ).toContainText('1 of 1');
    await expect(dialog.locator('[data-unreachable="true"]')).toHaveCount(2);

    // The REST list the dialog was built from says the same.
    const targets = must<{
        agents: { id: number; reachable: boolean; status: string }[];
        categories: { slug: string }[];
    }>(await ann.api.transferTargets(ulid), 'transfer targets');

    expect(
        Object.fromEntries(
            targets.agents.map((target) => [target.id, target.reachable]),
        ),
    ).toEqual({
        [world.agents.ben.id]: true,
        [world.agents.dee.id]: false,
        [world.agents.eli.id]: false,
    });
    expect(targets.categories.map((category) => category.slug)).toEqual([
        world.categories.other.slug,
    ]);

    // The category tab offers "other" (Ben and Cy can answer it) and not the chat's own topic.
    await ann.inbox.tid('transfer-tab-category').click();

    const select = ann.inbox.tid('transfer-category');

    await expect(select.locator('option')).toHaveText([
        'Choose a category',
        world.categories.other.name,
    ]);
    await expect(ann.inbox.tid('transfer-confirm')).toBeDisabled();
    await select.selectOption(world.categories.other.slug);
    await expect(ann.inbox.tid('transfer-confirm')).toBeEnabled();

    await filler.dispose();
});

test('transferring to a colleague: Ann is out of the chat, the visitor is told, only that colleague is offered it and accepts', async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = await startChat({ actors, adminApi, instance }, { plan: PLAN });
    const { world, agent: ann, panel, ulid } = rig;
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });
    const eli = await actors.account(world.agents.eli, {
        presence: 'online',
        open: '/inbox',
    });

    await ann.inbox.tid('transfer-chat').click();
    await ann.inbox.tid(`transfer-agent-${world.agents.ben.id}`).click();
    await ann.inbox.tid('transfer-confirm').click();

    // Ann is sent back to her list; the chat is not hers any more.
    await expect(ann.page).toHaveURL(/\/inbox$/, { timeout: 20_000 });
    await expect(ann.inbox.chatRow(ulid)).toHaveCount(0);
    expect((await ann.api.conversation(ulid)).status).toBe(403);

    // The visitor is back in the queue, told why.
    await panel.expectState('queued');
    await expect(panel.root).toContainText('Connecting you to another agent');

    // Only Ben is offered it (a direct transfer is not widened to the colleagues who serve the topic).
    await ben.inbox.expectOffer(ulid);
    await eli.inbox.expectNoOffer(ulid);
    await ann.inbox.expectNoOffer(ulid);

    await ben.inbox.accept(ulid);
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: world.agents.ben.name }),
    ).toBeVisible();

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation.assigned_agent_id).toBe(world.agents.ben.id);
    expect(row.events.map((event) => event.type)).toContain('transferred');
});

test("transferring to a category sends the chat through that topic's routing and the visitor lands with whoever accepts", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = await startChat({ actors, adminApi, instance }, { plan: PLAN });
    const { world, agent: ann, panel, ulid } = rig;
    const cy = await actors.account(world.agents.cy, {
        presence: 'online',
        open: '/inbox',
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });
    const eli = await actors.account(world.agents.eli, {
        presence: 'online',
        open: '/inbox',
    });

    await ann.inbox.tid('transfer-chat').click();
    await ann.inbox.tid('transfer-tab-category').click();
    await ann.inbox
        .tid('transfer-category')
        .selectOption(world.categories.other.slug);
    await ann.inbox.tid('transfer-confirm').click();
    await expect(ann.page).toHaveURL(/\/inbox$/, { timeout: 20_000 });

    // The agents of "other" (Ben and Cy) are offered the chat; Eli, who does not serve it, and Ann, who let go, are not.
    await cy.inbox.expectOffer(ulid);
    await ben.inbox.expectOffer(ulid);
    await eli.inbox.expectNoOffer(ulid);
    await ann.inbox.expectNoOffer(ulid);
    await panel.expectState('queued');

    await cy.inbox.accept(ulid);
    await ben.inbox.expectNoOffer(ulid);
    await panel.expectState('active');

    const taken = await readConversation(cy, ulid);

    expect(taken.assignedAgent?.id).toBe(world.agents.cy.id);
    expect(taken.category?.slug).toBe(world.categories.other.slug);
});

test('when nobody can take it any more the dialog says so and Ann keeps the chat', async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = await startChat({ actors, adminApi, instance }, { plan: PLAN });
    const { world, agent: ann, ulid } = rig;
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const cy = await actors.account(world.agents.cy, { presence: 'online' });

    // The dialog is open with Ben reachable ...
    await ann.inbox.tid('transfer-chat').click();
    await expect(
        ann.inbox.tid(`transfer-agent-${world.agents.ben.id}`),
    ).toBeEnabled();

    // ... and he goes offline before Ann presses the button: the server refuses and says why, inside the dialog.
    await ben.setPresence('offline');
    await ann.inbox.tid(`transfer-agent-${world.agents.ben.id}`).click();
    await ann.inbox.tid('transfer-confirm').click();

    const error = ann.inbox.tid('transfer-error');

    await expect(error).toBeVisible();
    await expect(error).toContainText('Nobody is available');
    await expect(ann.inbox.tid('transfer-dialog')).toBeVisible();

    // The same for a topic nobody can answer any more (both agents of "other" are gone).
    await cy.setPresence('offline');
    await ann.inbox.tid('transfer-tab-category').click();
    await ann.inbox
        .tid('transfer-category')
        .selectOption(world.categories.other.slug);
    await ann.inbox.tid('transfer-confirm').click();
    await expect(error).toContainText('Nobody is available');

    // The REST answer is the documented one, and the chat is still Ann's and still active.
    const refused = await ann.api.transfer(ulid, {
        category: world.categories.other.slug,
    });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');
    expect(refused.error?.details).toMatchObject({
        target: 'category',
        reason: 'no_reachable_agent',
    });

    const still = await expectEventually(
        () => readConversation(ann, ulid),
        (conversation) => conversation.status === 'active',
    );

    expect(still.assignedAgent?.id).toBe(world.agents.ann.id);
});
