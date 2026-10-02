import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import { runSweep } from '../support/chat-db';
import {
    agePresenceRecord,
    readMirrorRow,
    readPresenceRecord,
    watchChannelAuths,
} from '../support/presence';
import {
    cleanRedis,
    redisAliveScore,
    redisAvailable,
    redisKeys,
    redisPresenceHash,
    redisPresenceTtl,
} from '../support/redis';
import { expectEventually } from '../support/wait';
import { createWorld } from '../support/world';
import type { StaffActor } from '../support/actors';

/**
 * The presence rules on the REDIS store (docs/realtime.md, "Storage"): the live state is one hash per agent plus a sorted set of last
 * heartbeats in Redis (database index 13, key prefix `e2e-p5-<port>-`, nothing else is touched), the `agent_presence` row is only a mirror
 * written when the EFFECTIVE status changes, the sweep walks the sorted set and the mirror, a record dies 180 s after its last sign of life,
 * and a Redis that lost its keys is noticed by the sweep. The scenario belongs to this file alone, so the figures of a sweep are exact.
 * Skipped cleanly when no Redis answers on 127.0.0.1:6379 (or `redis-cli` is missing).
 */
test.use({ scenario: 'p5-presence-redis' });

let redisUp = false;

test.beforeAll(async () => {
    redisUp = await redisAvailable();
});

test.beforeEach(({ instance }) => {
    test.skip(
        !redisUp,
        'No Redis answers on 127.0.0.1:6379 (or redis-cli is missing)',
    );
    expect(instance.redis?.db).toBe(13);
});

const statusOf = async (agent: StaffActor): Promise<string> =>
    must<{ status: string }>(await agent.api.presence(), 'presence').status;

const epoch = (): number => Math.floor(Date.now() / 1000);

test('the live state is a Redis hash with a 180 s life and an entry in the sorted set; the table is only a mirror, written when the effective status changes', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const id = world.agents.ann.id;
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });

    expect(await redisPresenceHash(instance, id)).toEqual({});

    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');

    // One hash under the instance's own prefix, with the fields the docs list.
    const hash = await expectEventually(
        () => redisPresenceHash(instance, id),
        (value) => value.announced === 'online',
        { message: 'the hash of the agent' },
    );

    expect(Object.keys(hash).sort()).toEqual(
        [
            'announced',
            'last_heartbeat_at',
            'last_seen_at',
            'last_visible_at',
            'manual',
            'status',
            'visible',
        ].sort(),
    );
    expect(hash).toMatchObject({ status: 'online', manual: '0', visible: '1' });
    expect(Math.abs(epoch() - Number(hash.last_heartbeat_at))).toBeLessThan(30);

    // It lives twice the heartbeat window (2 x 90 s) and sits in the sorted set `presence:alive`, scored by the last heartbeat.
    const ttl = await redisPresenceTtl(instance, id);

    expect(ttl).toBeGreaterThan(100);
    expect(ttl).toBeLessThanOrEqual(180);
    expect(await redisAliveScore(instance, id)).toBe(
        Number(hash.last_heartbeat_at),
    );
    expect(
        (await redisKeys(instance)).every((key) =>
            key.startsWith(instance.redis!.prefix),
        ),
    ).toBe(true);

    // The mirror was written by the change (Offline -> Online) ...
    const mirror = await readMirrorRow(instance, id);

    expect(mirror).toMatchObject({
        status: 'online',
        effective_status: 'online',
    });

    // ... and a plain heartbeat costs no SQL: Redis moves on, the mirror row stays exactly as it was.
    await expectEventually(
        async () => {
            must(await ann.api.heartbeat(true), 'a beat');

            return Number(
                (await redisPresenceHash(instance, id)).last_heartbeat_at,
            );
        },
        (beat) => beat > Number(hash.last_heartbeat_at),
        { message: 'the heartbeat moved on in Redis', intervals: [300] },
    );
    expect(await readMirrorRow(instance, id)).toEqual(mirror);

    await runSweep(instance, 'chat:presence-sweep');
});

test('auto-away and the pinned statuses on Redis: the hidden window is read from the hash, a visible beat brings the agent back, a pinned status never moves', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });
    const ben = await actors.account(world.agents.ben, { open: '/inbox' });

    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');

    // Six hidden minutes (the window is five) with fresh beats: Away by itself. The sweep reports exactly this one change.
    await agePresenceRecord(instance, world.agents.ann.id, {
        heartbeat: 5,
        visible: 6 * 60,
    });
    expect(
        (await readPresenceRecord(instance, world.agents.ann.id)).effective,
    ).toBe('away');

    const output = await runSweep(instance, 'chat:presence-sweep');

    expect(output).toMatch(
        /Checked \d+ agent\(s\): 1 change\(s\) \(0 offline, 1 away, 0 online\)\./,
    );
    await expect(ann.inbox.tid('presence-select')).toHaveValue('away');
    expect(
        (await redisPresenceHash(instance, world.agents.ann.id)).announced,
    ).toBe('away');
    expect(await readMirrorRow(instance, world.agents.ann.id)).toMatchObject({
        effective_status: 'away',
    });

    // A second sweep finds nothing to announce.
    expect(await runSweep(instance, 'chat:presence-sweep')).toContain(
        '0 change(s)',
    );

    // A visible beat: Online again, announced, the selector follows.
    must(await ann.api.heartbeat(true), 'a visible beat');
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    expect(
        (await redisPresenceHash(instance, world.agents.ann.id)).announced,
    ).toBe('online');

    // Ben pins Online (no `automatic`): hours of hidden beats and a sweep never move him.
    must(await ben.api.setPresence('online'), 'pinned online');
    expect(
        (await redisPresenceHash(instance, world.agents.ben.id)).manual,
    ).toBe('1');
    must(await ben.api.heartbeat(false), 'a hidden beat');
    await agePresenceRecord(instance, world.agents.ben.id, {
        heartbeat: 5,
        visible: 3 * 60 * 60,
    });
    await runSweep(instance, 'chat:presence-sweep');
    expect(await statusOf(ben)).toBe('online');

    // Away pinned stays Away in the foreground; Offline stays Offline whatever beats come.
    must(await ben.api.setPresence('away'), 'pinned away');
    must(await ben.api.heartbeat(true), 'a visible beat');
    expect(await statusOf(ben)).toBe('away');
    must(await ben.api.setPresence('offline'), 'offline');
    must(await ben.api.heartbeat(true), 'a beat while offline');
    expect(await statusOf(ben)).toBe('offline');
    expect(await redisAliveScore(instance, world.agents.ben.id)).toBeNull();
});

test('silence: 90 s without a heartbeat is Offline (the sweep finds the agent in the sorted set), a late beat inside the 180 s life revives the record, a later one does not', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const id = world.agents.ann.id;
    const admin = await actors.staff('admin', { open: '/agents' });
    const dot = admin.page.getByTestId(`agent-presence-${id}`);
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });

    await ann.inbox.tid('presence-go-online').click();
    await expect(dot).toHaveAttribute('data-status', 'online');

    // The tab is gone for 100 s (past the window, inside the life): Offline for everybody who asks, announced by the sweep.
    await agePresenceRecord(instance, id, { heartbeat: 100, visible: 100 });
    expect((await readPresenceRecord(instance, id)).effective).toBe('offline');
    expect(await runSweep(instance, 'chat:presence-sweep')).toMatch(
        /Checked \d+ agent\(s\): 1 change\(s\) \(1 offline, 0 away, 0 online\)\./,
    );
    await expect(dot).toHaveAttribute('data-status', 'offline');

    // The tab only slept: its next beat (100 s old record, inside the 180 s life) brings her back, announced.
    must(await ann.api.heartbeat(true), 'the wake-up beat');
    await expect(dot).toHaveAttribute('data-status', 'online');
    expect((await readPresenceRecord(instance, id)).effective).toBe('online');

    // Silent for 200 s (past the 180 s life): the record is forgotten, so a late beat cannot revive it. She has to choose Online again.
    await agePresenceRecord(instance, id, { heartbeat: 200, visible: 200 });
    await runSweep(instance, 'chat:presence-sweep');
    await expect(dot).toHaveAttribute('data-status', 'offline');
    must(await ann.api.heartbeat(true), 'a beat after the life was over');
    expect(await statusOf(ann)).toBe('offline');
    expect(await redisPresenceHash(instance, id)).toEqual({});
    expect(await redisAliveScore(instance, id)).toBeNull();

    // Going online again starts a fresh record.
    await ann.page.reload();
    await ann.inbox.tid('presence-go-online').click();
    await expect(dot).toHaveAttribute('data-status', 'online');
    expect((await redisPresenceHash(instance, id)).status).toBe('online');
});

test("Redis loses its keys (a restart, a flush of the suite's prefix): everybody reads Offline, the sweep announces it from the mirror, and one click brings an agent back", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const id = world.agents.ann.id;
    const admin = await actors.staff('admin', { open: '/agents' });
    const dot = admin.page.getByTestId(`agent-presence-${id}`);
    const ann = await actors.account(world.agents.ann, { open: '/inbox' });

    await ann.inbox.tid('presence-go-online').click();
    await expect(dot).toHaveAttribute('data-status', 'online');

    // The suite's own keys vanish (only this instance's prefix is ever deleted).
    expect(await cleanRedis(instance)).toBeGreaterThan(0);
    expect(await redisKeys(instance)).toEqual([]);

    // Nothing in Redis: reads say Offline. The mirror still says "announced online", so the dashboards of the others still show a green dot ...
    expect(await statusOf(ann)).toBe('offline');
    await expect(dot).toHaveAttribute('data-status', 'online');

    // ... until the sweep (it walks the mirror, not only Redis) announces the agent Redis lost.
    await runSweep(instance, 'chat:presence-sweep');
    await expect(dot).toHaveAttribute('data-status', 'offline');
    expect(await readMirrorRow(instance, id)).toMatchObject({
        effective_status: 'offline',
    });

    // A beat does not revive a record that is gone; "Go online" does.
    must(await ann.api.heartbeat(true), 'a beat');
    expect(await statusOf(ann)).toBe('offline');
    await ann.page.reload();
    await ann.inbox.tid('presence-go-online').click();
    await expect(dot).toHaveAttribute('data-status', 'online');
});

test('the agents page counts who is online and follows live; a whole shift going online at once is atomic in Redis (no lost or doubled change)', async ({
    actors,
    adminApi,
    instance,
}) => {
    const labels = ['a', 'b', 'c', 'd', 'e', 'f'];
    const world = await createWorld(adminApi, instance, {
        agents: Object.fromEntries(labels.map((label) => [label, ['main']])),
    });
    const admin = await actors.staff('admin', { open: '/agents' });
    const count = admin.page.getByTestId('agents-online-count');
    const agents = await Promise.all(
        labels.map((label) => actors.account(world.agents[label])),
    );
    const read = async (): Promise<number> =>
        Number(/\d+/.exec((await count.textContent()) ?? '')?.[0] ?? NaN);

    // The page loaded before this test's agents existed: its figure is the baseline, and only live events move it from here. They
    // only reach it once it has subscribed to its three channels (staff, roster, admin).
    const channels = watchChannelAuths(admin.page);

    await admin.page.reload();
    await expect(count).toBeVisible();
    await expect.poll(() => channels.count()).toBeGreaterThanOrEqual(3);

    const before = await read();

    const results = await Promise.all(
        agents.map((agent) =>
            agent.api.setPresence('online', { automatic: true }),
        ),
    );

    expect(results.map((result) => result.status)).toEqual(
        labels.map(() => 200),
    );
    await expect.poll(read).toBe(before + labels.length);

    for (const label of labels) {
        await expect(
            admin.page.getByTestId(`agent-presence-${world.agents[label].id}`),
        ).toHaveAttribute('data-status', 'online');
    }

    // One of them goes offline: the count drops by one, still live.
    must(await agents[0].api.setPresence('offline'), 'offline');
    await expect.poll(read).toBe(before + labels.length - 1);

    // Every hash was written once, whole: one `announced` each, no half-made record.
    for (const label of labels.slice(1)) {
        expect(
            await redisPresenceHash(instance, world.agents[label].id),
        ).toMatchObject({ status: 'online', manual: '0', announced: 'online' });
    }
});
