import { must } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import {
    acceptAs,
    createTeam,
    expect,
    startActiveChat,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { expectEventually } from '../support/wait';

/**
 * Who is offered a chat and who gets it, and what the visitor sees when a chat moves between agents. Every test builds an isolated
 * team with `createTeam()` (own category, own agents, own widget with the seeded routing: `online` agents at once, `away` agents
 * after 20 s, queue timeout 45 s), so presence and capacity can be changed freely while other files use the seeded Alice and Bob.
 * Time moves with `ageConversation({ by: 25 })` + `runSweep('chat:offer-waves')`.
 */
test.use({ scenario: 'p4-chat' });
// Several browsers per test, and the machine also runs other suites: the per-test budget is generous (a test takes 3-12 s on a quiet machine).
test.setTimeout(120_000);

test('only an away agent exists: nobody is offered the chat until the second routing wave is due', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Aya'] });
    const aya = await actors.staffLogin(team.agents[0], {
        presence: 'away',
        open: '/inbox',
        keepAlive: true,
    });
    const { panel, ulid } = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Wanda Wave',
    });

    // Wave one is for `online` agents: Aya (away) has nothing in her queue and the server never offered her the chat.
    expect(
        must<unknown[]>(
            await aya.api.queue(),
            'the away agent reads the queue',
        ),
    ).toEqual([]);
    await aya.inbox.expectNoOffer(ulid);
    expect((await readConversationRow(instance, ulid)).offers).toEqual([]);

    // The delayed job would run 20 s after the chat was queued: move time and run the sweep that makes the wave.
    await ageConversation(instance, ulid, { by: 25 });
    await runSweep(instance, 'chat:offer-waves');

    await aya.inbox.expectOffer(ulid);
    expect((await readConversationRow(instance, ulid)).offers).toMatchObject([
        { user_id: team.agents[0].id, wave: 2 },
    ]);

    await aya.inbox.accept(ulid);
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: team.agents[0].name }),
    ).toBeVisible();
});

test('an online agent is offered at once and an away colleague only in the second wave; the colleague who accepts wins and the online agent sees it taken', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Otis', 'Aya'],
    });
    const [otis, aya] = await Promise.all([
        actors.staffLogin(team.agents[0], {
            presence: 'online',
            open: '/inbox',
        }),
        actors.staffLogin(team.agents[1], {
            presence: 'away',
            open: '/inbox',
            keepAlive: true,
        }),
    ]);
    const { panel, ulid } = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Wes Waves',
    });

    await otis.inbox.expectOffer(ulid);
    await aya.inbox.expectNoOffer(ulid);

    await ageConversation(instance, ulid, { by: 25 });
    await runSweep(instance, 'chat:offer-waves');
    await aya.inbox.expectOffer(ulid);

    // Both are offered now; Aya is first to accept: Otis' card turns into "taken" and the visitor meets Aya.
    await aya.inbox.accept(ulid);
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: team.agents[1].name }),
    ).toBeVisible();
    await expect(otis.inbox.offer(ulid)).toHaveCount(0);

    const row = await readConversationRow(instance, ulid);

    expect(
        row.offers.map((offer) => [offer.user_id, offer.response, offer.wave]),
    ).toEqual([
        [team.agents[0].id, 'taken', 1],
        [team.agents[1].id, 'accepted', 2],
    ]);

    // Otis' own claim now is refused, naming the winner.
    const late = await otis.api.claim(ulid);

    expect(late.status).toBe(409);
    expect(late.error?.code).toBe('already_claimed');
});

test('two agents accept the same chat at the same time: exactly one wins, the other sees it taken, and the visitor meets the winner', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Ann', 'Ben'],
    });
    const [ann, ben] = await Promise.all([
        actors.staffLogin(team.agents[0], {
            presence: 'online',
            open: '/inbox',
        }),
        actors.staffLogin(team.agents[1], {
            presence: 'online',
            open: '/inbox',
        }),
    ]);
    const { panel, ulid } = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Cleo Contest',
    });

    await ann.inbox.expectOffer(ulid);
    await ben.inbox.expectOffer(ulid);

    // Both press Accept in the same instant (two browsers, two sessions).
    const responses = Promise.all(
        [ann, ben].map((agent) =>
            agent.page.waitForResponse(
                (response) =>
                    response.url().includes(`/conversations/${ulid}/claim`) &&
                    response.request().method() === 'POST',
            ),
        ),
    );

    await Promise.all(
        [ann, ben].map((agent) =>
            agent.inbox.tid(`offer-accept-${ulid}`).click(),
        ),
    );

    const statuses = (await responses).map((response) => response.status());

    expect(statuses.sort((a, b) => a - b)).toEqual([200, 409]);

    const conversation = must<{ assignedAgent: { id: number; name: string } }>(
        await adminApi.get(`/api/v1/conversations/${ulid}`),
        'the administrator reads the chat',
    );
    const [winner, loser] =
        conversation.assignedAgent.id === team.agents[0].id
            ? [ann, ben]
            : [ben, ann];

    // The winner is in the chat, the loser was told who got it and the card leaves.
    await expect(winner.page).toHaveURL(new RegExp(`/inbox/${ulid}$`));
    await expect(winner.inbox.conversation).toBeVisible();
    await expect(
        loser.page.getByText(`Taken by ${winner.user.name}`).first(),
    ).toBeVisible();
    await expect(loser.inbox.offer(ulid)).toHaveCount(0);
    await expect(loser.page).not.toHaveURL(new RegExp(`/inbox/${ulid}$`));

    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: winner.user.name }),
    ).toBeVisible();

    const row = await readConversationRow(instance, ulid);

    expect(
        row.offers
            .map((offer) => String(offer.response))
            .sort((a, b) => a.localeCompare(b)),
    ).toEqual(['accepted', 'taken']);
    expect(row.conversation.assigned_agent_id).toBe(
        conversation.assignedAgent.id,
    );
    expect(row.events.filter((event) => event.type === 'claimed')).toHaveLength(
        1,
    );

    // The loser's own API call says the same.
    const again = await loser.api.claim(ulid);

    expect(again.status).toBe(409);
    expect(again.error?.code).toBe('already_claimed');
});

test('an offline agent and an agent at capacity are not offered the chat; the one who can take it is', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Ann', 'Ben', 'Cy'],
    });
    const [ann, ben, cy] = team.agents;

    must(
        await adminApi.patch(`/api/v1/agents/${cy.id}`, {
            max_concurrent_chats: 1,
        }),
        'Cy takes one chat at a time',
    );

    const [annActor, benActor, cyActor] = await Promise.all([
        actors.staffLogin(ann, { presence: 'online', open: '/inbox' }),
        actors.staffLogin(ben, { presence: 'offline', open: '/inbox' }),
        actors.staffLogin(cy, { presence: 'online', open: '/inbox' }),
    ]);

    // Chat one: Ann and Cy are online, so both are offered; Cy takes it and is at capacity now.
    const first = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'First Visitor',
    });

    await annActor.inbox.expectOffer(first.ulid);
    await cyActor.inbox.expectOffer(first.ulid);
    await benActor.inbox.expectNoOffer(first.ulid);
    await cyActor.inbox.accept(first.ulid);
    await first.panel.expectState('active');

    // Chat two: Ben is offline, Cy is full. Only Ann is offered it.
    await cyActor.inbox.goto();

    const second = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Second Visitor',
    });

    await annActor.inbox.expectOffer(second.ulid);
    await cyActor.inbox.expectNoOffer(second.ulid);
    await benActor.inbox.expectNoOffer(second.ulid);

    const row = await readConversationRow(instance, second.ulid);

    expect(row.offers.map((offer) => offer.user_id)).toEqual([ann.id]);

    // Even an explicit claim is refused for the full agent (the server checks capacity, not only the offers).
    const refused = await cyActor.api.claim(second.ulid);

    expect(refused.ok).toBe(false);
    expect([403, 409]).toContain(refused.status);
    expect(
        must<{ status: string }>(
            await adminApi.get(`/api/v1/conversations/${second.ulid}`),
            'the second chat is still waiting',
        ).status,
    ).toBe('queued');

    await annActor.inbox.accept(second.ulid);
    await second.panel.expectState('active');
});

test('a transfer to a colleague: the visitor is told they are being connected to another agent and then meets the colleague', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Ann', 'Ben'],
    });
    const [ann, ben] = await Promise.all([
        actors.staffLogin(team.agents[0], {
            presence: 'online',
            open: '/inbox',
        }),
        actors.staffLogin(team.agents[1], {
            presence: 'online',
            open: '/inbox',
        }),
    ]);
    const flow = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Tara Transfer',
    });

    await ann.inbox.expectOffer(flow.ulid);
    await ann.inbox.accept(flow.ulid);
    await flow.panel.expectState('active');
    await flow.panel.send('Can you help me with my subscription?');
    await ann.inbox.expectMessage('my subscription');

    // Ann opens the transfer dialog and picks Ben (listed, reachable, with his load).
    await ann.inbox.tid('transfer-chat').click();

    const dialog = ann.inbox.tid('transfer-dialog');

    await expect(dialog).toBeVisible();
    await expect(
        dialog.getByTestId(`transfer-agent-${team.agents[1].id}`),
    ).toBeEnabled();
    await expect(
        dialog.getByTestId(`transfer-load-${team.agents[1].id}`),
    ).toContainText('0');
    await dialog.getByTestId(`transfer-agent-${team.agents[1].id}`).click();
    await dialog.getByTestId('transfer-confirm').click();
    await expect(dialog).toHaveCount(0);

    // The visitor is queued again ("Connecting you to another agent...") and keeps the conversation.
    await flow.panel.expectState('queued');
    await expect(
        flow.panel.frame.getByText('Connecting you to another agent'),
    ).toBeVisible();

    // Only Ben is offered it (a direct transfer is not widened to anybody else) and Ann's view says it was reassigned.
    await ben.inbox.expectOffer(flow.ulid);
    await ben.inbox.accept(flow.ulid);
    await flow.panel.expectState('active');
    await expect(
        flow.panel.root.getByRole('heading', { name: team.agents[1].name }),
    ).toBeVisible();

    // The earlier messages are still there for the visitor; the new agent can answer.
    await flow.panel.expectMessage('my subscription', 'visitor');
    await ben.inbox.expectMessage('my subscription');
    await ben.inbox.send('Hi Tara, Ben here, taking over from Ann.');
    await flow.panel.expectMessage('taking over from Ann', 'agent');

    const row = await readConversationRow(instance, flow.ulid);

    expect(row.conversation.assigned_agent_id).toBe(team.agents[1].id);
    expect(row.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['claimed', 'transferred']),
    );
    expect(ann.page.url()).toContain('/inbox');
});

test("a transfer to a category goes through that category's routing; a transfer to an unreachable colleague is refused and the chat stays", async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Ann', 'Ben', 'Cy'],
        emptyCategories: ['Second line'],
    });
    const [ann, ben, cy] = team.agents;
    const second = (
        must<{ ulid: string; slug: string; name: string }[]>(
            await adminApi.get('/api/v1/categories'),
            'categories',
        ) as { ulid: string; slug: string; name: string }[]
    ).find((category) => category.name.startsWith('Second line'))!;

    // Ben serves the second line as well; Cy serves only the first category and stays offline.
    must(
        await adminApi.patch(`/api/v1/agents/${ben.id}/categories`, {
            category_ulids: [team.category.ulid, second.ulid],
        }),
        'Ben serves both categories',
    );

    const [annActor, benActor] = await Promise.all([
        actors.staffLogin(ann, { presence: 'online', open: '/inbox' }),
        actors.staffLogin(ben, { presence: 'online', open: '/inbox' }),
    ]);
    const flow = await startActiveChat(actors, instance, chats, annActor, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Cass Category',
    });

    await flow.panel.send('I would like to speak to your second line.');
    await annActor.inbox.expectMessage('second line');

    // An offline colleague cannot be picked in the dialog and the server refuses it too; the chat stays with Ann.
    await annActor.inbox.tid('transfer-chat').click();

    const dialog = annActor.inbox.tid('transfer-dialog');

    await expect(dialog.getByTestId(`transfer-agent-${cy.id}`)).toBeDisabled();
    await expect(dialog.getByText('Offline').first()).toBeVisible();
    await annActor.inbox
        .tid('transfer-dialog')
        .getByRole('button', { name: 'Cancel' })
        .click();

    const refused = await annActor.api.transfer(flow.ulid, { agent_id: cy.id });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');
    expect(refused.error?.details).toMatchObject({
        target: 'agent',
        reason: 'offline',
    });

    const stays = must<{ status: string; assignedAgent: { id: number } }>(
        await annActor.api.conversation(flow.ulid),
        'the chat after the refused transfer',
    );

    expect(stays.status).toBe('active');
    expect(stays.assignedAgent.id).toBe(ann.id);
    await flow.panel.expectState('active');
    await annActor.inbox.send('Still here, let me find the right person.');
    await flow.panel.expectMessage('Still here', 'agent');

    // To the second category: the chat is queued again for that category's agents and Ben takes it.
    await annActor.inbox.tid('transfer-chat').click();
    await expect(dialog).toBeVisible();
    await dialog.getByTestId('transfer-tab-category').click();
    await dialog.getByTestId('transfer-category').selectOption(second.slug);
    await dialog.getByTestId('transfer-confirm').click();
    await expect(dialog).toHaveCount(0);

    await flow.panel.expectState('queued');
    await benActor.inbox.expectOffer(flow.ulid);
    await expect(
        benActor.inbox.tid(`offer-category-${flow.ulid}`),
    ).toContainText('Second line');
    // The agent who let go is not offered the chat again.
    await annActor.inbox.expectNoOffer(flow.ulid);
    await benActor.inbox.accept(flow.ulid);
    await acceptedBy(flow, team.agents[1].name);

    const row = await readConversationRow(instance, flow.ulid);

    expect(row.conversation.assigned_agent_id).toBe(ben.id);
    expect(
        await expectEventually(
            async () =>
                must<{ category: { slug: string } }>(
                    await adminApi.get(`/api/v1/conversations/${flow.ulid}`),
                    'the transferred chat',
                ),
            (chat) => chat.category.slug === second.slug,
            { message: 'the chat now belongs to the second category' },
        ),
    ).toBeTruthy();
});

async function acceptedBy(
    flow: Awaited<ReturnType<typeof startQueuedChat>>,
    name: string,
): Promise<void> {
    await flow.panel.expectState('active');
    await expect(flow.panel.root.getByRole('heading', { name })).toBeVisible();
}

test('a queued chat nobody accepts stays with the agents who were offered it until it times out, and an accepted offer survives the sweeps', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ann'] });
    const ann = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const flow = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Sid Sweep',
    });

    await acceptAs(ann, flow);

    // The sweeps that ran by the minute in production find nothing to do for an active chat that is not past its deadlines.
    await ageConversation(instance, flow.ulid, { by: 25 });
    await runSweep(instance, 'chat:expire-queued');
    await runSweep(instance, 'chat:offer-waves');
    await runSweep(instance, 'chat:close-idle');

    expect(
        must<{ status: string }>(
            await ann.api.conversation(flow.ulid),
            'the chat after the sweeps',
        ).status,
    ).toBe('active');
    await flow.panel.expectState('active');
});
