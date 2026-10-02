import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { runSweep } from '../support/chat-db';
import {
    agePresenceRecord,
    readPresenceRecord,
    widgetAvailability,
} from '../support/presence';
import { openCustomerSite } from '../support/panel';
import { readAppLog } from '../support/staff-db';
import { expectEventually } from '../support/wait';
import { createWorld } from '../support/world';

/**
 * When Redis is down (docs/realtime.md, "When Redis is down"): this scenario is configured for the Redis store but nothing listens at its
 * Redis address (127.0.0.1:8409), so every presence call must be answered by the database store instead: no 500, no slow request, one
 * warning in the log per PHP process that finds out (then the cooldown keeps Redis alone for 15 s), and everything the product does with
 * presence keeps working: the selector, the heartbeat, routing, the public availability, auto-away and the sweep. No Reverb here: the
 * dashboard runs on REST polling, which is all these tests need. The scenario is shared by both projects (every test has its own world).
 */
test.use({ scenario: 'p5-presence-failover' });

const WARNING =
    'Presence: Redis is unavailable, the database store answers instead.';

/** How many times the instance's log says the database store took over. */
const warnings = async (
    instance: Parameters<typeof readAppLog>[0],
): Promise<number> =>
    (
        (await readAppLog(instance)).match(
            new RegExp(WARNING.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
        ) ?? []
    ).length;

test('with Redis unreachable the dashboard still works: Go online, away, offline, heartbeats and the roster are served by the table, and the log warns about it a few times, not once per call', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const id = world.agents.ann.id;
    const ann = await actors.account(world.agents.ann);
    const failed: string[] = [];

    ann.page.on('response', (response) => {
        if (
            response.url().includes('/api/v1/me/presence') &&
            response.status() >= 400
        ) {
            failed.push(
                `${response.request().method()} ${response.url()} -> ${response.status()}`,
            );
        }
    });

    const before = await warnings(instance);

    await ann.inbox.goto();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('offline');
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');

    // The change is in the table (the fallback store IS the table) and routing sees it.
    expect(await readPresenceRecord(instance, id)).toMatchObject({
        store: 'database',
        status: 'online',
        manual: false,
        effective: 'online',
    });

    await ann.inbox.tid('presence-select').selectOption('away');
    await expect
        .poll(
            async () =>
                must<{ status: string }>(await ann.api.presence(), 'presence')
                    .status,
        )
        .toBe('away');
    await ann.inbox.tid('presence-select').selectOption('online');
    await expect
        .poll(
            async () =>
                must<{ status: string }>(await ann.api.presence(), 'presence')
                    .status,
        )
        .toBe('online');

    // A burst of beats and reads (fifty calls): every answer is a success, and the log is not flooded.
    const answers = await Promise.all(
        Array.from({ length: 25 }, async () => [
            (await ann.api.heartbeat(true)).status,
            (await ann.api.presence()).status,
        ]),
    );

    expect(
        answers.flat().every((status) => status === 204 || status === 200),
    ).toBe(true);
    expect(failed).toEqual([]);

    // Redis is down, so the log has said so (at least once, by whichever request found out first). The cooldown is shared by every request of
    // the server (each boots its own application), so the fifty calls above add a handful of warnings at most, never fifty. The scenario is
    // shared with the other project's tests (their own first call may be the one that logged), hence the total for the first bound.
    expect(await warnings(instance)).toBeGreaterThanOrEqual(1);
    expect((await warnings(instance)) - before).toBeLessThanOrEqual(8);
});

test('routing, availability and the visitor keep working on the table: a chat is offered and claimed, an offline agent means no_agents and the offline form', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const key = world.widget.key;
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });

    // Offline: the widget says so, a chat cannot start, the panel shows the offline form.
    expect((await widgetAvailability(instance, key)).online).toBe(false);

    const visitorApi = await VisitorApi.start(instance, { key });
    const refused = await visitorApi.startChat({
        category: world.categories.main.slug,
        name: 'Early Eve',
    });

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('no_agents');

    const early = await actors.visitor();
    const earlyPanel = await openCustomerSite(early.page, instance, {
        key,
        open: true,
    });

    await earlyPanel.expectState('offline');

    // Online: availability flips (the change dropped the cached answer), a chat starts, the agent is offered it and takes it.
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await expect
        .poll(async () => (await widgetAvailability(instance, key)).online)
        .toBe(true);

    const second = await VisitorApi.start(instance, { key });
    const { ulid } = must<{ ulid: string }>(
        await second.startChat({
            category: world.categories.main.slug,
            name: 'Fallback Fay',
        }),
        'a chat starts on the fallback store',
    );
    const queue = await expectEventually(
        async () =>
            must<{ ulid: string }[]>(await ann.api.queue(), 'the queue'),
        (items) => items.some((item) => item.ulid === ulid),
        { message: 'the offer reached the agent' },
    );

    expect(queue.map((item) => item.ulid)).toContain(ulid);
    must(await ann.api.claim(ulid), 'the agent takes the chat');
    must(await ann.api.end(ulid), 'the agent ends the chat');

    await Promise.all([visitorApi.dispose(), second.dispose()]);
});

test('auto-away and the sweep work on the table too: the hidden window is read from the row, the sweep announces Away and then Offline', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const id = world.agents.ann.id;
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });

    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');

    await agePresenceRecord(instance, id, { heartbeat: 5, visible: 6 * 60 });
    expect((await readPresenceRecord(instance, id)).effective).toBe('away');
    expect(await runSweep(instance, 'chat:presence-sweep')).toMatch(
        /Checked \d+ agent\(s\): \d+ change\(s\) \(\d+ offline, \d+ away, \d+ online\)\./,
    );
    expect((await readPresenceRecord(instance, id)).announced).toBe('away');

    await agePresenceRecord(instance, id, { heartbeat: 100, visible: 100 });
    await runSweep(instance, 'chat:presence-sweep');
    expect(await readPresenceRecord(instance, id)).toMatchObject({
        store: 'database',
        effective: 'offline',
        announced: 'offline',
    });

    // A beat from the tab that only slept: the row is never forgotten on the table, so she is back.
    must(await ann.api.heartbeat(true), 'the wake-up beat');
    expect((await readPresenceRecord(instance, id)).effective).toBe('online');
});
