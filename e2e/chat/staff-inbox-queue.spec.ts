import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import { openCustomerSite } from '../support/panel';
import { showList, waitForStatus } from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * The agent's queue in a real browser, over a real Reverb: an offer appears the moment a visitor starts a chat (category, preview, a
 * running countdown), disappears when somebody else accepts ("taken") or the chat is cancelled / missed, and a click on Accept opens
 * the conversation. Every test works in its own world (`world.ts`: its own agents, category and widget), so the parallel files of this
 * scenario never see each other's offers.
 */
test.use({ scenario: 'p4-staff' });

test('an offer appears live with the category, a preview and a running countdown; Accept opens the chat for both sides', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });

    // The inbox is open and empty: nothing is waiting.
    await expect(ann.inbox.tid('inbox-queue-empty')).toBeVisible();

    // A visitor with a first message (a preview) starts a chat through the public API ...
    const api = await VisitorApi.start(instance, { key: world.widget.key });
    const started = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name: 'Preview Pat',
            message: 'Where is my parcel? It was due on Monday.',
        }),
        'the visitor starts a chat',
    );

    // ... and the offer shows up in Ann's open inbox without a reload: category, name, preview, a countdown ring.
    await ann.inbox.expectOffer(started.ulid);
    await expect(ann.inbox.offer(started.ulid)).toContainText('Preview Pat');
    await expect(ann.inbox.offer(started.ulid)).toContainText(
        'Where is my parcel',
    );
    await expect(ann.inbox.tid(`offer-category-${started.ulid}`)).toHaveText(
        world.categories.main.name,
    );
    await expect(ann.inbox.tid('inbox-queue-count')).toHaveText('1');

    const countdown = ann.inbox
        .offer(started.ulid)
        .getByTestId('offer-countdown');

    await expect(countdown).toBeVisible();

    const first = await countdown.textContent();

    await expect
        .poll(async () => countdown.textContent(), {
            message: 'the countdown ticks down',
            timeout: 8_000,
        })
        .not.toBe(first);

    // Accept: the conversation opens, Ann's chat row appears, the visitor's API sees her as the agent.
    await ann.inbox.accept(started.ulid);
    await expect(ann.inbox.tid('conversation-name')).toHaveText('Preview Pat');

    const accepted = await waitForStatus(ann, started.ulid, 'active');

    expect(accepted.assignedAgent?.id).toBe(world.agents.ann.id);
    expect(
        must<{ status: string; agent: { name: string } }>(
            await api.conversation(),
            'the visitor reads its chat',
        ),
    ).toMatchObject({
        status: 'active',
        agent: { name: world.agents.ann.name },
    });

    await showList(ann);
    await expect(ann.inbox.chatRow(started.ulid)).toBeVisible();
    await ann.inbox.expectNoOffer(started.ulid);

    await api.dispose();
});

test('when another agent accepts first the card turns into "taken" and leaves; a late claim is 409 already_claimed', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });
    const api = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name: 'Race Rita',
        }),
        'the visitor starts a chat',
    );

    await ann.inbox.expectOffer(ulid);
    await ben.inbox.expectOffer(ulid);

    await ann.inbox.accept(ulid);

    // Ben's card says who won, then goes away by itself.
    await expect(ben.inbox.offer(ulid)).toHaveAttribute('data-state', 'taken');
    await expect(ben.inbox.tid(`offer-outcome-${ulid}`)).toContainText(
        world.agents.ann.name,
    );
    await expect(
        ben.inbox.tid(`offer-accept-${ulid}`),
        'no Accept button on a taken card',
    ).toHaveCount(0);
    await ben.inbox.expectNoOffer(ulid);

    // Ben's late claim (a stale tab, a script) is the documented conflict, naming the winner.
    const late = await ben.api.claim(ulid);

    expect(late.status).toBe(409);
    expect(late.error?.code).toBe('already_claimed');
    expect(late.error?.details).toMatchObject({ by: world.agents.ann.name });

    // The stored truth: Ann's offer was accepted, Ben's was taken.
    const row = await readConversationRow(instance, ulid);

    expect(row.conversation.assigned_agent_id).toBe(world.agents.ann.id);
    expect(
        Object.fromEntries(
            row.offers.map((offer) => [offer.user_id, offer.response]),
        ),
    ).toEqual({
        [world.agents.ann.id]: 'accepted',
        [world.agents.ben.id]: 'taken',
    });

    await api.dispose();
});

test('two agents pressing Accept at the same moment: exactly one wins, the other sees "taken"', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });
    const api = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name: 'Double Dana',
        }),
        'the visitor starts a chat',
    );

    await ann.inbox.expectOffer(ulid);
    await ben.inbox.expectOffer(ulid);

    // Both click at once.
    await Promise.all([
        ann.inbox.tid(`offer-accept-${ulid}`).click(),
        ben.inbox.tid(`offer-accept-${ulid}`).click(),
    ]);

    const row = await expectEventually(
        () => readConversationRow(instance, ulid),
        (value) => value.conversation.status === 'active',
        { message: 'the chat is claimed' },
    );
    const winnerId = row.conversation.assigned_agent_id as number;
    const [winner, loser] =
        winnerId === world.agents.ann.id ? [ann, ben] : [ben, ann];

    expect([world.agents.ann.id, world.agents.ben.id]).toContain(winnerId);
    expect(row.conversation.claim_version).toBeGreaterThanOrEqual(1);

    // The winner is in the conversation; the loser stays on the list with a "taken" card that disappears, and nothing is left open.
    await expect(winner.page).toHaveURL(new RegExp(`/inbox/${ulid}$`));
    await expect(winner.inbox.conversation).toBeVisible();
    await expect(loser.page).not.toHaveURL(new RegExp(`/inbox/${ulid}$`));
    await loser.inbox.expectNoOffer(ulid);

    const loserOffer = row.offers.find((offer) => offer.user_id !== winnerId);

    expect(['taken', 'accepted']).toContain(loserOffer?.response ?? 'taken');
    expect(
        row.offers.filter((offer) => offer.response === 'accepted'),
        'one accepted offer',
    ).toHaveLength(1);

    // Only the winner can read the chat afterwards.
    expect((await winner.api.conversation(ulid)).status).toBe(200);
    expect((await loser.api.conversation(ulid)).status).toBe(403);

    await api.dispose();
});

test('the visitor cancelling and the queue running out both take the offer away from every agent', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });

    // 1. The visitor cancels through the panel's own button.
    const cancelling = await actors.visitor();
    const panel = await openCustomerSite(cancelling.page, instance, {
        key: world.widget.key,
        open: true,
    });
    const first = await panel.startChat({
        category: world.categories.main.slug,
        name: 'Cancel Carl',
    });

    await ann.inbox.expectOffer(first.ulid!);
    await ben.inbox.expectOffer(first.ulid!);
    await panel.cancelQueued();
    await panel.expectState('closed');
    await ann.inbox.expectNoOffer(first.ulid!);
    await ben.inbox.expectNoOffer(first.ulid!);

    const cancelled = await readConversationRow(instance, first.ulid!);

    expect(cancelled.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'cancelled',
    });

    // 2. Nobody accepts and the deadline passes (time moved by hand, the sweep run as the scheduler would).
    const waiting = await VisitorApi.start(instance, {
        key: world.widget.key,
    });
    const second = must<{ ulid: string }>(
        await waiting.startChat({
            category: world.categories.main.slug,
            name: 'Missed Mia',
        }),
        'the second visitor starts a chat',
    );

    await ann.inbox.expectOffer(second.ulid);
    await ben.inbox.expectOffer(second.ulid);
    await ageConversation(instance, second.ulid, { queueExpired: true });
    await runSweep(instance, 'chat:expire-queued');
    await ann.inbox.expectNoOffer(second.ulid);
    await ben.inbox.expectNoOffer(second.ulid);

    // A missed chat belongs to nobody: an agent may not read it any more, the administrator can.
    expect((await ann.api.conversation(second.ulid)).status).toBe(403);
    expect(
        must<{ status: string }>(
            await adminApi.get(`/api/v1/conversations/${second.ulid}`),
            'the administrator reads the missed chat',
        ).status,
    ).toBe('missed');
    expect(
        (await readConversationRow(instance, second.ulid)).conversation,
    ).toMatchObject({ status: 'missed' });

    await waiting.dispose();
});
