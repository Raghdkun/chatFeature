import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import {
    endpointHash,
    notificationSettings,
    passPromptDelay,
    prepareBrowser,
    pushDevices,
    recordSubscriptionPosts,
    setNotificationRow,
    watchControllerStart,
} from '../support/notify';
import {
    FakeSubscription,
    permissionRequests,
    pushStubLog,
} from '../support/push';
import { vapidKeys } from '../support/scenarios';
import { createWorld } from '../support/world';

/**
 * The first-login notification flow in a real browser (decision P5-D7): a staff member who was never asked gets an in-app explainer a moment
 * after the dashboard loads, and ONLY its button calls `Notification.requestPermission()`; then the browser subscribes with the server's VAPID
 * key and the subscription is registered. "Not now" (or a browser prompt closed without an answer) snoozes for seven days on the SERVER. Someone
 * who already decided, or whose browser cannot do push, never sees it. Headless Chrome has no push service, so `pushManager.subscribe()` and the
 * permission API are stubbed in the page (e2e/support/push.ts); everything else, the server included, is real.
 */
test.use({ scenario: 'p5-notify' });

const dialog = (page: import('@playwright/test').Page) =>
    page.getByTestId('notification-prompt');

test('a never-asked agent gets the explainer after the dashboard loads; only its button asks the browser, then the browser is subscribed and registered', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const subscription = FakeSubscription.dead();

    await prepareBrowser(ann, { subscription });

    const posts = recordSubscriptionPosts(ann.page);

    await ann.inbox.goto();

    // The dialog opens by itself (1.5 s after the settings loaded) and nothing has been asked of the browser yet.
    await expect(dialog(ann.page)).toBeVisible({ timeout: 15_000 });
    await expect(
        dialog(ann.page).getByRole('heading', {
            name: 'Get notified of new chats',
        }),
    ).toBeVisible();
    expect(await permissionRequests(ann.page)).toBe(0);
    expect((await pushStubLog(ann.page)).subscribed).toBe(0);
    expect(posts.count()).toBe(0);
    expect((await notificationSettings(ann)).promptState).toBe('never');

    // The button asks the browser (once), subscribes with the server's key and registers the subscription.
    await dialog(ann.page).getByTestId('notification-prompt-enable').click();
    await expect(dialog(ann.page)).toBeHidden();
    await expect(
        ann.page.getByText('Notifications are on.', { exact: true }),
    ).toBeVisible();
    expect(await permissionRequests(ann.page)).toBe(1);

    const log = await pushStubLog(ann.page);

    expect(log.subscribed).toBe(1);
    expect(log.keys).toEqual([vapidKeys().publicKey]);

    await expect.poll(() => posts.count()).toBe(1);
    expect(posts.list[0].status).toBe(201);
    expect(posts.list[0].body).toMatchObject({
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
    });

    // The server knows it: a device row (never the endpoint itself), and the prompt state says "granted".
    await expect
        .poll(async () => (await notificationSettings(ann)).promptState)
        .toBe('granted');

    const devices = await pushDevices(ann);

    expect(devices).toHaveLength(1);
    expect(devices[0].endpointHash).toBe(endpointHash(subscription.endpoint));
    expect(devices[0].host).toBe('127.0.0.1');
    expect(JSON.stringify(devices)).not.toContain(subscription.p256dh);
    expect(JSON.stringify(devices)).not.toContain(subscription.endpoint);

    // A reload: no dialog again, the browser is not asked again, the same subscription is registered once more (an update, 200).
    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await expect.poll(() => posts.count()).toBe(2);
    expect(posts.list[1].status).toBe(200);
    expect(await permissionRequests(ann.page)).toBe(0);
    await expect(dialog(ann.page)).toHaveCount(0);
    expect(await pushDevices(ann)).toHaveLength(1);
});

test('"Not now" snoozes for seven days on the server: the dialog stays away after a reload, and the browser was never asked', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);

    await prepareBrowser(ann);
    await ann.page.clock.install();

    const posts = recordSubscriptionPosts(ann.page);
    const started = watchControllerStart(ann.page);

    await ann.inbox.goto();
    await passPromptDelay(ann.page, started);
    await expect(dialog(ann.page)).toBeVisible();

    await dialog(ann.page).getByTestId('notification-prompt-later').click();
    await expect(dialog(ann.page)).toBeHidden();

    // The server computed the deadline: seven days from now (not the browser: the clock of this page is a fake one).
    await expect
        .poll(async () => (await notificationSettings(ann)).promptState)
        .toBe('snoozed');

    const settings = await notificationSettings(ann);
    const days = (Date.parse(settings.snoozedUntil!) - Date.now()) / 86_400_000;

    expect(settings.snoozeDays).toBe(7);
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThan(7.01);
    expect(settings.promptedAt).not.toBeNull();
    expect(await permissionRequests(ann.page)).toBe(0);
    expect(posts.count()).toBe(0);

    // Reload: the snooze holds, nothing opens.
    const restarted = watchControllerStart(ann.page);

    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await passPromptDelay(ann.page, restarted);
    await expect(dialog(ann.page)).toHaveCount(0);
    expect(await permissionRequests(ann.page)).toBe(0);
});

test('when the snooze has run out the dialog comes back; someone who already decided (granted, denied, or still snoozed) never sees it on page load', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: {
            snoozed: ['main'],
            expired: ['main'],
            granted: ['main'],
            denied: ['main'],
        },
    });
    const open = async (label: keyof typeof world.agents) => {
        const agent = await actors.account(world.agents[label]);

        await prepareBrowser(agent);
        await agent.page.clock.install();

        const started = watchControllerStart(agent.page);

        await agent.inbox.goto();
        await passPromptDelay(agent.page, started);

        return agent;
    };

    // Snoozed for a week from now, snoozed in the past, granted, denied: set through the API where it can be, and the clock where it cannot.
    for (const [label, state] of [
        ['snoozed', 'snoozed'],
        ['granted', 'granted'],
        ['denied', 'denied'],
    ] as const) {
        const who = await actors.account(world.agents[label]);

        must(
            await who.api.api.put('/api/v1/me/notification-settings', {
                prompt_state: state,
            }),
            `${label}: ${state}`,
        );
    }

    await setNotificationRow(instance, world.agents.expired.id, {
        prompt_state: 'snoozed',
        snoozed_until: 'now:-1 minute',
    });

    for (const label of ['snoozed', 'granted', 'denied'] as const) {
        const agent = await open(label);

        await expect(dialog(agent.page)).toHaveCount(0);
        expect(await permissionRequests(agent.page)).toBe(0);
    }

    // The snooze ran out a minute ago: it is time to ask again.
    const expired = await open('expired');

    await expect(dialog(expired.page)).toBeVisible();
    expect(await permissionRequests(expired.page)).toBe(0);
});

test('a browser that says no is remembered as denied: an info toast explains how to unblock it, and the dialog never comes back', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);

    await prepareBrowser(ann, { answer: 'denied' });

    const posts = recordSubscriptionPosts(ann.page);

    await ann.inbox.goto();
    await expect(dialog(ann.page)).toBeVisible({ timeout: 15_000 });
    await dialog(ann.page).getByTestId('notification-prompt-enable').click();
    await expect(dialog(ann.page)).toBeHidden();
    await expect(
        ann.page.getByText('Your browser blocked notifications.', {
            exact: false,
        }),
    ).toBeVisible();
    expect(await permissionRequests(ann.page)).toBe(1);
    expect((await pushStubLog(ann.page)).subscribed).toBe(0);
    expect(posts.count()).toBe(0);
    await expect
        .poll(async () => (await notificationSettings(ann)).promptState)
        .toBe('denied');

    // Reload: the permission is `denied` now, so there is nothing to ask and no dialog.
    await ann.page.clock.install();

    const restarted = watchControllerStart(ann.page);

    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await passPromptDelay(ann.page, restarted);
    await expect(dialog(ann.page)).toHaveCount(0);
    expect(await permissionRequests(ann.page)).toBe(0);
});

test('a browser prompt that is closed without an answer counts as "Not now"', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);

    await prepareBrowser(ann, { answer: 'dismiss' });

    const posts = recordSubscriptionPosts(ann.page);

    await ann.inbox.goto();
    await expect(dialog(ann.page)).toBeVisible({ timeout: 15_000 });
    await dialog(ann.page).getByTestId('notification-prompt-enable').click();
    await expect(dialog(ann.page)).toBeHidden();
    expect(await permissionRequests(ann.page)).toBe(1);
    await expect
        .poll(async () => (await notificationSettings(ann)).promptState)
        .toBe('snoozed');
    expect(posts.count()).toBe(0);
    expect((await pushStubLog(ann.page)).subscribed).toBe(0);
});

test('a browser that cannot do push never sees the dialog, and the settings page says why; the settings page itself never opens it', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { old: ['main'], plain: ['main'] },
    });

    // No PushManager (an old browser): the explainer would promise something the browser cannot do.
    const old = await actors.account(world.agents.old);

    await prepareBrowser(old, { without: 'push-manager' });
    await old.page.clock.install();

    const started = watchControllerStart(old.page);

    await old.page.goto('/settings/notifications');
    await expect(old.page.getByTestId('notifications-prefs')).toBeVisible();
    await passPromptDelay(old.page, started);
    await expect(dialog(old.page)).toHaveCount(0);
    await expect(old.page.getByTestId('notifications-status')).toContainText(
        'This browser does not support push notifications.',
    );
    await expect(old.page.getByTestId('notifications-status')).toContainText(
        'Without push notifications you still get an alert',
    );
    await expect(old.page.getByTestId('notifications-enable')).toHaveCount(0);

    // Supported, never asked, on the settings page itself: no dialog on top of the page that has the same button.
    const plain = await actors.account(world.agents.plain);

    await prepareBrowser(plain);
    await plain.page.clock.install();

    const plainStarted = watchControllerStart(plain.page);

    await plain.page.goto('/settings/notifications');
    await expect(plain.page.getByTestId('notifications-enable')).toBeVisible();
    await passPromptDelay(plain.page, plainStarted);
    await expect(dialog(plain.page)).toHaveCount(0);
    expect(await permissionRequests(plain.page)).toBe(0);
});
