import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must } from '../support/chat-api';
import { readConversationRow } from '../support/chat-db';
import { openCustomerSite } from '../support/panel';

/**
 * The smoke test of the P4 e2e infrastructure and of the live chat itself, against a real Reverb: a visitor on the customer site
 * picks Billing and is queued, Alice (online, serves Billing) is offered the chat in her inbox and accepts, Bob (online, serves Sales
 * and General) is never offered it, visitor and agent exchange a message each way, the agent ends the chat, the visitor rates 5 and
 * the chat closes. Every step waits for the realtime event it depends on (no sleeps, no polling fallback).
 */
test.use({ scenario: 'p4-chat' });

test('a Billing chat: queued, accepted by Alice only, messages both ways, ended, rated 5, closed', async ({
    actors,
    instance,
    seed,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const bob = await actors.staff('bob', {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();

    // The visitor opens the widget on the customer site and asks about Billing.
    const panel = await openCustomerSite(visitor.page, instance, {
        open: true,
    });
    const chat = await panel.startChat({
        category: 'billing',
        name: 'Vera Visitor',
    });

    expect(chat.status).toBe(201);
    expect(chat.ulid).toMatch(/^[0-9a-z]{26}$/);

    const ulid = chat.ulid!;

    await panel.expectState('queued');
    await expect(panel.tid('queued-timer')).toBeVisible();

    // Alice is offered it (a realtime event into her open inbox) and Bob, who does not serve Billing, is not.
    await alice.inbox.expectOffer(ulid);
    await expect(alice.inbox.offer(ulid)).toHaveAttribute('data-state', 'open');
    await expect(bob.inbox.offers).toHaveCount(0);

    // Alice accepts: the visitor's panel turns active with Alice as the agent.
    await alice.inbox.accept(ulid);
    await panel.expectState('active');
    await expect(
        panel.root.getByRole('heading', { name: alice.user.name }),
    ).toBeVisible();

    // Bob's inbox never showed the chat; the server never offered it to him.
    await expect(bob.inbox.offers).toHaveCount(0);
    expect(
        must<unknown[]>(await bob.api.queue(), 'Bob reads the queue'),
    ).toEqual([]);

    // One message each way.
    await panel.send('Hello, I was charged twice for my last order.');
    await alice.inbox.expectMessage('charged twice');
    await alice.inbox.send('Hi Vera, I am looking at it right now.');
    await panel.expectMessage('looking at it right now', 'agent');

    // The agent ends the chat; the visitor is asked to rate it and gives 5 stars.
    await alice.inbox.endChat();
    await panel.expectState('ended');
    await panel.rate(5, 'Quick and friendly.');
    await panel.expectState('closed');

    // Through the REST API (as Alice) the conversation is closed; the stored row says it was rated by the visitor after the agent ended it.
    const closed = await expectEventually(
        async () =>
            must<{ status: string; assignedAgent: { id: number } }>(
                await alice.api.conversation(ulid),
                'Alice reads the chat',
            ),
        (conversation) => conversation.status === 'closed',
        { message: 'the conversation closes after the rating' },
    );

    expect(closed.assignedAgent.id).toBe(seed.users.alice);

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'rated',
        ended_by: 'agent',
    });
    expect(row.rating).toMatchObject({
        score: 5,
        comment: 'Quick and friendly.',
    });
    // Only Alice was ever offered the chat.
    expect(row.offers.map((offer) => offer.user_id)).toEqual([
        seed.users.alice,
    ]);
});
