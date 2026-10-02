import type { Locator, Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { expectInsideViewportWidth } from '../support/chat-lab';
import { expectNoHorizontalScroll } from '../support/helpers';
import {
    agentsPage,
    dialogOpen,
    inboxIn,
    launcherWithBadge,
    settingsIn,
} from '../support/p5-views';

/**
 * The P5 screens on a small screen (375 and 320 px wide, in both Playwright projects: the mobile one adds touch and a phone user agent to the
 * same explicit sizes): Settings > Notifications (every switch, button, time field and device row reachable, nothing sideways), the first-login
 * dialog (inside the screen, both buttons reachable), the agents page with its presence dots and its "N online" line, the inbox's presence
 * selector with its hint and offline notice, and the launcher with a two-digit and a `99+` badge on a customer site.
 */
test.use({ scenario: 'p5-notify' });

test.describe.configure({ timeout: 120_000 });

const SIZES = [
    { width: 375, height: 812 },
    { width: 320, height: 568 },
];

/** The element is whole inside the viewport: horizontally always, vertically once scrolled to. */
async function reachable(
    page: Page,
    locator: Locator,
    message: string,
): Promise<void> {
    await locator.scrollIntoViewIfNeeded();
    await expectInsideViewportWidth(locator, page, message);

    const box = await locator.boundingBox();
    const height = page.viewportSize()?.height ?? 0;

    expect(box, `${message} has a box`).not.toBeNull();
    expect(box!.y, `${message} starts on screen`).toBeGreaterThanOrEqual(-0.5);
    expect(
        box!.y + box!.height,
        `${message} ends on screen`,
    ).toBeLessThanOrEqual(height + 0.5);
}

for (const size of SIZES) {
    test.describe(`${size.width} px`, () => {
        test('Settings > Notifications: every control reachable, nothing sideways', async ({
            actors,
            adminApi,
            instance,
        }) => {
            const { page } = await settingsIn(
                { actors, adminApi, instance },
                'on',
            );

            await page.setViewportSize(size);
            await expectNoHorizontalScroll(page);

            for (const id of [
                'sound',
                'offers',
                'messages',
                'preview',
                'quiet-enabled',
            ]) {
                await reachable(
                    page,
                    page.getByTestId(`notifications-${id}`),
                    id,
                );
            }

            for (const id of ['test', 'disable']) {
                await reachable(
                    page,
                    page.getByTestId(`notifications-${id}`),
                    id,
                );
            }

            // The quiet-hours fields (enable them first: they are disabled while the switch is off) and the time zone.
            await page.getByTestId('notifications-quiet-enabled').click();
            await reachable(
                page,
                page.getByTestId('notifications-quiet-start'),
                'quiet start',
            );
            await reachable(
                page,
                page.getByTestId('notifications-quiet-end'),
                'quiet end',
            );
            await reachable(
                page,
                page.locator('#notifications-quiet-timezone'),
                'time zone',
            );

            // Both device rows (this device marked) and their remove buttons fit.
            const rows = page.getByTestId('notifications-device');

            await expect(rows).toHaveCount(2);

            for (let index = 0; index < 2; index += 1) {
                await reachable(page, rows.nth(index), `device row ${index}`);
                await reachable(
                    page,
                    rows.nth(index).getByTestId('notifications-device-remove'),
                    `remove device ${index}`,
                );
            }

            await expectNoHorizontalScroll(page);
        });

        test('the first-login dialog is inside the screen with both buttons reachable', async ({
            actors,
            adminApi,
            instance,
        }) => {
            const { page } = await dialogOpen({ actors, adminApi, instance });

            await page.setViewportSize(size);

            const dialog = page.getByTestId('notification-prompt');

            await expectInsideViewportWidth(dialog, page, 'the dialog');
            await reachable(
                page,
                page.getByTestId('notification-prompt-enable'),
                'turn on',
            );
            await reachable(
                page,
                page.getByTestId('notification-prompt-later'),
                'not now',
            );
            await expectNoHorizontalScroll(page);
        });

        test('the agents page: dots and the online count fit, the rows do not scroll sideways', async ({
            actors,
            adminApi,
            instance,
        }) => {
            const { admin, world } = await agentsPage({
                actors,
                adminApi,
                instance,
            });
            const page = admin.page;

            await page.setViewportSize(size);
            await expectNoHorizontalScroll(page);
            await reachable(
                page,
                page.getByTestId('agents-online-count'),
                'online count',
            );

            for (const agent of Object.values(world.agents)) {
                await reachable(
                    page,
                    page.getByTestId(`agent-presence-${agent.id}`),
                    `presence of ${agent.name}`,
                );
            }
        });

        test('the inbox: the presence selector with its hint, and the offline notice with its button', async ({
            actors,
            adminApi,
            instance,
        }) => {
            const rig = { actors, adminApi, instance };
            const online = await inboxIn(rig, 'online');

            await online.page.setViewportSize(size);
            await expectNoHorizontalScroll(online.page);
            await reachable(
                online.page,
                online.agent.inbox.tid('presence-select'),
                'selector',
            );
            await reachable(
                online.page,
                online.agent.inbox.tid('presence-hint'),
                'hint',
            );

            const offline = await inboxIn(rig, 'offline');

            await offline.page.setViewportSize(size);
            await expectNoHorizontalScroll(offline.page);
            await reachable(
                offline.page,
                offline.agent.inbox.tid('presence-go-online'),
                'go online',
            );
        });

        test('the launcher with a two-digit badge and with 99+ stays whole on the screen', async ({
            actors,
            adminApi,
            instance,
        }) => {
            const { launcher, chat, panel } = await launcherWithBadge(
                { actors, adminApi, instance },
                12,
                { width: size.width },
            );
            const page = panel.page;

            await page.setViewportSize({
                width: size.width,
                height: size.height,
            });
            await expect(launcher.badge).toHaveText('12');
            await reachable(page, launcher.badge, 'the two-digit badge');
            await reachable(page, launcher.button, 'the launcher');

            // More than 99 unread replies: the badge says 99+ and still fits (the loader clamps it, the label keeps the real number).
            for (let reply = 13; reply <= 101; reply += 1) {
                const sent = await chat.agent.api.send(
                    chat.ulid,
                    `Reply number ${reply}`,
                );

                expect(sent.ok, `reply ${reply}`).toBe(true);
            }

            await expect(launcher.badge).toHaveText('99+', { timeout: 30_000 });
            await expect(launcher.button).toHaveAttribute(
                'aria-label',
                /, 101 unread messages$/,
            );
            await reachable(page, launcher.badge, 'the 99+ badge');
        });
    });
}
