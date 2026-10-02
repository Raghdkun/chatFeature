import type { Page } from '@playwright/test';
import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { prepareBrowser, setNotificationRow } from '../support/notify';
import { setVisibility } from '../support/presence';
import {
    clickPageNotification,
    FakeSubscription,
    pageNotifications,
} from '../support/push';
import { createWorld, type World } from '../support/world';
import type { Actors, StaffActor } from '../support/actors';
import type { Api } from '../support/api';
import type { Instance } from '../support/scenarios';
import { expectEventually } from '../support/wait';

/**
 * What the PAGE itself shows when a chat request or a message arrives over the websocket (decision P5-D8): with the tab in front it is a toast
 * and a sound and nothing else; with the tab in the background and the permission granted it is an OS notification made by the page, tagged
 * like the server's push (`offer-<ulid>`, `chat-<ulid>`) so the browser replaces rather than doubles; quiet hours silence the notification
 * and not the toast. The page's `Notification` and the Web Audio oscillators are spies (e2e/support/push.ts): what they record is what the
 * person would have been shown / heard. Tab visibility is controlled from the spec.
 */
test.use({ scenario: 'p5-notify' });

type Rig = { actors: Actors; adminApi: Api; instance: Instance };

/** Counts the notes the page's sound player plays (it only plays once a click has unlocked the audio context). */
async function installSoundSpy(actor: StaffActor): Promise<void> {
    await actor.context.addInitScript(() => {
        const state = { notes: 0 };

        (window as unknown as Record<string, unknown>).__sound = state;

        const proto = AudioContext.prototype;
        const original = Reflect.get(proto, 'createOscillator') as (
            this: AudioContext,
        ) => OscillatorNode;

        proto.createOscillator = function (this: AudioContext) {
            state.notes += 1;

            return Reflect.apply(original, this, []);
        };
    });
}

const notes = (page: Page): Promise<number> =>
    page.evaluate(
        () =>
            (window as unknown as { __sound: { notes: number } }).__sound.notes,
    );

/** An online agent (granted permission, a registered browser) with the inbox open, her tab controllable, and a world to chat in. */
async function onlineAgent(
    rig: Rig,
    options: {
        permission?: NotificationPermission;
        agents?: Record<string, string[]>;
    } = {},
): Promise<{ world: World; ann: StaffActor; ben?: StaffActor }> {
    const world = await createWorld(rig.adminApi, rig.instance, {
        agents: options.agents ?? { ann: ['main'] },
    });
    const ann = await rig.actors.account(world.agents.ann);

    await prepareBrowser(ann, {
        permission: options.permission ?? 'granted',
        subscription: FakeSubscription.dead(),
        visibility: true,
    });
    await installSoundSpy(ann);
    await ann.inbox.goto();
    await ann.inbox.tid('presence-go-online').click();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    // The first click on the page is the gesture that lets the browser play sounds.
    await ann.page.locator('body').click({ position: { x: 5, y: 5 } });

    return { world, ann };
}

async function startVisitorChat(
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

const toast = (page: Page, text: string) =>
    page.locator('[data-sonner-toast]').filter({ hasText: text });

test('with the tab in front a chat request is a toast and a sound, never an OS notification', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { world, ann } = await onlineAgent({ actors, adminApi, instance });
    const before = await notes(ann.page);
    const { api, ulid } = await startVisitorChat(
        { actors, adminApi, instance },
        world,
        'Foreground Faye',
    );

    await ann.inbox.expectOffer(ulid);
    await expect(toast(ann.page, 'New chat request')).toBeVisible();
    await expect(toast(ann.page, 'New chat request')).toContainText(
        'Foreground Faye',
    );

    // The three-note arpeggio of an offer was played ...
    await expect.poll(() => notes(ann.page)).toBeGreaterThanOrEqual(before + 3);
    // ... and the page made no notification of its own (the server's push is not sent either: she is looking).
    expect(await pageNotifications(ann.page)).toEqual([]);

    await api.dispose();
});

test("with the tab in the background an offer is an OS notification made by the page with the server's tag; a click opens the chat, and when a colleague takes it the notification is closed", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann } = await onlineAgent(rig, {
        agents: { ann: ['main'], ben: ['main'] },
    });
    const ben = await actors.account(world.agents.ben, { presence: 'online' });

    await setVisibility(ann.page, 'hidden');

    const { api, ulid } = await startVisitorChat(
        rig,
        world,
        'Background Bea',
        'Do you ship to Oslo?',
    );

    // The offer card still arrives in the (hidden) tab; the notification is the page's own, the same tag as the server's push.
    await ann.inbox.expectOffer(ulid);

    const shown = await expectEventually(
        () => pageNotifications(ann.page),
        (list) => list.length >= 1,
        { message: 'the page showed a notification' },
    );

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('New chat request');
    expect(shown[0].options.tag).toBe(`offer-${ulid}`);
    expect(shown[0].options.body).toContain('Background Bea');
    expect(shown[0].closed).toBe(false);

    // A colleague takes the chat: the offer leaves the queue and the notification is closed (no stale "new chat" left on the desktop).
    must(await ben.api.claim(ulid), 'Ben takes the chat');
    await ann.inbox.expectNoOffer(ulid);
    await expect
        .poll(async () => (await pageNotifications(ann.page))[0].closed)
        .toBe(true);

    // The next chat: a click on the notification brings the agent to the conversation (and the claim is hers).
    const second = await startVisitorChat(rig, world, 'Second Sam');

    await ann.inbox.expectOffer(second.ulid);
    await expect
        .poll(async () => (await pageNotifications(ann.page)).length)
        .toBe(2);
    expect((await pageNotifications(ann.page))[1].options.tag).toBe(
        `offer-${second.ulid}`,
    );

    await clickPageNotification(ann.page, 1);
    await expect(ann.page).toHaveURL(new RegExp(`/inbox/${second.ulid}$`));

    await Promise.all([api.dispose(), second.api.dispose()]);
});

test("a visitor message in a chat the agent handles: tag chat-<ulid> (the page's message tag is mapped to the server's) and the visitor's name; nothing while the tab is in front", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann } = await onlineAgent(rig);
    const { api, ulid } = await startVisitorChat(rig, world, 'Message Max');

    await ann.inbox.expectOffer(ulid);
    await ann.inbox.accept(ulid);

    // In front: the sound and the unread bookkeeping, no OS notification.
    must(await api.send(ulid, 'First one, tab in front'), 'a message');
    await ann.inbox.expectMessage('First one, tab in front');
    expect(await pageNotifications(ann.page)).toEqual([]);

    // In the background: the notification, under the server's tag for the chat.
    await setVisibility(ann.page, 'hidden');
    must(
        await api.send(ulid, 'Second one, tab in the background'),
        'a message',
    );

    const shown = await expectEventually(
        () => pageNotifications(ann.page),
        (list) => list.length >= 1,
        { message: 'the page showed a notification for the message' },
    );

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe('New message from Message Max');
    expect(shown[0].options.tag).toBe(`chat-${ulid}`);

    await api.dispose();
});

// Regression (found by this spec): the page notified when `unread.updated` arrived and took the body from the conversation it held, whose
// preview only changes with the `conversation.updated` that the server sends right after it, so the notification carried the PREVIOUS
// message's words. The controller now waits for that update (at most 400 ms) before it builds the notification.
test("a visitor message notification carries the newest message's words, not the previous one's", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann } = await onlineAgent(rig);
    const { api, ulid } = await startVisitorChat(rig, world, 'Message Max');

    await ann.inbox.expectOffer(ulid);
    await ann.inbox.accept(ulid);
    must(await api.send(ulid, 'First one, tab in front'), 'a message');
    await ann.inbox.expectMessage('First one, tab in front');
    await setVisibility(ann.page, 'hidden');
    must(
        await api.send(ulid, 'Second one, tab in the background'),
        'a message',
    );

    const shown = await expectEventually(
        () => pageNotifications(ann.page),
        (list) => list.length >= 1,
        { message: 'the page showed a notification for the message' },
    );

    expect(shown[0].options.body).toBe('Second one, tab in the background');

    await api.dispose();
});

test("quiet hours silence the page's notification (the toast and the sound still go), and ending them brings it back; a browser without the permission shows nothing at all", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann } = await onlineAgent(rig);

    // A window around the present moment in UTC (start after end: an overnight window, which a midnight inside it cannot break).
    const at = (offsetHours: number): string => {
        const moment = new Date(Date.now() + offsetHours * 3_600_000);

        return `${String(moment.getUTCHours()).padStart(2, '0')}:${String(moment.getUTCMinutes()).padStart(2, '0')}`;
    };

    must(
        await ann.api.api.put('/api/v1/me/notification-settings', {
            quiet_hours: {
                enabled: true,
                start: at(-1),
                end: at(1),
                timezone: 'UTC',
            },
        }),
        'quiet hours now',
    );
    // The page reads the settings when it loads.
    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await ann.page.locator('body').click({ position: { x: 5, y: 5 } });
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await setVisibility(ann.page, 'hidden');

    const quiet = await startVisitorChat(rig, world, 'Quiet Quinn');

    await ann.inbox.expectOffer(quiet.ulid);
    await expect(toast(ann.page, 'New chat request')).toBeVisible();
    expect(await pageNotifications(ann.page)).toEqual([]);

    // The quiet hours end (the window moves to the past): the next request notifies.
    must(
        await ann.api.api.put('/api/v1/me/notification-settings', {
            quiet_hours: { enabled: false },
        }),
        'quiet hours off',
    );
    await ann.page.reload();
    await expect(ann.inbox.tid('presence-select')).toHaveValue('online');
    await setVisibility(ann.page, 'hidden');

    const loud = await startVisitorChat(rig, world, 'Loud Lou');

    await expect
        .poll(async () => (await pageNotifications(ann.page)).length)
        .toBe(1);
    expect((await pageNotifications(ann.page))[0].options.tag).toBe(
        `offer-${loud.ulid}`,
    );

    await Promise.all([quiet.api.dispose(), loud.api.dispose()]);
});

test("without the browser's permission the page shows no notification, in the background or not (the toast and the unread count still tell the agent)", async ({
    actors,
    adminApi,
    instance,
}) => {
    const rig = { actors, adminApi, instance };
    const { world, ann } = await onlineAgent(rig, { permission: 'default' });

    // (The first-login dialog may be on top: decide it so it cannot get in the way of the inbox.)
    await setNotificationRow(instance, world.agents.ann.id, {
        prompt_state: 'denied',
    });
    await ann.page.reload();
    await expect(ann.inbox.tid('inbox')).toBeVisible();
    await setVisibility(ann.page, 'hidden');

    const { api, ulid } = await startVisitorChat(
        rig,
        world,
        'No Permission Pat',
    );

    await ann.inbox.expectOffer(ulid);
    await expect(toast(ann.page, 'New chat request')).toBeVisible();
    expect(await pageNotifications(ann.page)).toEqual([]);

    await api.dispose();
});
