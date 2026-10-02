import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { notificationSettings } from '../support/notify';
import {
    dialogOpen,
    inboxIn,
    launcherWithBadge,
    settingsIn,
} from '../support/p5-views';
import { permissionRequests } from '../support/push';

/**
 * The P5 screens with the keyboard alone (desktop only: a phone has no Tab key): the first-login dialog (focus goes in and stays in, Enter turns
 * notifications on, Escape is "Not now" and snoozes on the server), Settings > Notifications (switches by Space, the buttons by Enter, visible focus
 * rings), the presence selector (arrow keys) and "Go online" (Enter), and the launcher with a badge (Enter opens, Escape closes, focus returns to it).
 */
test.use({ scenario: 'p5-notify' });

test.describe.configure({ timeout: 120_000 });

test.beforeEach(async ({ page: _page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'a phone has no Tab key');
});

/** Where the focus is, as "inside the dialog" / "outside" / a description of the element. */
const focusInside = (page: Page, selector: string): Promise<boolean> =>
    page.evaluate(
        (css) =>
            document.querySelector(css)?.contains(document.activeElement) ===
            true,
        selector,
    );

test('the first-login dialog: focus goes in and stays in on Tab and Shift+Tab, Enter on "Turn on notifications" asks the browser', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { page } = await dialogOpen({ actors, adminApi, instance });
    const dialog = '[data-testid="notification-prompt"]';

    // Opening moved the focus into the dialog (nothing behind it can be reached).
    await expect.poll(() => focusInside(page, dialog)).toBe(true);

    for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press('Tab');
        expect(
            await focusInside(page, dialog),
            `Tab ${press + 1} stays in the dialog`,
        ).toBe(true);
    }

    for (let press = 0; press < 8; press += 1) {
        await page.keyboard.press('Shift+Tab');
        expect(
            await focusInside(page, dialog),
            `Shift+Tab ${press + 1} stays in the dialog`,
        ).toBe(true);
    }

    // Reach the primary button with Tab alone and press Enter: the browser is asked, once, and the dialog goes.
    const enable = page.getByTestId('notification-prompt-enable');

    for (let press = 0; press < 8; press += 1) {
        if (
            await enable.evaluate(
                (element) => element === document.activeElement,
            )
        ) {
            break;
        }

        await page.keyboard.press('Tab');
    }

    await expect(enable).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notification-prompt')).toBeHidden();
    expect(await permissionRequests(page)).toBe(1);
});

test('Escape is "Not now": the dialog closes, the server snoozes it, and nothing is left holding the focus', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, page } = await dialogOpen({ actors, adminApi, instance });

    await page.keyboard.press('Escape');
    await expect(page.getByTestId('notification-prompt')).toBeHidden();
    await expect
        .poll(async () => (await notificationSettings(agent)).promptState)
        .toBe('snoozed');
    expect(await permissionRequests(page)).toBe(0);

    // The page behind is live again: the focus is on the page (not on a removed node) and the next Tab reaches something real.
    expect(
        await page.evaluate(() => document.querySelector('[role="dialog"]')),
    ).toBeNull();
    await page.keyboard.press('Tab');
    expect(
        await page.evaluate(
            () =>
                document.activeElement !== null &&
                document.activeElement !== document.body,
        ),
    ).toBe(true);
});

test('Settings > Notifications by keyboard: Tab reaches the switches and Space flips them, with a visible focus ring; Enter presses the buttons', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, page } = await settingsIn(
        { actors, adminApi, instance },
        'off',
    );

    // Tab until the sound switch has the focus (the sidebar and header come first), then flip it.
    const sound = page.getByTestId('notifications-sound');

    for (let press = 0; press < 80; press += 1) {
        if (
            await sound.evaluate(
                (element) => element === document.activeElement,
            )
        ) {
            break;
        }

        await page.keyboard.press('Tab');
    }

    await expect(sound).toBeFocused();

    // The ring: a switch that has the keyboard focus draws something around itself.
    expect(
        await sound.evaluate((element) => {
            const style = getComputedStyle(element);

            return style.boxShadow !== 'none' || style.outlineStyle !== 'none';
        }),
    ).toBe(true);

    await page.keyboard.press('Space');
    await expect
        .poll(async () => (await notificationSettings(agent)).sound)
        .toBe(false);

    // The next stops in the page are the other switches, in reading order.
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('notifications-offers')).toBeFocused();
    await page.keyboard.press('Space');
    await expect
        .poll(async () => (await notificationSettings(agent)).pushOffers)
        .toBe(false);
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('notifications-messages')).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(page.getByTestId('notifications-preview')).toBeFocused();

    // The browser section's button is a real button: Enter presses it.
    const enable = page.getByTestId('notifications-enable');

    await enable.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('notifications-status')).toContainText(
        'Notifications are on for this browser.',
    );
    expect(await permissionRequests(page)).toBe(1);
});

test('the presence selector by typing its options and "Go online" by Enter', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, page } = await inboxIn(
        { actors, adminApi, instance },
        'offline',
    );

    // "Go online" is a button in the offline notice.
    await agent.inbox.tid('presence-go-online').focus();
    await page.keyboard.press('Enter');
    await expect(agent.inbox.tid('presence-select')).toHaveValue('online');
    // (Each change is confirmed by the server before the next one: two requests in flight are handled by different PHP workers, in any order.)
    await expect
        .poll(
            async () =>
                ((await agent.api.presence()).data as { status: string })
                    .status,
        )
        .toBe('online');

    // The native select by keyboard: typing the first letters picks the option (the arrow keys open the list on some platforms), and the
    // choice is saved.
    const select = agent.inbox.tid('presence-select');

    await select.focus();
    await page.keyboard.type('Aw');
    await expect(select).toHaveValue('away');
    await expect
        .poll(async () => {
            const result = await agent.api.presence();

            return (result.data as { status: string }).status;
        })
        .toBe('away');
    await page.keyboard.type('On');
    await expect(select).toHaveValue('online');
});

test('the launcher with a badge by keyboard: Enter opens the chat, Escape closes it and the focus goes back to the launcher', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { launcher, panel } = await launcherWithBadge(
        { actors, adminApi, instance },
        2,
    );
    const page = panel.page;

    // The button is reachable and named with the count.
    await launcher.button.focus();
    await expect(launcher.button).toHaveAttribute(
        'aria-label',
        /, 2 unread messages$/,
    );
    await page.keyboard.press('Enter');
    await expect(panel.container).toBeVisible();
    await expect(launcher.badge).toHaveAttribute('data-show', 'false');

    // Escape closes the bubble (from the host page or from inside the panel) and the focus is the launcher's again.
    await page.keyboard.press('Escape');
    await expect(panel.container).toBeHidden();
    await expect
        .poll(() =>
            page.evaluate(
                () =>
                    document
                        .querySelector('pne-chat-widget')
                        ?.shadowRoot?.activeElement?.classList.contains(
                            'launcher',
                        ) === true,
            ),
        )
        .toBe(true);
});
