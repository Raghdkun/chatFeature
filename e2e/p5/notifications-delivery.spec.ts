import { expect, test as base } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import {
    countSubscriptions,
    endpointHash,
    prepareBrowser,
    pushDevices,
} from '../support/notify';
import {
    agePresenceRecord,
    installVisibilityControl,
    setVisibility,
} from '../support/presence';
import {
    checkVapid,
    FakePushService,
    FakeSubscription,
    ServiceWorkerDriver,
} from '../support/push';
import { readMessages } from '../support/staff-ui';
import { openUserMenu } from '../support/portal';
import { expectEventually } from '../support/wait';
import { createWorld, type World } from '../support/world';
import type { Actors, StaffActor } from '../support/actors';
import type { Api } from '../support/api';
import type { Instance } from '../support/scenarios';

/**
 * Web push for real, server side: the real server posts to a FAKE push service (an https server the spec runs on the scenario's push port; the
 * server's PHP trusts its throw-away certificate, see e2e/support/push-trust.ts) and the spec holds the receiving end of the subscriptions,
 * so it can DECRYPT what was sent (RFC 8291) and check the VAPID header (RFC 8292). What the product promises in docs/notifications.md is then
 * checked on the wire: who is pushed (an offered agent who is not looking at the dashboard; never one who is), what the push says (tag, title,
 * body, TTL, urgency, the path to open), which pushes are silent dismissals and who gets them, the throttle, the switches, quiet hours, previews,
 * a push service that has forgotten the browser (410), and signing out. The last test hands a pushed message to the real service worker.
 * The whole file is one server-wide user of the push port: tests run one after the other.
 */
const test = base.extend<{ service: FakePushService }>({
    service: async ({ instance }, use) => {
        const service = await FakePushService.start(instance);

        await use(service);
        await service.stop();
    },
});

test.use({ scenario: 'p5-notify' });

type Rig = { actors: Actors; adminApi: Api; instance: Instance };

const register = async (
    agent: StaffActor,
    subscription: FakeSubscription,
): Promise<void> => {
    must(
        await agent.api.api.post(
            '/api/v1/me/push-subscriptions',
            subscription.toJSON(),
        ),
        `${agent.name} registers a browser`,
    );
};

/** Online (pinned) and NOT looking at the dashboard: the last beat that reported a visible tab is two minutes old. */
const awayFromTheDashboard = async (
    rig: Rig,
    world: World,
    label: string,
): Promise<void> => {
    await agePresenceRecord(rig.instance, world.agents[label].id, {
        heartbeat: 5,
        visible: 120,
    });
};

type Team = {
    world: World;
    ann: StaffActor;
    ben: StaffActor;
    annSub: FakeSubscription;
    benSub: FakeSubscription;
};

/** Ann and Ben serve the same topic, both online and with a registered browser; Ann is away from the dashboard, Ben is looking at it. */
async function team(rig: Rig, service: FakePushService): Promise<Team> {
    const world = await createWorld(rig.adminApi, rig.instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await rig.actors.account(world.agents.ann, {
        presence: 'online',
    });
    const ben = await rig.actors.account(world.agents.ben, {
        presence: 'online',
    });
    const annSub = service.subscribe();
    const benSub = service.subscribe();

    await register(ann, annSub);
    await register(ben, benSub);
    await awayFromTheDashboard(rig, world, 'ann');

    return { world, ann, ben, annSub, benSub };
}

async function startChat(
    rig: Rig,
    world: World,
    name: string,
    message?: string,
): Promise<{ api: VisitorApi; ulid: string }> {
    const api = await VisitorApi.start(rig.instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await api.startChat({
            category: world.categories.main.slug,
            name,
            ...(message ? { message } : {}),
        }),
        `${name} starts a chat`,
    );

    return { api, ulid };
}

const pushesTo = (service: FakePushService, subscription: FakeSubscription) =>
    service.messagesFor(subscription);

test("the test notification is delivered: the page says sent, the push service got a VAPID-signed, encrypted message that the browser's keys open", async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const subscription = service.subscribe();

    await prepareBrowser(ann, { subscription });
    await ann.page.goto('/settings/notifications');
    await ann.page.getByTestId('notifications-enable').click();
    await expect(ann.page.getByTestId('notifications-test')).toBeVisible();
    await ann.page.getByTestId('notifications-test').click();
    await expect(
        ann.page.getByTestId('notifications-test-result'),
    ).toContainText(
        'Test notification sent. It should appear in a few seconds.',
    );

    const [request] = service.requestsFor(subscription);

    expect(service.requestsFor(subscription)).toHaveLength(1);
    expect(request.method).toBe('POST');
    expect(request.headers['content-encoding']).toBe('aes128gcm');
    expect(request.headers.ttl).toBe('120');
    expect(request.headers.urgency).toBe('high');
    expect(String(request.headers.topic)).toMatch(/^[A-Za-z0-9_-]{1,32}$/);

    // The VAPID header: the instance's key, a valid signature, the push service as audience, a subject, expiring within a day.
    const claims = checkVapid(request, instance);

    // (The library names the audience by scheme and host; a push service on another port is the test's own doing.)
    expect(claims.aud).toBe('https://127.0.0.1');
    expect(claims.sub).toBe('mailto:e2e@example.test');
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    expect(claims.exp).toBeLessThanOrEqual(Date.now() / 1000 + 24 * 3600);

    // Only the holder of the browser's private key can read it: and it is exactly the documented payload, with no ids or addresses in it.
    const payload = subscription.decrypt(request.body);

    expect(payload).toEqual({
        v: 1,
        title: 'Test notification',
        body: 'Notifications work on this device.',
        renotify: true,
        requireInteraction: false,
        data: {
            url: '/settings/notifications',
            tag: `test-${world.agents.ann.id}`,
            type: 'test',
        },
    });
    expect(request.body.toString('utf8')).not.toContain('Test notification');
    expect(request.body.toString('utf8')).not.toContain(world.agents.ann.email);

    // The delivery is remembered on the device row, and the list says so after the page reloads it.
    await expectEventually(
        () => pushDevices(ann),
        (devices) => devices.length === 1 && devices[0].lastUsedAt !== null,
        { message: 'the device was marked as notified' },
    );
    await ann.page.reload();
    await expect(
        ann.page.getByTestId('notifications-device').first(),
    ).toContainText('Last notified');
});

test('a push service that has forgotten the browser (410, 404) removes the subscription; one that is down (5xx) keeps it; both are failures on the page, never "sent"', async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { gone: ['main'], down: ['main'] },
    });
    const gone = await actors.account(world.agents.gone);
    const down = await actors.account(world.agents.down);
    const goneSub = service.subscribe();
    const downSub = service.subscribe();

    await prepareBrowser(gone, { subscription: goneSub });
    await prepareBrowser(down, { subscription: downSub });

    for (const [agent, subscription] of [
        [gone, goneSub],
        [down, downSub],
    ] as const) {
        await agent.page.goto('/settings/notifications');
        await agent.page.getByTestId('notifications-enable').click();
        await expect(
            agent.page.getByTestId('notifications-test'),
        ).toBeVisible();
        expect(await pushDevices(agent)).toHaveLength(1);
        void subscription;
    }

    service.answer(goneSub, 410);
    service.answer(downSub, 503);

    await gone.page.getByTestId('notifications-test').click();
    await expect(
        gone.page.getByTestId('notifications-test-result'),
    ).toContainText('The push service did not accept the notification.');
    // The row is gone on the server and the page's list was refreshed after the test.
    expect(await countSubscriptions(instance, world.agents.gone.id)).toBe(0);
    await expect(
        gone.page.getByTestId('notifications-devices-empty'),
    ).toBeVisible();

    await down.page.getByTestId('notifications-test').click();
    await expect(
        down.page.getByTestId('notifications-test-result'),
    ).toContainText('The push service did not accept the notification.');
    expect(await countSubscriptions(instance, world.agents.down.id)).toBe(1);
});

test("an offer is pushed to the agent who is not looking, with the topic and the visitor's first words, the right tag, urgency and a TTL of the time left; the agent who is looking gets nothing", async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, annSub, benSub } = await team(rig, service);
    // Ben has just been looking at the dashboard: a visible beat.
    must(
        await (await actors.account(world.agents.ben)).api.heartbeat(true),
        'Ben looks',
    );

    const { api, ulid } = await startChat(
        rig,
        world,
        'Offer Olga',
        'Where is my order 4411?',
    );

    expect(service.requestsFor(benSub)).toHaveLength(0);

    const [request] = service.requestsFor(annSub);

    expect(service.requestsFor(annSub)).toHaveLength(1);
    expect(request.headers.urgency).toBe('high');

    const ttl = Number(request.headers.ttl);

    // The offer lives 45 s (the seeded queue timeout): the push service keeps it for what is left of that, no longer.
    expect(ttl).toBeGreaterThan(20);
    expect(ttl).toBeLessThanOrEqual(45);
    checkVapid(request, instance);

    expect(annSub.decrypt(request.body)).toEqual({
        v: 1,
        title: 'New chat request',
        body: `${world.categories.main.name} - Where is my order 4411?`,
        renotify: false,
        requireInteraction: true,
        data: { url: `/inbox/${ulid}`, tag: `offer-${ulid}`, type: 'offer' },
    });

    // Somebody takes it: the notification must disappear from the device that was told about it, and only from that one.
    must(
        await (await actors.account(world.agents.ben)).api.claim(ulid),
        'Ben takes the chat',
    );

    const sent = pushesTo(service, annSub);

    expect(sent).toHaveLength(2);
    expect(sent[1]).toEqual({
        v: 1,
        data: { url: '/inbox', tag: `offer-${ulid}`, type: 'dismiss' },
    });
    expect(service.requestsFor(annSub)[1].headers.urgency).toBe('high');
    expect(service.requestsFor(benSub)).toHaveLength(0);

    await api.dispose();
});

test('messages: the agent who handles the chat and is not looking gets ONE push per burst (tag chat-<ulid>, renotify), reading the chat dismisses it, and a nobody-handles chat pushes no message', async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann, annSub } = await team(rig, service);
    const { api, ulid } = await startChat(rig, world, 'Message Mia');

    must(await ann.api.claim(ulid), 'Ann takes the chat');
    // Taking the chat counted as a look at the dashboard: she goes away from it again.
    await awayFromTheDashboard(rig, world, 'ann');

    const before = service.requestsFor(annSub).length;

    for (const text of ['One', 'Two', 'Three']) {
        must(await api.send(ulid, text), `visitor says ${text}`);
    }

    // Three messages in a row, one notification: the first, and the throttle (8 s per chat and agent) swallows the rest.
    const pushes = pushesTo(service, annSub).slice(before);

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toEqual({
        v: 1,
        title: 'New message from Message Mia',
        body: 'One',
        renotify: true,
        requireInteraction: false,
        data: { url: `/inbox/${ulid}`, tag: `chat-${ulid}`, type: 'message' },
    });
    expect(service.requestsFor(annSub)[before].headers.urgency).toBe('normal');
    expect(service.requestsFor(annSub)[before].headers.ttl).toBe('900');

    // She reads the chat on another device: the notification of this one is dismissed.
    const messages = await readMessages(ann, ulid);
    const last = Math.max(...messages.map((message) => message.seq));

    must(
        await ann.api.receipts(ulid, { seen_upto: last }),
        'Ann reads the chat',
    );

    const after = pushesTo(service, annSub).slice(before);

    expect(after).toHaveLength(2);
    expect(after[1]).toEqual({
        v: 1,
        data: { url: '/inbox', tag: `chat-${ulid}`, type: 'dismiss' },
    });

    await api.dispose();
});

test('previews off, quiet hours, and the two push switches: each keeps a push from being sent, and previews off keeps every word of the visitor off the wire', async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann, annSub } = await team(rig, service);
    const settings = async (body: Record<string, unknown>) =>
        must(
            await ann.api.api.put('/api/v1/me/notification-settings', body),
            'settings',
        );
    const at = (hours: number): string => {
        const moment = new Date(Date.now() + hours * 3_600_000);

        return `${String(moment.getUTCHours()).padStart(2, '0')}:${String(moment.getUTCMinutes()).padStart(2, '0')}`;
    };

    // Previews off for this member: the offer says the topic only, a message says only "New message".
    await settings({ include_preview: false });

    const first = await startChat(
        rig,
        world,
        'Private Pia',
        'My card number is secret',
    );

    const offer = service.messagesFor(annSub);

    expect(offer).toHaveLength(1);
    expect(offer[0].body).toBe(world.categories.main.name);
    expect(JSON.stringify(offer[0])).not.toContain('Pia');
    expect(JSON.stringify(offer[0])).not.toContain('secret');

    must(await ann.api.claim(first.ulid), 'Ann takes the chat');
    await awayFromTheDashboard(rig, world, 'ann');
    must(await first.api.send(first.ulid, 'More secret words'), 'a message');

    const message = service.messagesFor(annSub).at(-1)!;

    expect(message.data.type).toBe('message');
    expect(message.title).toBe('New message');
    expect(message.body).toBe('Open the chat to read it.');
    expect(JSON.stringify(message)).not.toContain('secret');
    expect(JSON.stringify(message)).not.toContain('Pia');
    must(await ann.api.end(first.ulid), 'the chat ends');

    // Quiet hours around now: no push for the next request (the toast and the sound are the page's business).
    await settings({ include_preview: true });
    await settings({
        quiet_hours: {
            enabled: true,
            start: at(-1),
            end: at(1),
            timezone: 'UTC',
        },
    });
    await awayFromTheDashboard(rig, world, 'ann');

    const count = service.requestsFor(annSub).length;
    const quiet = await startChat(rig, world, 'Quiet Quin');

    expect(service.requestsFor(annSub)).toHaveLength(count);

    // The window ends: the next request is pushed again.
    await settings({ quiet_hours: { enabled: false } });
    await awayFromTheDashboard(rig, world, 'ann');

    const loud = await startChat(rig, world, 'Loud Lou');

    expect(service.requestsFor(annSub)).toHaveLength(count + 1);
    expect(service.messagesFor(annSub).at(-1)!.data.tag).toBe(
        `offer-${loud.ulid}`,
    );

    // The switches: offers off = no offer push (an offer for a chat that is already queued is not pushed afterwards either) ...
    await settings({ push_offers: false });

    const none = await startChat(rig, world, 'Switch Sue');

    expect(service.requestsFor(annSub)).toHaveLength(count + 1);
    await settings({ push_offers: true, push_messages: false });

    // ... and messages off = a chat Ann handles is silent: claim, away, the visitor writes.
    must(await ann.api.claim(loud.ulid), 'Ann takes the chat');
    await awayFromTheDashboard(rig, world, 'ann');

    const beforeMessage = service.requestsFor(annSub).length;

    must(await loud.api.send(loud.ulid, 'Anyone?'), 'a message');
    expect(service.requestsFor(annSub)).toHaveLength(beforeMessage);

    await Promise.all([
        first.api.dispose(),
        quiet.api.dispose(),
        loud.api.dispose(),
        none.api.dispose(),
    ]);
});

test("signing out takes that session's browser registration with it; another browser of the same member keeps its own", async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const first = await actors.account(world.agents.ann);
    const second = await actors.account(world.agents.ann);
    const firstSub = service.subscribe();
    const secondSub = service.subscribe();

    await prepareBrowser(first, {
        subscription: firstSub,
        permission: 'granted',
    });
    await first.page.goto('/inbox');
    await expect(first.page.getByTestId('inbox')).toBeVisible();
    await register(second, secondSub);

    // The granted permission makes the page register its browser by itself (no dialog, no click).
    await expectEventually(
        () => pushDevices(first),
        (devices) =>
            devices.some(
                (device) =>
                    device.endpointHash === endpointHash(firstSub.endpoint),
            ),
        { message: 'the first browser registered itself' },
    );
    expect(await countSubscriptions(instance, world.agents.ann.id)).toBe(2);

    // The first browser's person signs out from the user menu.
    await openUserMenu(first.page);
    await first.page.locator('[data-test="logout-button"]').click();
    await expect(first.page).toHaveURL(/\/login/);

    // That session's registration is gone from the server (the browser's own subscription stays with the browser: the next member who
    // signs in there registers it for themselves, which is the point of deleting the old row).
    expect(await countSubscriptions(instance, world.agents.ann.id)).toBe(1);

    // The other browser (another session) is still registered and still receives pushes.
    const devices = await pushDevices(second);

    expect(devices).toHaveLength(1);
    expect(devices[0].endpointHash).toBe(endpointHash(secondSub.endpoint));
});

test('the whole chain: a chat request is pushed by the server, the fake push service receives it, and the real service worker shows it from that very payload; the dismiss closes it again', async ({
    actors,
    adminApi,
    instance,
    service,
}) => {
    const rig = { actors, adminApi, instance };
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const subscription = service.subscribe();

    // Ann's browser: the real notification permission and worker, her tab in the background, the subscription registered by the page itself.
    await ann.context.grantPermissions(['notifications'], {
        origin: instance.url,
    });
    await prepareBrowser(ann, { permission: 'real', subscription });
    await installVisibilityControl(ann.context);
    await ann.inbox.goto();

    const driver = await ServiceWorkerDriver.attach(ann.page, instance);

    await driver.ready();
    await expectEventually(
        () => pushDevices(ann),
        (devices) => devices.length === 1,
        { message: 'the page registered its subscription' },
    );
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await setVisibility(ann.page, 'hidden');
    await awayFromTheDashboard(rig, world, 'ann');

    const { api, ulid } = await startChat(
        rig,
        world,
        'Chain Cleo',
        'Is this thing on?',
    );

    // The server pushed, the service received it ...
    const [offer] = service.messagesFor(subscription);

    expect(offer.data).toEqual({
        url: `/inbox/${ulid}`,
        tag: `offer-${ulid}`,
        type: 'offer',
    });

    // ... and the worker turns exactly that payload into the notification the agent sees.
    await driver.deliver(offer);

    const [shown] = await expectEventually(
        () => driver.notifications(`offer-${ulid}`),
        (list) => list.length === 1,
        { message: 'the worker showed the pushed offer' },
    );

    expect(shown).toMatchObject({
        title: 'New chat request',
        body: `${world.categories.main.name} - Is this thing on?`,
        requireInteraction: true,
        data: { url: `/inbox/${ulid}`, type: 'offer' },
    });

    // Ben takes the chat: the server's silent dismiss, delivered to the worker, closes the notification.
    must(await ben.api.claim(ulid), 'Ben takes the chat');

    const sent = service.messagesFor(subscription);

    expect(sent).toHaveLength(2);
    await driver.deliver(sent[1]);
    await expectEventually(
        () => driver.notifications(),
        (list) => list.length === 0,
        { message: 'the dismiss closed the notification' },
    );

    await api.dispose();
});
