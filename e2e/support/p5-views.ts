/**
 * The P5 screens put into the state a spec wants to look at, once, for the quality specs (axe, 375 / 320 px, right to left, keyboard) and the
 * deck screenshots: Settings > Notifications in each of its states, the first-login dialog, the agents page with its presence dots, the inbox
 * with the presence selector (hint / offline notice), and the launcher on a customer site with a badge. Everything is built through the real
 * UI and API; the browser's push APIs are the stubs of push.ts.
 */
import { expect, type Page } from '@playwright/test';
import type { Actors, StaffActor } from './actors';
import type { Api } from './api';
import { must } from './chat-api';
import { readSeed } from './chat-seed';
import { Launcher } from './launcher';
import {
    notificationSettings,
    prepareBrowser,
    setNotificationRow,
} from './notify';
import type { Panel } from './panel';
import { FakeSubscription } from './push';
import type { Instance } from './scenarios';
import { startChat } from './staff-flow';
import { createWorld, type World } from './world';

export type Rig = {
    actors: Actors;
    adminApi: Api;
    instance: Instance;
    /** The browsers' device (`phone`: a 375 px phone at 2x, for the deck); default: the running project's. */
    device?: 'project' | 'desktop' | 'phone';
};

export type SettingsState =
    /** Supported, never subscribed: the "Turn on notifications" button. */
    | 'off'
    /** Subscribed, two registered browsers (this one marked), and the answer to a test notification that failed. */
    | 'on'
    /** The same without the failed test: the picture of a working setup. */
    | 'on-clean'
    /** Turned off for this browser. */
    | 'off-here'
    /** The browser blocked the site. */
    | 'blocked'
    /** A browser that cannot do push. */
    | 'unsupported'
    /** Quiet hours switched on with an overnight window, and the "same time" error. */
    | 'quiet-error';

/** A signed-in agent of a fresh world, with the browser stubs of `options`. */
export async function newAgent(
    rig: Rig,
    options: Parameters<typeof prepareBrowser>[1] = {},
    label = 'ann',
    existing?: World,
): Promise<{ world: World; agent: StaffActor }> {
    const world =
        existing ??
        (await createWorld(rig.adminApi, rig.instance, {
            agents: { [label]: ['main'] },
        }));
    const agent = await rig.actors.account(world.agents[label], {
        device: rig.device,
    });

    await prepareBrowser(agent, options);

    return { world, agent };
}

/** An agent who has decided about notifications already (no first-login dialog on top of the screens). */
export async function decidedAgent(
    rig: Rig,
    options: Parameters<typeof prepareBrowser>[1] = {},
): Promise<{ world: World; agent: StaffActor }> {
    const made = await newAgent(rig, options);

    await setNotificationRow(rig.instance, made.world.agents.ann.id, {
        prompt_state: 'denied',
    });

    return made;
}

/** Opens Settings > Notifications for a new agent in the given state and waits until the state is on screen. */
export async function settingsIn(
    rig: Rig,
    state: SettingsState,
): Promise<{ world: World; agent: StaffActor; page: Page }> {
    const permission = state === 'blocked' ? 'denied' : 'default';
    const { world, agent } = await newAgent(rig, {
        permission,
        subscription: FakeSubscription.dead(),
        without: state === 'unsupported' ? 'push-manager' : undefined,
    });
    const page = agent.page;

    await page.goto('/settings/notifications');
    await expect(page.getByTestId('notifications-prefs')).toBeVisible({
        timeout: 20_000,
    });

    if (state === 'on' || state === 'on-clean' || state === 'off-here') {
        // A second registered browser, so the list shows two rows.
        must(
            await agent.api.api.post(
                '/api/v1/me/push-subscriptions',
                FakeSubscription.dead().toJSON(),
            ),
            'a second browser',
        );
        await page.getByTestId('notifications-enable').click();
        await expect(page.getByTestId('notifications-test')).toBeVisible();
        await page.reload();
        await expect(page.getByTestId('notifications-devices')).toBeVisible();
        await expect(page.getByTestId('notifications-device')).toHaveCount(2);
    }

    if (state === 'on') {
        await page.getByTestId('notifications-test').click();
        await expect(
            page.getByTestId('notifications-test-result'),
        ).toContainText('did not accept');
    }

    if (state === 'off-here') {
        await page.getByTestId('notifications-disable').click();
        await expect(page.getByTestId('notifications-status')).toContainText(
            'You turned notifications off',
        );
    }

    if (state === 'quiet-error') {
        await page.getByTestId('notifications-quiet-enabled').click();
        await page.getByTestId('notifications-quiet-start').fill('22:00');
        await page.getByTestId('notifications-quiet-end').fill('07:00');
        await expect
            .poll(
                async () => (await notificationSettings(agent)).quietHours.end,
            )
            .toBe('07:00');
        await page.getByTestId('notifications-quiet-end').fill('22:00');
        await expect(
            page.getByText('Start and end must be different times.'),
        ).toBeVisible();
    }

    if (state === 'blocked') {
        await expect(page.getByTestId('notifications-status')).toContainText(
            'blocked',
        );
    }

    return { world, agent, page };
}

/** A never-asked agent on the inbox with the first-login dialog open. */
export async function dialogOpen(rig: Rig): Promise<{
    world: World;
    agent: StaffActor;
    page: Page;
}> {
    const { world, agent } = await newAgent(rig, {
        subscription: FakeSubscription.dead(),
    });

    await agent.inbox.goto();
    await expect(agent.page.getByTestId('notification-prompt')).toBeVisible({
        timeout: 15_000,
    });

    return { world, agent, page: agent.page };
}

export type Roster = {
    world: World;
    admin: StaffActor;
    online: StaffActor;
    away: StaffActor;
    offline: StaffActor;
};

/**
 * The agents page of the administrator with three agents of a world in the three states: Online (automatic), Away (pinned) and Offline. The
 * administrator has decided about notifications (no dialog), and so has everybody else.
 */
export async function agentsPage(rig: Rig): Promise<Roster> {
    const world = await createWorld(rig.adminApi, rig.instance, {
        agents: { ann: ['main'], ben: ['main'], cy: ['main'] },
    });
    const seed = readSeed(rig.instance);

    for (const id of [
        seed.users.admin,
        ...Object.values(world.agents).map((agent) => agent.id),
    ]) {
        await setNotificationRow(rig.instance, id, { prompt_state: 'denied' });
    }

    const online = await rig.actors.account(world.agents.ann);
    const away = await rig.actors.account(world.agents.ben);
    const offline = await rig.actors.account(world.agents.cy);
    // (These three only set a presence through the API: their browsers show nothing.)

    must(
        await online.api.setPresence('online', { automatic: true }),
        'Ann online',
    );
    must(await away.api.setPresence('away'), 'Ben away');
    must(await offline.api.setPresence('offline'), 'Cy offline');

    const admin = await rig.actors.staff('admin', {
        open: '/agents',
        device: rig.device,
    });

    await expect(admin.page.getByTestId('agents-list')).toBeVisible({
        timeout: 20_000,
    });
    await expect(
        admin.page.getByTestId(`agent-presence-${world.agents.ann.id}`),
    ).toHaveAttribute('data-status', 'online');
    await expect(
        admin.page.getByTestId(`agent-presence-${world.agents.ben.id}`),
    ).toHaveAttribute('data-status', 'away');

    return { world, admin, online, away, offline };
}

/** The inbox of an agent in a presence state (`online` shows the hint, `offline` the notice with "Go online"). */
export async function inboxIn(
    rig: Rig,
    status: 'online' | 'away' | 'offline',
): Promise<{ world: World; agent: StaffActor; page: Page }> {
    const { world, agent } = await decidedAgent(rig);

    if (status !== 'offline') {
        must(
            await agent.api.setPresence(status, {
                automatic: status === 'online',
            }),
            `presence ${status}`,
        );
    }

    await agent.inbox.goto();
    await expect(agent.inbox.tid('presence-select')).toHaveValue(status);

    return { world, agent, page: agent.page };
}

/**
 * The customer site with a live chat whose bubble is closed and `count` unread replies on the launcher (the alert state is on while it
 * runs). Returns the visitor's panel and launcher.
 */
export async function launcherWithBadge(
    rig: Rig,
    count: number,
    options: { width?: number } = {},
): Promise<{
    panel: Panel;
    launcher: Launcher;
    chat: Awaited<ReturnType<typeof startChat>>;
}> {
    // The agent has decided about notifications already: in a scenario with VAPID keys the first-login dialog would sit on top of the
    // inbox and swallow the click on "Accept".
    const world = await createWorld(rig.adminApi, rig.instance);

    await setNotificationRow(rig.instance, world.agents.ann.id, {
        prompt_state: 'denied',
    });

    const chat = await startChat(rig, {
        world,
        visitorName: 'Una Unread',
        prepareVisitor: async (visitor) => {
            if (options.width !== undefined) {
                await visitor.page.setViewportSize({
                    width: options.width,
                    height: 700,
                });
            }
        },
    });
    const launcher = new Launcher(chat.panel.page);

    await launcher.close();
    await expect(chat.panel.container).toBeHidden();

    for (let reply = 1; reply <= count; reply += 1) {
        must(
            await chat.agent.api.send(chat.ulid, `Reply number ${reply}`),
            `reply ${reply}`,
        );
    }

    await expect(launcher.badge).toHaveAttribute('data-show', 'true', {
        timeout: 30_000,
    });

    return { panel: chat.panel, launcher, chat };
}
