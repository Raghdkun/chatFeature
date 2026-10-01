import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import { agePresence } from '../support/staff-db';
import { Inbox } from '../support/inbox';
import { showList } from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * Presence: the selector in the inbox (online / away / offline), the 30 s heartbeat, and what each status does to routing: an offline
 * agent is never offered a chat, an away agent only from the second wave, and an agent nobody has heard from for 90 s counts as
 * offline. Two tabs of one agent stay in step. Each test has its own world (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

const ANN_BEN_CY = {
    ann: ['main'],
    ben: ['main'],
    cy: ['main'],
};

test('the selector sets online, away and offline, the choice survives a reload, and offline offers a way back', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });
    const select = ann.inbox.tid('presence-select');

    // A fresh agent starts offline: the inbox says so and offers the one-click way online.
    await expect(select).toHaveValue('offline');
    await expect(ann.inbox.tid('presence-offline-notice')).toBeVisible();

    await ann.inbox.tid('presence-go-online').click();
    await expect(select).toHaveValue('online');
    await expect(ann.inbox.tid('presence-offline-notice')).toHaveCount(0);

    await select.selectOption('away');
    await expect(select).toHaveValue('away');
    await expect
        .poll(async () => must(await ann.api.presence(), 'presence').status)
        .toBe('away');

    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await expect(select).toHaveValue('away');

    await select.selectOption('offline');
    await expect(select).toHaveValue('offline');
    await expect
        .poll(async () => must(await ann.api.presence(), 'presence').status)
        .toBe('offline');
    await expect(ann.inbox.tid('presence-offline-notice')).toBeVisible();
});

test('an open inbox keeps its agent present: a heartbeat goes out every 30 seconds', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const beats: number[] = [];

    ann.page.on('request', (request) => {
        if (
            request.method() === 'POST' &&
            new URL(request.url()).pathname === '/api/v1/me/presence/heartbeat'
        ) {
            beats.push(Date.now());
        }
    });

    // The page's clock is ours: 30 s pass at once, as often as we like.
    await ann.page.clock.install();
    await ann.inbox.goto();

    await expect
        .poll(() => beats.length, { timeout: 10_000 })
        .toBeGreaterThan(0);

    const before = beats.length;

    await ann.page.clock.fastForward(31_000);
    await expect.poll(() => beats.length).toBeGreaterThan(before);

    const afterOne = beats.length;

    await ann.page.clock.fastForward(31_000);
    await expect.poll(() => beats.length).toBeGreaterThan(afterOne);

    // The server counted them: the agent is reachable and `lastSeenAt` is recent.
    const presence = must<{ status: string; lastSeenAt: string }>(
        await ann.api.presence(),
        'presence',
    );

    expect(presence.status).toBe('online');
    expect(Date.now() - Date.parse(presence.lastSeenAt)).toBeLessThan(60_000);
});

test('routing follows presence: online agents are offered a chat at once, away ones in the second wave, offline ones never', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, { agents: ANN_BEN_CY });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'away',
        open: '/inbox',
    });
    const cy = await actors.account(world.agents.cy, {
        presence: 'offline',
        open: '/inbox',
    });
    const api = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name: 'Wave Wanda',
        }),
        'the visitor starts a chat',
    );

    // Wave 1 (online): only Ann.
    await ann.inbox.expectOffer(ulid);
    await ben.inbox.expectNoOffer(ulid);
    await cy.inbox.expectNoOffer(ulid);

    // 25 s pass (by hand): the second wave is due and the sweep makes it; Ben (away) is offered the chat, Cy (offline) still is not.
    await ageConversation(instance, ulid, { by: 25 });
    await runSweep(instance, 'chat:offer-waves');
    await ben.inbox.expectOffer(ulid);
    await ann.inbox.expectOffer(ulid);
    await cy.inbox.expectNoOffer(ulid);

    const row = await readConversationRow(instance, ulid);
    const waves = Object.fromEntries(
        row.offers.map((offer) => [offer.user_id, offer.wave]),
    );

    expect(waves).toEqual({
        [world.agents.ann.id]: 1,
        [world.agents.ben.id]: 2,
    });

    // The away agent can take it.
    await ben.inbox.accept(ulid);
    await ann.inbox.expectNoOffer(ulid);

    await api.dispose();
});

test('with nobody reachable the visitor is told so (no_agents); an agent whose heartbeat is 90 s old counts as nobody', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const category = world.categories.main.slug;

    // Online and fresh: a chat can be started (and is cancelled again so it does not wait).
    const first = await VisitorApi.start(instance, { key: world.widget.key });
    const started = must<{ ulid: string }>(
        await first.startChat({ category, name: 'Fresh Fay' }),
        'start with a fresh heartbeat',
    );

    must(await first.cancel(started.ulid), 'cancel');

    // The last heartbeat is 2 minutes old: the stored status still says online, but routing (and `GET /me/presence`) say offline.
    await agePresence(instance, world.agents.ann.id, 120);

    expect(
        must<{ status: string }>(await ann.api.presence(), 'presence').status,
    ).toBe('offline');

    const stale = await VisitorApi.start(instance, { key: world.widget.key });
    const refused = await stale.startChat({ category, name: 'Stale Sam' });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');

    // The dashboard beats again (any heartbeat while online): Ann is back, and the next visitor gets through.
    must(await ann.api.heartbeat(), 'heartbeat');

    const back = await VisitorApi.start(instance, { key: world.widget.key });
    const again = await back.startChat({ category, name: 'Back Bea' });

    expect(again.status).toBe(201);

    // Going offline on purpose is the same for routing: nobody to offer to.
    await ann.setPresence('offline');

    const gone = await VisitorApi.start(instance, { key: world.widget.key });

    expect(
        (await gone.startChat({ category, name: 'Gone Gus' })).error?.code,
    ).toBe('no_agents');

    await Promise.all(
        [first, stale, back, gone].map((visitor) => visitor.dispose()),
    );
});

test('two tabs of the same agent stay in step: presence, the offer, the accepted chat', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const first = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const secondPage = await first.newPage();
    const second = new Inbox(secondPage);

    await second.goto();

    // Presence chosen in one tab shows in the other (the `presence.changed` event on the staff roster).
    await first.inbox.tid('presence-select').selectOption('away');
    await expect(second.tid('presence-select')).toHaveValue('away');
    await second.tid('presence-select').selectOption('online');
    await expect(first.inbox.tid('presence-select')).toHaveValue('online');

    // An offer reaches both; accepting in one tab opens the chat there and takes it off the other's queue and into its list.
    const api = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name: 'Tab Tess',
        }),
        'the visitor starts a chat',
    );

    await first.inbox.expectOffer(ulid);
    await second.expectOffer(ulid);
    await first.inbox.accept(ulid);
    await second.expectNoOffer(ulid);
    await expect(second.chatRow(ulid)).toBeVisible();

    // A message the visitor writes arrives in both tabs; the one that is not reading it counts it as unseen.
    must(await api.send(ulid, 'Anyone there?'), 'the visitor writes');
    await first.inbox.expectMessage('Anyone there?');
    await expect(second.chatRow(ulid)).toContainText('Anyone there?');

    // A reload keeps everything: the list, the open chat, the status.
    await secondPage.reload();
    await expect(second.chatRow(ulid)).toBeVisible();
    await expect(second.tid('presence-select')).toHaveValue('online');

    await first.page.reload();
    await expect(first.inbox.conversation).toBeVisible();
    await first.inbox.expectMessage('Anyone there?');
    await showList(first);
    await expect(first.inbox.chatRow(ulid)).toBeVisible();

    expect(
        await expectEventually(
            async () =>
                must<{ assignedAgent: { id: number } }>(
                    await first.api.conversation(ulid),
                    'read',
                ),
            (conversation) =>
                conversation.assignedAgent.id === world.agents.ann.id,
        ),
    ).toBeTruthy();

    await api.dispose();
});
