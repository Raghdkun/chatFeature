import { must, VisitorApi } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    readMailLog,
    runSweep,
} from '../support/chat-db';
import {
    createTeam,
    expect,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { openCustomerSite } from '../support/panel';
import { expectEventually } from '../support/wait';

/**
 * Nobody answers, so the visitor leaves a message: from a queue that timed out (`missed`), from a widget whose category has nobody
 * online (`409 no_agents`), from a widget that is closed by its opening hours, and the widget that has the offline form switched off.
 * The offline ticket is a separate conversation (`type: offline`, linked to the missed chat in its `created` event) that an agent
 * claims on /offline-tickets, answers (the reply is stored and e-mailed: the log mailer shows the attempt) and closes.
 *
 * Every test builds its own team (category, agents, widget) with `createTeam()`: presence is changed freely without touching the
 * seeded Alice and Bob of the other files.
 */
test.use({ scenario: 'p4-chat' });

test('a missed chat becomes an offline ticket: form, ticket linked to the missed chat, claimed on /offline-tickets, answered by mail, closed', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Olga'] });
    const olga = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid: missedUlid } = await startQueuedChat(
        actors,
        instance,
        chats,
        {
            key: team.widget.key,
            category: team.category.slug,
            name: 'Mia Missed',
        },
    );

    await olga.inbox.expectOffer(missedUlid);

    // Nobody accepts before the queue timeout: the visitor is told over the socket and shown the offline form with the apology.
    await ageConversation(instance, missedUlid, { queueExpired: true });
    await runSweep(instance, 'chat:expire-queued');
    await panel.expectState('offline');
    await expect(panel.tid('offline-form')).toBeVisible();
    await expect(
        panel.frame.getByText('Nobody was free to take your chat'),
    ).toBeVisible();
    await expect(olga.inbox.offer(missedUlid)).toHaveCount(0);

    expect(
        (await readConversationRow(instance, missedUlid)).conversation.status,
    ).toBe('missed');

    // The name from the pre-chat form is kept; the visitor adds an address and the message.
    await expect(
        panel.tid('offline-form').locator('input[name="name"]'),
    ).toHaveValue('Mia Missed');

    const created = await panel.submitOffline({
        email: 'mia.missed@example.test',
        message: 'Please call me about order 4821, the parcel never came.',
    });

    expect(created).toMatchObject({
        status: 201,
        type: 'offline',
        category: team.category.slug,
    });
    const ticket = chats.track(created.ulid);

    await panel.expectState('closed');
    await expect(panel.frame.getByText('Message sent')).toBeVisible();
    await expect(
        panel.frame.getByText(
            `We'll reply to mia.missed@example.test. Your ticket number is ${created.ticketNo}.`,
        ),
    ).toBeVisible();

    // The ticket is a row of its own that remembers the chat it came from.
    const ticketRow = await readConversationRow(instance, ticket);

    expect(ticketRow.conversation).toMatchObject({
        type: 'offline',
        status: 'queued',
        queue_expires_at: null,
    });
    expect(
        ticketRow.events.find((event) => event.type === 'created')?.payload,
    ).toMatchObject({ origin: missedUlid });

    // Olga sees it on /offline-tickets and claims it.
    await olga.page.goto('/offline-tickets');

    const card = olga.page.getByTestId(`ticket-${ticket}`);

    await expect(card).toContainText('Mia Missed');
    await expect(card).toContainText('mia.missed@example.test');
    await expect(card).toContainText('order 4821');
    await expect(card).toHaveAttribute('data-status', 'queued');
    await olga.page.getByTestId(`ticket-claim-${ticket}`).click();
    await expect(olga.page).toHaveURL(new RegExp(`/inbox/${ticket}$`));
    await expect(olga.inbox.conversation).toBeVisible();
    await olga.inbox.expectMessage('parcel never came');

    const claimed = must<{ status: string; assignedAgent: { id: number } }>(
        await olga.api.conversation(ticket),
        'Olga reads the claimed ticket',
    );

    expect(claimed.status).toBe('active');
    expect(claimed.assignedAgent.id).toBe(team.agents[0].id);

    // The reply is a normal message of the conversation and goes out by e-mail (the log mailer records the attempt).
    await olga.inbox.send(
        'Hello Mia, the parcel is with the courier and arrives tomorrow.',
    );
    await olga.inbox.expectMessage('arrives tomorrow');

    const stored = await expectEventually(
        async () =>
            must<{ sender: { type: string }; body: string }[]>(
                await olga.api.messages(ticket),
                'the ticket messages',
            ),
        (messages) => messages.length === 2,
        { message: 'the reply is stored next to the visitor message' },
    );

    expect(
        stored.map((message) => [message.sender.type, message.body]),
    ).toEqual([
        ['visitor', 'Please call me about order 4821, the parcel never came.'],
        [
            'agent',
            'Hello Mia, the parcel is with the courier and arrives tomorrow.',
        ],
    ]);

    const log = await expectEventually(
        () => readMailLog(instance),
        (text) => text.includes(`ticket ${created.ticketNo}`),
        { message: 'the mailer logs the reply to the visitor' },
    );

    expect(log).toContain('mia.missed@example.test');
    expect(log).toContain(
        'the parcel is with the courier and arrives tomorrow',
    );

    // Resolving the ticket closes it (no rating prompt: the visitor is long gone).
    await olga.inbox.endChat();
    await expectEventually(
        () => readConversationRow(instance, ticket),
        (row) => row.conversation.status === 'closed',
        { message: 'the agent closes the offline ticket' },
    );
    expect(
        (await readConversationRow(instance, ticket)).conversation,
    ).toMatchObject({ status: 'closed', close_reason: 'system' });
    expect((await readConversationRow(instance, ticket)).rating).toBeNull();
});

test('a category with nobody online: the panel offers the message form straight away and the ticket has no missed chat behind it', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    // One agent exists but never went online: the category has nobody to take a chat.
    const team = await createTeam(adminApi, instance, { agents: ['Ola'] });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });
    const started = await panel.startChat({
        category: team.category.slug,
        name: 'Nina Nobody',
    });

    expect(started.ulid).toBeNull();
    await panel.expectState('offline');
    await expect(panel.tid('offline-form')).toBeVisible();
    await expect(
        panel.frame.getByText('No agent is available right now.').first(),
    ).toBeVisible();

    // The server agrees: starting a chat for the category is `409 no_agents`.
    const api = await VisitorApi.start(instance, { key: team.widget.key });
    const refused = await api.startChat({
        category: team.category.slug,
        name: 'Nina Nobody',
    });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');
    await api.dispose();

    const created = await panel.submitOffline({
        name: 'Nina Nobody',
        email: 'nina@example.test',
        message: 'Is the blue one back in stock?',
    });

    expect(created).toMatchObject({ status: 201, type: 'offline' });
    chats.track(created.ulid);
    await panel.expectState('closed');

    const row = await readConversationRow(instance, created.ulid!);
    const origin = row.events.find(
        (event) => event.type === 'created',
    )?.payload;

    expect(origin?.origin ?? null).toBeNull();
});

test('the offline form validates in the panel: a missing e-mail and message are field errors, nothing is sent', async ({
    actors,
    adminApi,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ora'] });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    await panel.startChat({
        category: team.category.slug,
        name: 'Vik Validate',
    });
    await panel.expectState('offline');

    const requests: string[] = [];

    visitor.page.on('request', (request) => {
        if (request.url().includes('/offline-tickets')) {
            requests.push(request.url());
        }
    });

    const form = panel.tid('offline-form');

    await form.locator('input[name="email"]').fill('not-an-address');
    await form.locator('button[type="submit"]').click();
    await expect(form.locator('input[name="email"]')).toHaveAttribute(
        'aria-invalid',
        'true',
    );
    await expect(form.locator('textarea[name="message"]')).toHaveAttribute(
        'aria-invalid',
        'true',
    );
    await expect(form.getByText('Enter a valid email address.')).toBeVisible();
    expect(requests).toEqual([]);
    await panel.expectState('offline');
});

test('a widget with the offline form switched off only says nobody is available: no form, no ticket', async ({
    actors,
    adminApi,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Oli'],
        config: { features: { offlineForm: false } },
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    await panel.startChat({
        category: team.category.slug,
        name: 'Nora NoForm',
    });
    await panel.expectState('offline');
    await expect(
        panel.frame.getByText('No agent is available right now.').first(),
    ).toBeVisible();
    await expect(panel.tid('offline-form')).toHaveCount(0);
});

test('outside the opening hours the panel shows the message form at once (no chat can start)', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Otto'],
        settings: { offline_mode: 'always_offline' },
        config: { hours: { mode: 'always_offline' } },
    });
    const otto = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        keepAlive: true,
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    // An agent is online, but the widget is closed: the panel goes to the offline screen without a chat attempt.
    await panel.startChat({ category: team.category.slug, name: 'Hana Hours' });
    await panel.expectState('offline');
    await expect(panel.tid('offline-form')).toBeVisible();

    const online = await otto.api.queue();

    expect(online.ok).toBe(true);
    expect(online.data).toEqual([]);

    const created = await panel.submitOffline({
        name: 'Hana Hours',
        email: 'hana@example.test',
        message: 'Do you ship to Norway?',
    });

    expect(created).toMatchObject({ status: 201, type: 'offline' });
    chats.track(created.ulid);
    await panel.expectState('closed');
});
