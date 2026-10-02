import { test } from '../support/test';
import { must } from '../support/chat-api';
import {
    expect,
    notificationSettings,
    prepareBrowser,
    pushDevices,
    recordSubscriptionPosts,
} from '../support/notify';
import {
    FakeSubscription,
    permissionRequests,
    pushStubLog,
} from '../support/push';
import { createWorld } from '../support/world';
import type { Actors } from '../support/actors';
import type { Api } from '../support/api';
import type { Instance } from '../support/scenarios';

/**
 * Settings > Notifications in a real browser (decisions P5-D7, P5-D9): the four switches persist, the quiet-hours editor (an overnight window and
 * a time zone), the registered devices and their removal, the "this browser" section in each of its states (off, on, off by choice, blocked),
 * and the test notification, which answers HONESTLY about what the push service did: here the endpoint is one nobody listens on, so the server
 * reports a failed delivery and the page says so. The delivered / removed answers are in `notifications-delivery.spec.ts` (a live fake service).
 */
test.use({ scenario: 'p5-notify' });

test.describe.configure({ timeout: 120_000 });

const SETTINGS = '/settings/notifications';

/** A signed-in agent (never asked: the prompt is decided already so it cannot sit on top of the page) opened on the settings page. */
async function open(
    rig: { actors: Actors; adminApi: Api; instance: Instance },
    options: Parameters<typeof prepareBrowser>[1] = {},
) {
    const world = await createWorld(rig.adminApi, rig.instance, {
        agents: { ann: ['main'] },
    });
    const ann = await rig.actors.account(world.agents.ann);

    await prepareBrowser(ann, options);

    const posts = recordSubscriptionPosts(ann.page);

    await ann.page.goto(SETTINGS);
    await expect(ann.page.getByTestId('notifications-prefs')).toBeVisible({
        timeout: 20_000,
    });

    return { world, ann, posts };
}

const switchOf = (page: import('@playwright/test').Page, id: string) =>
    page.getByTestId(`notifications-${id}`);

test('the four switches persist: each change is saved at once, survives a reload and is what the API says', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann } = await open({ actors, adminApi, instance });
    const page = ann.page;

    // The defaults: everything on.
    for (const id of ['sound', 'offers', 'messages', 'preview']) {
        await expect(switchOf(page, id)).toBeChecked();
    }

    await switchOf(page, 'sound').click();
    await expect(switchOf(page, 'sound')).not.toBeChecked();
    await expect
        .poll(async () => (await notificationSettings(ann)).sound)
        .toBe(false);

    await switchOf(page, 'offers').click();
    await switchOf(page, 'messages').click();
    await switchOf(page, 'preview').click();
    await expect
        .poll(async () => {
            const settings = await notificationSettings(ann);

            return [
                settings.sound,
                settings.pushOffers,
                settings.pushMessages,
                settings.includePreview,
            ];
        })
        .toEqual([false, false, false, false]);

    await page.reload();
    await expect(page.getByTestId('notifications-prefs')).toBeVisible();

    for (const id of ['sound', 'offers', 'messages', 'preview']) {
        await expect(switchOf(page, id)).not.toBeChecked();
    }

    // And back on, one by one (each is its own request).
    await switchOf(page, 'offers').click();
    await expect(switchOf(page, 'offers')).toBeChecked();
    await expect
        .poll(async () => (await notificationSettings(ann)).pushOffers)
        .toBe(true);
    expect((await notificationSettings(ann)).pushMessages).toBe(false);
});

test('quiet hours: an overnight window and a time zone are saved as typed, equal times are refused, and the fields follow the switch', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann } = await open({ actors, adminApi, instance });
    const page = ann.page;
    const start = page.getByTestId('notifications-quiet-start');
    const end = page.getByTestId('notifications-quiet-end');

    // Off: the times cannot be edited.
    await expect(switchOf(page, 'quiet-enabled')).not.toBeChecked();
    await expect(start).toBeDisabled();
    await expect(end).toBeDisabled();

    await switchOf(page, 'quiet-enabled').click();
    await expect(start).toBeEnabled();
    await expect(end).toBeEnabled();

    // 22:00 to 07:00 runs overnight, and the page says so.
    await start.fill('22:00');
    await end.fill('07:00');
    await page
        .locator('#notifications-quiet-timezone')
        .selectOption('Asia/Dubai');
    await expect(
        page.getByText('This window runs overnight, into the next day.'),
    ).toBeVisible();

    await expect
        .poll(async () => (await notificationSettings(ann)).quietHours)
        .toEqual({
            enabled: true,
            start: '22:00',
            end: '07:00',
            timezone: 'Asia/Dubai',
        });

    // The same start and end is an empty window: refused before it leaves the page, and nothing was saved.
    await end.fill('22:00');
    await expect(
        page.getByText('Start and end must be different times.'),
    ).toBeVisible();
    await expect(end).toHaveAttribute('aria-invalid', 'true');
    expect((await notificationSettings(ann)).quietHours.end).toBe('07:00');

    // A real end time again: the message goes, the window is saved.
    await end.fill('06:30');
    await expect(
        page.getByText('Start and end must be different times.'),
    ).toHaveCount(0);
    await expect
        .poll(async () => (await notificationSettings(ann)).quietHours.end)
        .toBe('06:30');

    // A daytime window has no overnight hint.
    await start.fill('09:00');
    await end.fill('17:00');
    await expect
        .poll(async () => (await notificationSettings(ann)).quietHours.start)
        .toBe('09:00');
    await expect(
        page.getByText('This window runs overnight, into the next day.'),
    ).toHaveCount(0);

    // A reload shows what was saved; switching off keeps the times but disables the fields again.
    await page.reload();
    await expect(page.getByTestId('notifications-quiet')).toBeVisible();
    await expect(switchOf(page, 'quiet-enabled')).toBeChecked();
    await expect(start).toHaveValue('09:00');
    await expect(end).toHaveValue('17:00');
    await expect(page.locator('#notifications-quiet-timezone')).toHaveValue(
        'Asia/Dubai',
    );
    await switchOf(page, 'quiet-enabled').click();
    await expect(start).toBeDisabled();
    await expect
        .poll(async () => (await notificationSettings(ann)).quietHours.enabled)
        .toBe(false);
    expect((await notificationSettings(ann)).quietHours.start).toBe('09:00');

    // The server refuses the same thing when it is sent by hand (the validation is not only the page's).
    const refused = await ann.api.api.put('/api/v1/me/notification-settings', {
        quiet_hours: { enabled: true, start: '10:00', end: '10:00' },
    });

    expect(refused.status).toBe(422);
});

test('this browser: off, then on (the browser asked once, subscribed and registered), then turned off for this browser and it stays off after a reload', async ({
    actors,
    adminApi,
    instance,
}) => {
    const subscription = FakeSubscription.dead();
    const { ann, posts } = await open(
        { actors, adminApi, instance },
        { subscription },
    );
    const page = ann.page;
    const status = page.getByTestId('notifications-status');

    // Never asked here: off, with the button; the dialog is suppressed on this page, and the browser has not been asked.
    await expect(status).toContainText(
        'Notifications are off for this browser.',
    );
    await expect(page.getByTestId('notifications-devices-empty')).toBeVisible();
    expect(await permissionRequests(page)).toBe(0);

    await page.getByTestId('notifications-enable').click();
    await expect(status).toContainText(
        'Notifications are on for this browser.',
    );
    expect(await permissionRequests(page)).toBe(1);
    expect((await pushStubLog(page)).subscribed).toBe(1);
    expect(posts.list.map((post) => post.status)).toEqual([201]);
    await expect(page.getByTestId('notifications-test')).toBeVisible();
    await expect(page.getByTestId('notifications-disable')).toBeVisible();

    // The devices list shows this browser, marked.
    const devices = page.getByTestId('notifications-device');

    await expect(devices).toHaveCount(1);
    await expect(devices.first()).toContainText('This device');
    await expect(devices.first()).toContainText('Not notified yet');

    // Turn off for this browser: unsubscribed in the browser AND removed on the server; remembered across reloads.
    await page.getByTestId('notifications-disable').click();
    await expect(status).toContainText(
        'You turned notifications off for this browser.',
    );
    await expect(page.getByTestId('notifications-devices-empty')).toBeVisible();
    expect((await pushStubLog(page)).unsubscribed).toBe(1);
    expect(await pushDevices(ann)).toEqual([]);

    await page.reload();
    await expect(page.getByTestId('notifications-prefs')).toBeVisible();
    await expect(status).toContainText(
        'You turned notifications off for this browser.',
    );
    expect(await pushDevices(ann)).toEqual([]);
    expect(
        posts.list.filter((post) => post.status === 201 || post.status === 200),
    ).toHaveLength(1);
});

test('a blocked site says how to unblock it and offers no button; a browser that cannot do push says why and what still works', async ({
    actors,
    adminApi,
    instance,
}) => {
    const blocked = await open(
        { actors, adminApi, instance },
        { permission: 'denied' },
    );
    const status = blocked.ann.page.getByTestId('notifications-status');

    await expect(status).toContainText(
        'Notifications are blocked for this site.',
    );
    await expect(status).toContainText('set Notifications to Allow');
    await expect(
        blocked.ann.page.getByTestId('notifications-enable'),
    ).toHaveCount(0);
    // The page records it once, so the first-login dialog never comes back.
    await expect
        .poll(async () => (await notificationSettings(blocked.ann)).promptState)
        .toBe('denied');

    const worker = await open(
        { actors, adminApi, instance },
        { without: 'service-worker' },
    );

    await expect(
        worker.ann.page.getByTestId('notifications-status'),
    ).toContainText('This browser cannot run the background part');
    await expect(
        worker.ann.page.getByTestId('notifications-status'),
    ).toContainText('you still get an alert, a sound');
    await expect(
        worker.ann.page.getByTestId('notifications-enable'),
    ).toHaveCount(0);
    // The preferences and quiet hours are still the member's to set: they follow the account, not the browser.
    await expect(
        worker.ann.page.getByTestId('notifications-quiet'),
    ).toBeVisible();
});

test('devices: registered browsers are listed without their endpoints, this one is marked, and a removal is a toast and a row gone', async ({
    actors,
    adminApi,
    instance,
}) => {
    const mine = FakeSubscription.dead();
    const other = FakeSubscription.dead();
    const { ann } = await open(
        { actors, adminApi, instance },
        { subscription: mine },
    );
    const page = ann.page;

    // A second browser of the same member (registered the way its own page would).
    must(
        await ann.api.api.post('/api/v1/me/push-subscriptions', other.toJSON()),
        'registering the second browser',
    );
    await page.getByTestId('notifications-enable').click();
    await expect(page.getByTestId('notifications-status')).toContainText(
        'Notifications are on for this browser.',
    );
    await page.reload();
    await expect(page.getByTestId('notifications-devices')).toBeVisible();

    const rows = page.getByTestId('notifications-device');

    await expect(rows).toHaveCount(2);
    await expect(
        page
            .getByTestId('notifications-device')
            .filter({ hasText: 'This device' }),
    ).toHaveCount(1);
    await expect(page.getByText('Added ').first()).toBeVisible();
    expect(await page.content()).not.toContain(mine.endpoint);
    expect(await page.content()).not.toContain(other.endpoint);

    // Remove the other one (not this browser): a toast, one row left, still on for this browser.
    await rows
        .filter({ hasNotText: 'This device' })
        .getByTestId('notifications-device-remove')
        .click();
    await expect(page.getByText('Device removed.')).toBeVisible();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText('This device');
    await expect(page.getByTestId('notifications-status')).toContainText(
        'Notifications are on for this browser.',
    );
    expect(await pushDevices(ann)).toHaveLength(1);

    // Removing THIS browser unsubscribes it too, and it stays off.
    await rows.first().getByTestId('notifications-device-remove').click();
    await expect(page.getByTestId('notifications-devices-empty')).toBeVisible();
    await expect(page.getByTestId('notifications-status')).toContainText(
        'You turned notifications off for this browser.',
    );
    expect((await pushStubLog(page)).unsubscribed).toBeGreaterThanOrEqual(1);
});

test('the test notification answers honestly: a push service that cannot be reached is a failure on the page, limited to three a minute', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann } = await open(
        { actors, adminApi, instance },
        { subscription: FakeSubscription.dead() },
    );
    const page = ann.page;
    const result = page.getByTestId('notifications-test-result');

    await page.getByTestId('notifications-enable').click();
    await expect(page.getByTestId('notifications-test')).toBeVisible();

    // The page says what happened, not "sent": the connection to the push service was refused.
    await page.getByTestId('notifications-test').click();
    await expect(result).toContainText(
        'The push service did not accept the notification.',
    );
    await expect(result).not.toContainText('Test notification sent');

    // The server's own answer, read directly: one device, nothing sent, one failure, nothing removed.
    const direct = await ann.api.api.post('/api/v1/me/push-subscriptions/test');

    expect(direct.status).toBe(200);
    expect(direct.data).toEqual({ devices: 1, sent: 0, failed: 1, removed: 0 });

    // A third one still goes through, the fourth in the same minute is limited, with the wait.
    await page.getByTestId('notifications-test').click();
    await expect(result).toContainText(
        'The push service did not accept the notification.',
    );
    await page.getByTestId('notifications-test').click();
    await expect(result).toContainText('Too many tests in a row.');
    await expect(result).toContainText(/Try again in \d+ seconds\./);
});

test('a device removed from another browser meanwhile: the test says to turn notifications on first', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { ann } = await open(
        { actors, adminApi, instance },
        { subscription: FakeSubscription.dead() },
    );
    const page = ann.page;

    await page.getByTestId('notifications-enable').click();
    await expect(page.getByTestId('notifications-test')).toBeVisible();

    // Another browser of the same member removes this one's registration; this page still believes it is on.
    for (const device of await pushDevices(ann)) {
        must(
            await ann.api.api.delete(
                `/api/v1/me/push-subscriptions/${device.id}`,
            ),
            'removing the device elsewhere',
        );
    }

    await page.getByTestId('notifications-test').click();
    await expect(page.getByTestId('notifications-test-result')).toContainText(
        'Turn on notifications in this browser first.',
    );
});
