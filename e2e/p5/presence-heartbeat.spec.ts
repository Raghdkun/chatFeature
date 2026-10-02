import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import { runSweep } from '../support/chat-db';
import {
    agePresenceRecord,
    installVisibilityControl,
    readPresenceRecord,
    recordHeartbeats,
    setVisibility,
} from '../support/presence';
import { createWorld, type World } from '../support/world';
import type { Actors, StaffActor } from '../support/actors';

/**
 * P5 presence, the dashboard's side (database store; the Redis twin is `presence-redis.spec.ts`): the 30 s heartbeat says whether the tab
 * is in front, an agent who chose Online (the automatic status) turns Away by themselves after the hidden window and back with the next
 * visible beat, a status they pinned is never moved, and the selector explains it. Each test has its own world (own agents), because
 * presence is global to the scenario. Time moves by hand: the stored timestamps are aged (`agePresenceRecord`), then the sweep runs.
 */
test.use({ scenario: 'p5-chat' });

const statusOf = async (agent: StaffActor): Promise<string> =>
    must<{ status: string }>(await agent.api.presence(), 'presence').status;
const isManualOf = async (agent: StaffActor): Promise<boolean> =>
    must<{ isManual: boolean }>(await agent.api.presence(), 'presence')
        .isManual;

/** An agent with the dashboard open, a controllable tab visibility and a page clock, signed in and Online (automatic) through the selector. */
async function openAsAutomaticOnline(
    rig: { actors: Actors; world: World },
    label = 'ann',
) {
    const agent = await rig.actors.account(rig.world.agents[label]);

    await installVisibilityControl(agent.context);
    await agent.page.clock.install();

    const beats = recordHeartbeats(agent.page);

    await agent.inbox.goto();
    await expect(agent.inbox.tid('presence-select')).toHaveValue('offline');
    await agent.inbox.tid('presence-go-online').click();
    await expect(agent.inbox.tid('presence-select')).toHaveValue('online');
    // The server has it (a stored record exists for the helpers that age it).
    await expect.poll(() => statusOf(agent)).toBe('online');

    return { agent, beats };
}

test('the heartbeat says whether the tab is in front: visible while it is, hidden after it went to the background, visible again at once on return', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const { agent, beats } = await openAsAutomaticOnline({ actors, world });

    // The first beats (the page load, Go online) were sent from a visible tab.
    await expect.poll(() => beats.count()).toBeGreaterThan(0);
    expect(beats.list.every((beat) => beat.visible === true)).toBe(true);

    // The tab goes to the background: nothing is sent while it sleeps, but the next interval beat says `visible: false`.
    await setVisibility(agent.page, 'hidden');

    const before = beats.count();

    await agent.page.clock.fastForward(31_000);
    await expect.poll(() => beats.count()).toBeGreaterThan(before);
    expect(beats.last()?.visible).toBe(false);

    // Back in front: a visible beat leaves at once (no 30 s wait), and the server remembers it as a visible beat.
    const hiddenBeats = beats.count();

    await setVisibility(agent.page, 'visible');
    await expect.poll(() => beats.count()).toBeGreaterThan(hiddenBeats);
    expect(beats.last()?.visible).toBe(true);

    const stored = await readPresenceRecord(instance, world.agents.ann.id);

    expect(stored.status).toBe('online');
    expect(stored.manual).toBe(false);
    expect(stored.visibleAgo).toBeLessThan(30);
});

test('an agent who stays in the background for the hidden window turns Away by themselves and is Online again with the next visible beat', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const { agent, beats } = await openAsAutomaticOnline({ actors, world });
    const select = agent.inbox.tid('presence-select');

    // The tab sat in the background for six minutes (the window is five): its beats kept coming, none from a visible tab.
    await setVisibility(agent.page, 'hidden');
    await agent.page.clock.fastForward(31_000);
    await expect.poll(() => beats.last()?.visible).toBe(false);
    await agePresenceRecord(instance, world.agents.ann.id, {
        heartbeat: 5,
        visible: 6 * 60,
    });

    // The server already treats them as away (reads compute it), and so does routing...
    expect(await statusOf(agent)).toBe('away');

    // ...and the sweep announces it: the open dashboard's selector follows over the socket.
    const output = await runSweep(instance, 'chat:presence-sweep');

    // The scenario is shared with other specs' agents: the sweep reports on everybody, so the figures are only checked for their shape.
    expect(output).toMatch(
        /Checked \d+ agent\(s\): \d+ change\(s\) \(\d+ offline, \d+ away, \d+ online\)\./,
    );
    await expect(select).toHaveValue('away');
    expect(
        (await readPresenceRecord(instance, world.agents.ann.id)).announced,
    ).toBe('away');

    // The tab comes back to the front: a visible beat, and they are Online again (announced, the selector follows).
    await setVisibility(agent.page, 'visible');
    await expect(select).toHaveValue('online');
    expect(await statusOf(agent)).toBe('online');

    const stored = await readPresenceRecord(instance, world.agents.ann.id);

    expect(stored.status).toBe('online');
    expect(stored.manual).toBe(false);
    expect(stored.announced).toBe('online');
});

test('a status the agent pinned is never moved by heartbeats: Away stays Away in the foreground, Online stays Online in the background, Offline stays Offline', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const id = world.agents.ann.id;

    // Away chosen in the selector is pinned: a visible beat does not make it Online.
    await ann.inbox.goto();
    await ann.inbox.tid('presence-go-online').click();
    // (Each change is confirmed by the server before the next one: two requests in flight are handled by different PHP workers, in any order.)
    await expect.poll(() => statusOf(ann)).toBe('online');
    await ann.inbox.tid('presence-select').selectOption('away');
    await expect.poll(() => statusOf(ann)).toBe('away');
    must(await ann.api.heartbeat(true), 'a visible beat');
    expect(await statusOf(ann)).toBe('away');
    expect((await readPresenceRecord(instance, id)).manual).toBe(true);

    // Online pinned through the API (no `automatic`) survives hours of hidden beats: it never turns Away.
    must(await ann.api.setPresence('online'), 'pinned online');
    expect((await readPresenceRecord(instance, id)).manual).toBe(true);
    must(await ann.api.heartbeat(false), 'a hidden beat');
    await agePresenceRecord(instance, id, {
        heartbeat: 5,
        visible: 3 * 60 * 60,
    });
    expect(await statusOf(ann)).toBe('online');
    await runSweep(instance, 'chat:presence-sweep');
    expect(await statusOf(ann)).toBe('online');

    // Offline is the agent's own choice: a heartbeat never turns it on (only a status change does).
    await ann.inbox.tid('presence-select').selectOption('offline');
    await expect.poll(() => statusOf(ann)).toBe('offline');
    must(await ann.api.heartbeat(true), 'a beat while offline');
    expect(await statusOf(ann)).toBe('offline');
    expect((await readPresenceRecord(instance, id)).status).toBe('offline');
});

test('the selector explains the automatic status, and "Go online" after Offline brings the agent back as automatic', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const select = ann.inbox.tid('presence-select');

    await ann.inbox.goto();

    // Offline: the notice and the one-click way back; no hint about automatic away.
    await expect(select).toHaveValue('offline');
    await expect(ann.inbox.tid('presence-offline-notice')).toBeVisible();
    await expect(ann.inbox.tid('presence-hint')).toHaveCount(0);

    // "Go online" is the automatic Online: the hint says what that means, and the selector is described by it.
    await ann.inbox.tid('presence-go-online').click();
    await expect(select).toHaveValue('online');
    await expect(ann.inbox.tid('presence-offline-notice')).toHaveCount(0);

    const hint = ann.inbox.tid('presence-hint');

    await expect(hint).toBeVisible();
    await expect(hint).toContainText('Away by yourself');
    await expect(select).toHaveAttribute(
        'aria-describedby',
        (await hint.getAttribute('id')) ?? '',
    );
    await expect.poll(() => isManualOf(ann)).toBe(false);

    // Away is a choice, not the automatic status: no hint (the dashboard does not move it), and it is pinned.
    await select.selectOption('away');
    await expect.poll(() => statusOf(ann)).toBe('away');
    await expect(hint).toHaveCount(0);
    await expect.poll(() => isManualOf(ann)).toBe(true);

    // Offline and back: Go online gives the automatic status again (the hint is back, `isManual` is false).
    await select.selectOption('offline');
    await expect(ann.inbox.tid('presence-offline-notice')).toBeVisible();
    // (Each change is confirmed by the server before the next one: two requests in flight are handled by different PHP workers, in any order.)
    await expect.poll(() => statusOf(ann)).toBe('offline');
    await ann.inbox.tid('presence-go-online').click();
    await expect(select).toHaveValue('online');
    await expect(hint).toBeVisible();
    await expect.poll(() => isManualOf(ann)).toBe(false);
});

test('two tabs of one agent: one visible tab keeps them Online, and Away only follows when every tab is in the background', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const id = world.agents.ann.id;

    await installVisibilityControl(ann.context);

    const second = await ann.newPage();
    const firstBeats = recordHeartbeats(ann.page);
    const secondBeats = recordHeartbeats(second);

    await ann.page.clock.install();
    await second.clock.install();
    await ann.inbox.goto();
    await second.goto('/inbox');
    await expect(second.getByTestId('inbox')).toBeVisible();
    // Both tabs are on the staff roster before anything is changed (it arrives with the subscription): an event published before a tab
    // has subscribed is not replayed to it.
    await expect(ann.inbox.tid('roster-toggle')).toBeVisible();
    await expect(second.getByTestId('roster-toggle')).toBeVisible();
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await expect(second.getByTestId('presence-select')).toHaveValue('online');

    // Tab one goes to the background, tab two stays in front. Five hidden minutes of tab one change nothing: tab two keeps beating visible.
    await setVisibility(ann.page, 'hidden');
    await ann.page.clock.fastForward(31_000);
    await expect.poll(() => firstBeats.last()?.visible).toBe(false);
    await second.clock.fastForward(31_000);
    await expect.poll(() => secondBeats.last()?.visible).toBe(true);
    await agePresenceRecord(instance, id, { heartbeat: 5, visible: 60 });

    expect(await statusOf(ann)).toBe('online');

    // Both in the background for longer than the window: away (one beat from each, hidden).
    await setVisibility(second, 'hidden');
    await second.clock.fastForward(31_000);
    await expect.poll(() => secondBeats.last()?.visible).toBe(false);
    await agePresenceRecord(instance, id, { heartbeat: 5, visible: 6 * 60 });
    expect(await statusOf(ann)).toBe('away');

    // Either tab coming back to the front is enough.
    await setVisibility(second, 'visible');
    await expect.poll(() => statusOf(ann)).toBe('online');
});
