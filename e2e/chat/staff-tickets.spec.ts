import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import { readConversationRow } from '../support/chat-db';
import { readAppLog } from '../support/staff-db';
import { readConversation, readMessages } from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * Offline tickets in the dashboard (`/offline-tickets`): who sees which ticket (the categories they serve, everybody's tickets for the
 * category-less ones, all for an administrator), a new ticket appearing live, claim -> reply (stored and e-mailed) -> close, and what
 * the conversation view does differently for a ticket (no attachments, the e-mail notice). Own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

const category = (
    world: { categories: Record<string, { slug: string }> },
    label: string,
) => world.categories[label].slug;

test('an agent sees the tickets of the topics they serve, an administrator sees them all, and others are refused', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        categories: ['main', 'other'],
        agents: { ann: ['main'], ben: ['other'] },
    });
    const ann = await actors.account(world.agents.ann);
    const ben = await actors.account(world.agents.ben);
    const admin = await actors.staff('admin');
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const other = await VisitorApi.start(instance, { key: world.widget.key });
    const forAnn = must<{ ulid: string }>(
        await visitor.offlineTicket({
            name: 'Ticket Tina',
            email: 'tina@example.test',
            message: 'My invoice is wrong.',
            category: category(world, 'main'),
        }),
        'ticket in main',
    );
    const forBen = must<{ ulid: string }>(
        await other.offlineTicket({
            name: 'Ticket Tom',
            email: 'tom@example.test',
            message: 'Where do I find the sizing chart?',
            category: category(world, 'other'),
        }),
        'ticket in other',
    );

    await ann.page.goto('/offline-tickets');
    await expect(ann.page.getByTestId(`ticket-${forAnn.ulid}`)).toBeVisible();
    await expect(ann.page.getByTestId(`ticket-${forAnn.ulid}`)).toContainText(
        'Ticket Tina',
    );
    await expect(ann.page.getByTestId(`ticket-${forAnn.ulid}`)).toContainText(
        'tina@example.test',
    );
    await expect(ann.page.getByTestId(`ticket-${forAnn.ulid}`)).toContainText(
        'My invoice is wrong.',
    );
    await expect(ann.page.getByTestId(`ticket-${forBen.ulid}`)).toHaveCount(0);

    await ben.page.goto('/offline-tickets');
    await expect(ben.page.getByTestId(`ticket-${forBen.ulid}`)).toBeVisible();
    await expect(ben.page.getByTestId(`ticket-${forAnn.ulid}`)).toHaveCount(0);

    // The administrator sees every ticket (and may close them, below).
    await admin.page.goto('/offline-tickets');
    await expect(admin.page.getByTestId(`ticket-${forAnn.ulid}`)).toBeVisible();
    await expect(admin.page.getByTestId(`ticket-${forBen.ulid}`)).toBeVisible();

    // The API agrees, and a ticket of a topic you do not serve is a 403 (not "empty", not "not found").
    expect((await ann.api.conversation(forAnn.ulid)).status).toBe(200);
    expect((await ann.api.conversation(forBen.ulid)).status).toBe(403);
    expect((await ben.api.conversation(forAnn.ulid)).status).toBe(403);
    expect((await ann.api.claim(forBen.ulid)).status).toBe(403);

    const listed = must<{ ulid: string }[]>(
        await ann.api.conversations({ type: 'offline' }),
        'Ann lists tickets',
    ).map((ticket) => ticket.ulid);

    expect(listed).toContain(forAnn.ulid);
    expect(listed).not.toContain(forBen.ulid);

    await Promise.all([visitor.dispose(), other.dispose()]);
});

test("a ticket whose widget has no topics is everybody's: every active agent sees and can claim it", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        categories: [],
        agents: { ann: [], ben: [] },
    });
    const ann = await actors.account(world.agents.ann);
    const ben = await actors.account(world.agents.ben);
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid, category: topic } = must<{ ulid: string; category: unknown }>(
        await visitor.offlineTicket({
            name: 'Nobody Nia',
            email: 'nia@example.test',
            message: 'No topic here.',
        }),
        'a ticket without a topic',
    );

    expect(topic).toBeNull();

    for (const agent of [ann, ben]) {
        await agent.page.goto('/offline-tickets');
        await expect(agent.page.getByTestId(`ticket-${ulid}`)).toBeVisible();
    }

    // The first to claim it gets it; the other one's list drops it and a second claim is refused.
    await ann.page.getByTestId(`ticket-claim-${ulid}`).click();
    await expect(ann.page).toHaveURL(new RegExp(`/inbox/${ulid}$`));
    await expect(ben.page.getByTestId(`ticket-${ulid}`)).toHaveCount(0);
    expect((await ben.api.claim(ulid)).status).toBe(403);

    await visitor.dispose();
});

test('a new ticket appears in an open tickets page; claim, reply (stored and e-mailed) and close take it through its life', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const ben = await actors.account(world.agents.ben);

    await ann.page.goto('/offline-tickets');
    await ben.page.goto('/offline-tickets');
    await expect(ann.page.getByTestId('tickets-page')).toBeVisible();

    // The visitor leaves a message: the ticket shows up in both open pages without a reload.
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const ticket = must<{ ulid: string; type: string; status: string }>(
        await visitor.offlineTicket({
            name: 'Reply Ruth',
            email: 'ruth@example.test',
            message: 'Can you resend my receipt?',
            category: category(world, 'main'),
        }),
        'the ticket',
    );

    expect(ticket).toMatchObject({ type: 'offline', status: 'queued' });
    await expect(ann.page.getByTestId(`ticket-${ticket.ulid}`)).toBeVisible();
    await expect(ben.page.getByTestId(`ticket-${ticket.ulid}`)).toBeVisible();
    await expect(ann.page.getByTestId(`ticket-${ticket.ulid}`)).toHaveAttribute(
        'data-status',
        'queued',
    );

    // Ann claims it from the list: the conversation opens, the card leaves Ben's page (it is Ann's now).
    await ann.page.getByTestId(`ticket-claim-${ticket.ulid}`).click();
    await expect(ann.page).toHaveURL(new RegExp(`/inbox/${ticket.ulid}$`));
    await expect(ben.page.getByTestId(`ticket-${ticket.ulid}`)).toHaveCount(0);

    // A ticket's conversation: the first message is the visitor's, the composer says where the answer goes and offers no attachments.
    await expect(ann.inbox.conversation).toHaveAttribute(
        'data-status',
        'active',
    );
    await ann.inbox.expectMessage('Can you resend my receipt?');
    await expect(ann.inbox.tid('composer-email-notice')).toContainText(
        'ruth@example.test',
    );
    await expect(ann.inbox.tid('composer-attach')).toHaveCount(0);
    await expect(ann.inbox.tid('transfer-chat')).toHaveCount(0);

    // The reply is a normal message AND an e-mail to the visitor (the log mailer writes it to the instance's log).
    await ann.inbox.send('Sure, the receipt is attached to this reply.');
    await ann.inbox.expectMessage('the receipt is attached');

    const stored = await expectEventually(
        () => readMessages(ann, ticket.ulid),
        (messages) => messages.length === 2,
        { message: 'the reply was stored' },
    );

    expect(stored.map((message) => message.sender.type)).toEqual([
        'visitor',
        'agent',
    ]);
    expect(stored[1].body).toBe('Sure, the receipt is attached to this reply.');

    const log = await expectEventually(
        () => readAppLog(instance),
        (text) =>
            text.includes('ruth@example.test') &&
            text.includes('the receipt is attached to this reply'),
        {
            message:
                'the reply was mailed (the log mailer wrote it to laravel.log)',
        },
    );

    expect(log).toContain('ruth@example.test');

    // Closing it asks first; afterwards it is closed, no rating was asked, and it leaves the tickets page.
    await ann.inbox.tid('end-chat').click();
    await expect(ann.inbox.tid('end-chat-dialog')).toBeVisible();
    await ann.inbox.tid('end-chat-confirm').click();
    await expect(ann.inbox.conversation).toHaveAttribute(
        'data-status',
        'closed',
    );
    await expect(ann.inbox.tid('composer-disabled')).toBeVisible();

    const closed = await readConversationRow(instance, ticket.ulid);

    expect(closed.conversation).toMatchObject({
        status: 'closed',
        type: 'offline',
    });
    expect(closed.rating).toBeNull();

    await ann.page.goto('/offline-tickets');
    await expect(ann.page.getByTestId(`ticket-${ticket.ulid}`)).toHaveCount(0);

    await visitor.dispose();
});

test('an agent closes their own claimed ticket straight from the list, an administrator closes one nobody claimed', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const admin = await actors.staff('admin');
    const first = await VisitorApi.start(instance, { key: world.widget.key });
    const second = await VisitorApi.start(instance, { key: world.widget.key });
    const mine = must<{ ulid: string }>(
        await first.offlineTicket({
            name: 'Close Cleo',
            email: 'cleo@example.test',
            message: 'Please call me.',
            category: category(world, 'main'),
        }),
        'first ticket',
    );
    const unclaimed = must<{ ulid: string }>(
        await second.offlineTicket({
            name: 'Close Cass',
            email: 'cass@example.test',
            message: 'Another one.',
            category: category(world, 'main'),
        }),
        'second ticket',
    );

    must(await ann.api.claim(mine.ulid), 'Ann claims the first ticket');
    await ann.page.goto('/offline-tickets');

    const card = ann.page.getByTestId(`ticket-${mine.ulid}`);

    await expect(card).toHaveAttribute('data-status', 'active');
    await expect(
        ann.page.getByTestId(`ticket-reply-${mine.ulid}`),
    ).toContainText('Reply');
    await ann.page.getByTestId(`ticket-close-${mine.ulid}`).click();
    await ann.page.getByTestId('end-chat-confirm').click();
    await expect(card).toHaveCount(0);
    expect((await readConversation(ann, mine.ulid)).status).toBe('closed');

    // The administrator may close a ticket nobody picked up (an agent may not: `POST .../close` needs a claimed ticket).
    expect((await ann.api.close(unclaimed.ulid)).status).toBe(403);
    expect((await admin.api.close(unclaimed.ulid)).status).toBe(200);
    expect((await readConversation(ann, mine.ulid)).status).toBe('closed');

    const gone = await readConversationRow(instance, unclaimed.ulid);

    expect(gone.conversation).toMatchObject({ status: 'closed' });

    await Promise.all([first.dispose(), second.dispose()]);
});
