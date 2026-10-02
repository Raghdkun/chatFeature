import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import {
    notificationSettings,
    passPromptDelay,
    prepareBrowser,
    watchControllerStart,
} from '../support/notify';
import { FakeSubscription, permissionRequests } from '../support/push';
import { setSetting } from '../support/staff-db';
import { createWorld } from '../support/world';

/**
 * Push on a server that has no VAPID keys (this scenario, like every P4 one, has none): the feature is off, honestly. The settings page says push
 * is not set up and what still works, the registration endpoints answer `503 push_unavailable`, the first-login dialog never opens and the browser is
 * never asked, while the preferences and quiet hours stay editable (they follow the account). The administrator's switch for message previews
 * (`notifications.push_include_preview`) locks the member's own preview switch off and says why. The scenario has no VAPID, so these specs also
 * stand for "the P4 specs are unaffected": a never-asked agent sees no dialog in the middle of the inbox.
 */
test.use({ scenario: 'p5-chat' });

test('without VAPID keys the page says push is not set up, offers no button, the API refuses, and the first-login dialog never opens', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);

    await prepareBrowser(ann, { subscription: FakeSubscription.dead() });
    await ann.page.clock.install();

    // A never-asked agent on the inbox: the dialog does not appear (it would block every P4 flow if it did).
    const started = watchControllerStart(ann.page);

    await ann.inbox.goto();
    await passPromptDelay(ann.page, started);
    await expect(ann.page.getByTestId('notification-prompt')).toHaveCount(0);
    expect(await permissionRequests(ann.page)).toBe(0);

    const settings = await notificationSettings(ann);

    expect(settings.pushAvailable).toBe(false);
    expect(settings.promptState).toBe('never');

    // The settings page explains, and keeps what does not need push.
    await ann.page.goto('/settings/notifications');
    await expect(ann.page.getByTestId('notifications-prefs')).toBeVisible();
    await expect(ann.page.getByTestId('notifications-status')).toContainText(
        'Push notifications are not set up on this server.',
    );
    await expect(ann.page.getByTestId('notifications-status')).toContainText(
        'you still get an alert, a sound',
    );
    await expect(ann.page.getByTestId('notifications-enable')).toHaveCount(0);
    await expect(ann.page.getByTestId('notifications-test')).toHaveCount(0);
    await expect(ann.page.getByTestId('notifications-quiet')).toBeVisible();

    // The sound switch (it is not push) still saves.
    await ann.page.getByTestId('notifications-sound').click();
    await expect
        .poll(async () => (await notificationSettings(ann)).sound)
        .toBe(false);

    // The server refuses to register or send anything: 503 with its own code, and the browser's subscription would not be accepted either.
    const register = await ann.api.api.post(
        '/api/v1/me/push-subscriptions',
        FakeSubscription.dead().toJSON(),
    );

    expect(register.status).toBe(503);
    expect(register.error?.code).toBe('push_unavailable');

    const test = await ann.api.api.post('/api/v1/me/push-subscriptions/test');

    expect(test.status).toBe(503);
    expect(test.error?.code).toBe('push_unavailable');
});

test("the administrator's switch for previews locks the member's own switch off and says why; turning it back on gives it back", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann);
    const preview = ann.page.getByTestId('notifications-preview');

    try {
        await setSetting(instance, 'notifications.push_include_preview', false);

        // (The server re-reads its settings within two seconds.)
        await expect
            .poll(async () => (await notificationSettings(ann)).previewsAllowed)
            .toBe(false);

        await ann.page.goto('/settings/notifications');
        await expect(ann.page.getByTestId('notifications-prefs')).toBeVisible();
        await expect(preview).toBeDisabled();
        await expect(preview).not.toBeChecked();
        await expect(
            ann.page.getByText(
                'An administrator turned message previews off for everyone.',
            ),
        ).toBeVisible();

        // The member's own stored choice is untouched underneath (it comes back when the lock is lifted).
        expect((await notificationSettings(ann)).includePreview).toBe(true);
    } finally {
        await setSetting(instance, 'notifications.push_include_preview', true);
    }

    await expect
        .poll(async () => (await notificationSettings(ann)).previewsAllowed)
        .toBe(true);
    await ann.page.reload();
    await expect(preview).toBeEnabled();
    await expect(preview).toBeChecked();

    must(
        await ann.api.api.put('/api/v1/me/notification-settings', {
            include_preview: false,
        }),
        'the member turns previews off themselves',
    );
    await ann.page.reload();
    await expect(preview).toBeEnabled();
    await expect(preview).not.toBeChecked();
});
