import { expect, test } from '../support/test';
import { reportAxe, runAxe, scanDashboard } from '../support/chat-lab';
import { setSetting } from '../support/staff-db';
import {
    agentsPage,
    dialogOpen,
    inboxIn,
    launcherWithBadge,
    settingsIn,
    type SettingsState,
} from '../support/p5-views';
import { createWorld } from '../support/world';
import { prepareBrowser } from '../support/notify';
import { must } from '../support/chat-api';

/**
 * axe (WCAG A/AA: any violation fails; best-practice findings are attached and listed as annotations), light and dark, on the P5 screens in
 * each state a real shift produces: Settings > Notifications (off, on with its devices and a failed test, turned off here, blocked, a browser
 * that cannot do push, quiet hours with their error, push not configured, previews locked by the administrator), the first-login dialog,
 * the agents page with Online / Away / Offline dots, the inbox with the presence hint and the offline notice, and the launcher with its
 * badge and its alert on a customer site. The desktop project scans at 1280 px, the mobile project on a phone. Scans run in axe's legacy mode
 * (see chat-lab.ts: the default mode breaks a mobile-emulated page).
 */
test.use({ scenario: 'p5-notify' });

test.describe.configure({ timeout: 150_000 });

const STATES: SettingsState[] = [
    'off',
    'on',
    'off-here',
    'blocked',
    'unsupported',
    'quiet-error',
];

for (const state of STATES) {
    test(`Settings > Notifications, state "${state}"`, async ({
        actors,
        adminApi,
        instance,
    }, testInfo) => {
        const { page } = await settingsIn(
            { actors, adminApi, instance },
            state,
        );

        await scanDashboard(page, testInfo, `notifications-${state}`);
    });
}

test('the first-login dialog', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { page } = await dialogOpen({ actors, adminApi, instance });

    await scanDashboard(page, testInfo, 'notification-prompt');
});

test('the agents page with Online, Away and Offline dots', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { admin } = await agentsPage({ actors, adminApi, instance });

    await scanDashboard(admin.page, testInfo, 'agents-presence-dots');
});

test('the inbox with the presence hint (online), as away, and with the offline notice', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const rig = { actors, adminApi, instance };
    const online = await inboxIn(rig, 'online');

    await expect(online.agent.inbox.tid('presence-hint')).toBeVisible();
    await scanDashboard(online.page, testInfo, 'inbox-presence-online');

    const away = await inboxIn(rig, 'away');

    await scanDashboard(away.page, testInfo, 'inbox-presence-away');

    const offline = await inboxIn(rig, 'offline');

    await expect(
        offline.agent.inbox.tid('presence-offline-notice'),
    ).toBeVisible();
    await scanDashboard(offline.page, testInfo, 'inbox-presence-offline');
});

test.describe('push not configured, previews locked (no VAPID keys)', () => {
    test.use({ scenario: 'p5-chat' });

    test('Settings > Notifications says push is not set up; an administrator can lock the previews', async ({
        actors,
        adminApi,
        instance,
    }, testInfo) => {
        const world = await createWorld(adminApi, instance, {
            agents: { ann: ['main'] },
        });
        const ann = await actors.account(world.agents.ann);

        await prepareBrowser(ann, {});
        await ann.page.goto('/settings/notifications');
        await expect(
            ann.page.getByTestId('notifications-status'),
        ).toContainText('not set up on this server');
        await scanDashboard(ann.page, testInfo, 'notifications-unavailable');

        try {
            await setSetting(
                instance,
                'notifications.push_include_preview',
                false,
            );
            await expect
                .poll(async () => {
                    const settings = must<{ previewsAllowed: boolean }>(
                        await ann.api.api.get(
                            '/api/v1/me/notification-settings',
                        ),
                        'settings',
                    );

                    return settings.previewsAllowed;
                })
                .toBe(false);
            await ann.page.reload();
            await expect(
                ann.page.getByTestId('notifications-preview'),
            ).toBeDisabled();
            await scanDashboard(
                ann.page,
                testInfo,
                'notifications-previews-locked',
            );
        } finally {
            await setSetting(
                instance,
                'notifications.push_include_preview',
                true,
            );
        }
    });

    test('the launcher with a badge and its alert, on a customer site', async ({
        actors,
        adminApi,
        instance,
    }, testInfo) => {
        const { launcher, panel } = await launcherWithBadge(
            { actors, adminApi, instance },
            3,
        );
        const page = panel.page;

        // The alert state (the ring) is running right after the reply; the badge and the label are what is checked in both colour schemes.
        await expect(launcher.badge).toHaveText('3');

        for (const theme of ['light', 'dark'] as const) {
            await page.emulateMedia({ colorScheme: theme });
            await expect(launcher.root).toHaveAttribute('data-scheme', theme);
            await reportAxe(
                testInfo,
                `launcher-badge-${theme}`,
                await runAxe(page, { include: 'pne-chat-widget' }),
            );
        }
    });
});
