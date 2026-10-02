import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { runSweep } from '../support/chat-db';
import {
    agePresenceRecord,
    readPresenceRecord,
    widgetAvailability,
} from '../support/presence';
import { createWorld } from '../support/world';
import type { StaffActor } from '../support/actors';

/**
 * P5 presence as the rest of the staff see it (database store; the same rules on Redis are in `presence-redis.spec.ts`): the agents page's
 * status dot and the inbox roster follow `presence.changed` over the websocket, a closed tab turns Offline once its heartbeat is older than
 * 90 s (the sweep announces it and drops the cached public availability), and nobody is offered a chat after that. Every test has its own
 * world: the scenario is shared with other spec files, so no figure is a total of the scenario.
 */
test.use({ scenario: 'p5-chat' });

const dot = (admin: StaffActor, id: number) =>
    admin.page.getByTestId(`agent-presence-${id}`);

test('a status change reaches the other staff at once: the agents page dot and the roster of a colleague follow the selector, and the roster entry leaves with the tab', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = world.agents.ann;
    const admin = await actors.staff('admin', { open: '/agents' });
    const ben = await actors.account(world.agents.ben, { open: '/inbox' });
    const annActor = await actors.account(ann, { open: '/inbox' });

    // The roster of Ben's inbox is the websocket's list of who is signed in: Ann is on it (offline, nobody has chosen a status yet).
    await ben.inbox.tid('roster-toggle').click();

    const rosterEntry = ben.page
        .getByTestId('roster-list')
        .locator('li')
        .filter({ hasText: ann.name });

    await expect(rosterEntry).toContainText('Offline');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'offline');

    // Online: both follow, with no reload.
    await annActor.inbox.tid('presence-go-online').click();
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');
    await expect(dot(admin, ann.id)).toContainText('Online');
    await expect(rosterEntry).toContainText('Online');

    await annActor.inbox.tid('presence-select').selectOption('away');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'away');
    await expect(rosterEntry).toContainText('Away');

    await annActor.inbox.tid('presence-select').selectOption('offline');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'offline');
    await expect(rosterEntry).toContainText('Offline');

    // The same person, online again, and then the tab is closed: the roster loses her at once (the socket closed), while the agents page
    // keeps the status the server last announced (nothing has said she is gone yet: that is the sweep's job, next test).
    await annActor.inbox.tid('presence-select').selectOption('online');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');
    await annActor.close();
    await expect(rosterEntry).toHaveCount(0);
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');
});

test('a closed tab turns Offline after 90 seconds: the sweep announces it once, the dot and the public availability follow, and nobody can be offered a chat', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = world.agents.ann;
    const admin = await actors.staff('admin', { open: '/agents' });
    const annActor = await actors.account(ann, { open: '/inbox' });

    await annActor.inbox.tid('presence-go-online').click();
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');
    expect((await widgetAvailability(instance, world.widget.key)).online).toBe(
        true,
    );

    // The laptop lid closes: the tab is gone and nothing beats any more. A minute and a half later the record is stale but not forgotten.
    await annActor.close();
    await agePresenceRecord(instance, ann.id, { heartbeat: 100, visible: 100 });

    // Reads already say offline (routing sees it too: the start of a chat is refused)...
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const refused = await visitor.startChat({
        category: world.categories.main.slug,
        name: 'Late Lou',
    });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');
    expect((await readPresenceRecord(instance, ann.id)).effective).toBe(
        'offline',
    );

    // ...and the sweep is what tells everybody else: the dot flips (a `presence.changed` event), the announced status is stored, the
    // cached availability was dropped, and a second run finds nothing more to announce for her.
    const output = await runSweep(instance, 'chat:presence-sweep');

    expect(output).toMatch(
        /Checked \d+ agent\(s\): \d+ change\(s\) \(\d+ offline, \d+ away, \d+ online\)\./,
    );
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'offline');
    expect((await readPresenceRecord(instance, ann.id)).announced).toBe(
        'offline',
    );
    expect((await widgetAvailability(instance, world.widget.key)).online).toBe(
        false,
    );

    await runSweep(instance, 'chat:presence-sweep');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'offline');

    await visitor.dispose();
});

test('the agent comes back on the next beat of a tab that is still alive: Offline by silence is not a choice, so a returning tab is Online again', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = world.agents.ann;
    const admin = await actors.staff('admin', { open: '/agents' });
    const annActor = await actors.account(ann, { open: '/inbox' });

    await annActor.inbox.tid('presence-go-online').click();
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');

    // A sleeping laptop: the beats stopped for 100 s and the sweep announced it.
    await agePresenceRecord(instance, ann.id, { heartbeat: 100, visible: 100 });
    await runSweep(instance, 'chat:presence-sweep');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'offline');

    // It wakes up: the next beat (the page's own timer or a manual one) brings her back, announced to everybody.
    must(await annActor.api.heartbeat(true), 'the wake-up beat');
    await expect(dot(admin, ann.id)).toHaveAttribute('data-status', 'online');
    expect((await readPresenceRecord(instance, ann.id)).announced).toBe(
        'online',
    );
});

test('a whole shift going online at the same moment: every first presence write succeeds (no deadlock between new rows)', async ({
    actors,
    adminApi,
    instance,
}) => {
    // Regression for the store's first-write deadlock (MySQL 1213 between two inserts into the unique index of `agent_presence`, a 500 for
    // whoever lost): eight agents who have never had a presence row choose Online in the same instant, three times over, with beats mixed in.
    const labels = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const world = await createWorld(adminApi, instance, {
        agents: Object.fromEntries(labels.map((label) => [label, ['main']])),
    });
    const agents = await Promise.all(
        labels.map((label) => actors.account(world.agents[label])),
    );

    for (let round = 0; round < 3; round += 1) {
        const results = await Promise.all([
            ...agents.map((agent) => agent.api.setPresence('online')),
            ...agents.map((agent) => agent.api.heartbeat(true)),
        ]);

        expect(
            results
                .map((result) => result.status)
                .filter((status) => status >= 500),
        ).toEqual([]);
    }

    for (const label of labels) {
        expect(
            (await readPresenceRecord(instance, world.agents[label].id)).status,
        ).toBe('online');
    }
});
