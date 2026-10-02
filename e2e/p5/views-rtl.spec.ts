import type { Locator } from '@playwright/test';
import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import { reportAxe, runAxe, scanDashboard } from '../support/chat-lab';
import { expectNoHorizontalScroll } from '../support/helpers';
import { Launcher } from '../support/launcher';
import { openCustomerSite } from '../support/panel';
import {
    agentsPage,
    dialogOpen,
    inboxIn,
    newAgent,
    settingsIn,
} from '../support/p5-views';
import { setNotificationRow } from '../support/notify';
import { createWorld } from '../support/world';

/**
 * The P5 screens in Arabic, right to left (`p5-notify-rtl`: the whole instance is Arabic, `lang/ar.json` falls back to English for the
 * strings it does not have yet): Settings > Notifications mirrored (switches at the logical end, the remove buttons of the device rows),
 * the first-login dialog (the primary button at the end = left), the agents page's dots, the inbox's presence selector and hint, and the
 * launcher with its badge on a right-to-left host page. Positions are measured, not assumed; axe runs on every screen.
 */
test.use({ scenario: 'p5-notify-rtl' });

test.describe.configure({ timeout: 120_000 });

const box = async (locator: Locator) => {
    const found = await locator.boundingBox();

    expect(found, 'the element has a box').not.toBeNull();

    return found!;
};

test("Settings > Notifications is mirrored: the page is right to left, the switches sit at the start of the row's end side, nothing scrolls sideways", async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { page } = await settingsIn({ actors, adminApi, instance }, 'on');

    await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
    await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
    await expectNoHorizontalScroll(page);

    // In a row of the preferences the label is on the right (the start) and its switch on the left (the end).
    for (const id of ['sound', 'offers', 'messages', 'preview']) {
        const label = await box(
            page.locator(`label[for="notifications-${id}"]`),
        );
        const toggle = await box(page.getByTestId(`notifications-${id}`));

        expect(
            toggle.x + toggle.width,
            `${id}: the switch is left of the label`,
        ).toBeLessThanOrEqual(label.x + label.width);
        expect(
            toggle.x,
            `${id}: the switch is left of the label's start`,
        ).toBeLessThan(label.x);
    }

    // A device row: the remove button is at the end (the left), the name before it on the right.
    const row = page.getByTestId('notifications-device').first();
    const remove = await box(row.getByTestId('notifications-device-remove'));
    const name = await box(row.locator('p').first());

    expect(remove.x).toBeLessThan(name.x);

    // The times and the time zone keep reading left to right inside the mirrored form (they are numbers and zone names).
    await expect(page.locator('#notifications-quiet-timezone')).toBeVisible();

    await scanDashboard(page, testInfo, 'rtl-notifications');
});

test('the first-login dialog is mirrored: the primary button is on the left, the text starts on the right', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { page } = await dialogOpen({ actors, adminApi, instance });
    const enable = await box(page.getByTestId('notification-prompt-enable'));
    const later = await box(page.getByTestId('notification-prompt-later'));

    // Side by side the primary action is at the end (the left); on a phone the two buttons are stacked and the order is vertical.
    if (Math.abs(enable.y - later.y) < 5) {
        expect(
            enable.x,
            'the primary action is at the end (left)',
        ).toBeLessThan(later.x);
    } else {
        expect(
            enable.y,
            'stacked: the primary action comes first',
        ).toBeLessThan(later.y);
    }

    const title = page.getByRole('heading', { level: 2 }).first();

    await expect(title).toBeVisible();
    expect(
        await title.evaluate((element) => getComputedStyle(element).direction),
    ).toBe('rtl');

    await expectNoHorizontalScroll(page);
    await scanDashboard(page, testInfo, 'rtl-notification-prompt');
});

test('the agents page: the presence dot is at the start of its label (right), the online count and rows do not scroll sideways', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { admin, world } = await agentsPage({ actors, adminApi, instance });
    const page = admin.page;
    const presence = page.getByTestId(`agent-presence-${world.agents.ann.id}`);
    const dot = await box(presence.locator('[data-status]').first());
    const label = await box(presence.locator('span').last());

    expect(dot.x, 'the dot is on the right of its label').toBeGreaterThan(
        label.x,
    );
    await expectNoHorizontalScroll(page);
    await scanDashboard(page, testInfo, 'rtl-agents-dots');
});

test('the inbox: the status dot is at the start of the selector, the hint reads right to left', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const { agent, page } = await inboxIn(
        { actors, adminApi, instance },
        'online',
    );
    const select = await box(agent.inbox.tid('presence-select'));
    const dot = await box(page.locator('[data-status="online"]').first());
    const hint = agent.inbox.tid('presence-hint');

    expect(
        dot.x + dot.width / 2,
        'the dot is in the right half of the selector',
    ).toBeGreaterThan(select.x + select.width / 2);
    expect(
        await hint.evaluate((element) => getComputedStyle(element).direction),
    ).toBe('rtl');
    await expectNoHorizontalScroll(page);
    await scanDashboard(page, testInfo, 'rtl-inbox-presence');
});

test('the launcher on a right-to-left host page keeps its corner and puts the badge on the logical end of the bubble', async ({
    actors,
    adminApi,
    instance,
}, testInfo) => {
    const rig = { actors, adminApi, instance };
    // A widget that speaks Arabic (its direction follows the texts it shows, not the host page), like the scenario's own.
    const arabic = await createWorld(adminApi, instance, {
        settings: { locale: 'ar' },
        config: { defaultLocale: 'ar' },
    });
    const { world, agent } = await newAgent(rig, {}, 'ann', arabic);

    await setNotificationRow(instance, world.agents.ann.id, {
        prompt_state: 'denied',
    });
    must(await agent.api.setPresence('online'), 'online');
    await agent.inbox.goto();

    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: world.widget.key,
        open: true,
        rtl: true,
    });
    const chat = await panel.startChat({
        category: world.categories.main.slug,
        name: 'Rima Reader',
    });

    await agent.inbox.expectOffer(chat.ulid!);
    await agent.inbox.accept(chat.ulid!);
    await panel.expectState('active');

    const launcher = new Launcher(visitor.page);

    await launcher.close();
    must(await agent.api.send(chat.ulid!, 'Reply one'), 'reply');
    must(await agent.api.send(chat.ulid!, 'Reply two'), 'reply');
    await expect(launcher.badge).toHaveText('2');

    const button = await box(launcher.button);
    const badge = await box(launcher.badge);

    // The bubble stays in the corner of the page; the badge hangs off its logical end, which is the left side in a right-to-left page.
    expect(
        badge.x + badge.width / 2,
        'the badge is on the left half of the bubble',
    ).toBeLessThan(button.x + button.width / 2);
    await expect(visitor.page.locator('html')).toHaveAttribute('dir', 'rtl');
    await reportAxe(
        testInfo,
        'rtl-launcher-badge',
        await runAxe(visitor.page, { include: 'pne-chat-widget' }),
    );
});
