import { expect, test } from '../support/test';
import { must } from '../support/chat-api';
import { installAlertTracker, Launcher } from '../support/launcher';
import { installVisibilityControl, setVisibility } from '../support/presence';
import { readMessages } from '../support/staff-ui';
import { startChat, type ChatRig } from '../support/staff-flow';
import { expectEventually } from '../support/wait';

/**
 * The closed-bubble alert chain on the customer site with the REAL panel and a real agent (docs/widget-embed-api.md, "Unread badge and reply
 * alert"): an agent's reply reaches the panel that stays alive (hidden) behind the closed bubble, the loader shows the count and runs the
 * alert, the label tells a screen reader, bursts are coalesced to one alert per 8 s, a hidden tab owes the alert until it is visible, and
 * opening reports the replies as seen. The visitor's page runs on a fake clock where time matters (it keeps flowing, and `fastForward` skips
 * the waits). Every test has its own world.
 */
test.use({ scenario: 'p5-chat' });

type Rigging = {
    clock?: boolean;
    visibility?: boolean;
};

/** An accepted chat with the visitor's bubble CLOSED and a recorder counting alerts. */
async function closedBubble(
    rig: { actors: any; adminApi: any; instance: any },
    options: Rigging = {},
): Promise<ChatRig & { launcher: Launcher }> {
    const chat = await startChat(rig, {
        visitorName: 'Una Unread',
        prepareVisitor: async (visitor) => {
            await installAlertTracker(visitor.context);

            if (options.clock) {
                await visitor.page.clock.install();
            }

            if (options.visibility) {
                await installVisibilityControl(visitor.context);
            }
        },
    });
    const launcher = new Launcher(chat.panel.page);

    await launcher.close();
    await expect(chat.panel.container).toBeHidden();

    return { ...chat, launcher };
}

const label = (count: number): RegExp =>
    new RegExp(`, ${count} unread messages$`);

test('a reply to a closed bubble: the panel behind it is alive, the badge shows the count, the label says it, the alert runs once and ends', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher, panel } = await closedBubble({
        actors,
        adminApi,
        instance,
    });
    const page = panel.page;

    // The panel is not torn down when the bubble closes: its iframe stays in the page, hidden and inert, connected to the realtime channel.
    const iframe = page.locator('pne-chat-widget .panel iframe');

    await expect(iframe).toHaveCount(1);
    await expect(page.locator('pne-chat-widget .panel')).toHaveAttribute(
        'data-open',
        'false',
    );
    expect(await launcher.count()).toBe(0);
    await expect(launcher.button).toHaveAttribute('data-alert', 'false');

    must(
        await agent.api.send(ulid, 'First reply while you were away'),
        'a reply',
    );

    // The badge, its accessible name and the announcement: the badge itself is hidden from assistive technology, the button carries the number.
    await expect(launcher.badge).toHaveAttribute('data-show', 'true');
    await expect(launcher.badge).toHaveText('1');
    await expect(launcher.badge).toHaveAttribute('aria-hidden', 'true');
    await expect(launcher.button).toHaveAttribute('aria-label', label(1));
    await expect(launcher.announcement).toHaveText(label(1));

    // The alert state runs for a moment (a hop and a ring) and then ends by itself.
    await expect(launcher.button).toHaveAttribute('data-alert', 'true');
    expect(
        await launcher.card.evaluate(
            (card) => getComputedStyle(card).animationName,
        ),
    ).toContain('hop');
    expect(
        await launcher.ring.evaluate(
            (ring) => getComputedStyle(ring).animationName,
        ),
    ).toContain('ring');
    expect(await launcher.alerts()).toBe(1);
    await expect(launcher.button).toHaveAttribute('data-alert', 'false', {
        timeout: 10_000,
    });

    // Host code sees the same number, and the event fired for the change.
    expect(await launcher.stateUnread()).toBe(1);
    expect(await launcher.unreadEvents()).toContain(1);
    expect(await launcher.alerts()).toBe(1);
});

test('with reduced motion nothing moves: the alert is a steady accent halo instead of the hop and the expanding ring', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher, panel } = await closedBubble({
        actors,
        adminApi,
        instance,
    });

    await panel.page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(launcher.root).toHaveAttribute('data-motion', 'reduced');

    must(
        await agent.api.send(ulid, 'A reply for a visitor who prefers calm'),
        'a reply',
    );
    await expect(launcher.button).toHaveAttribute('data-alert', 'true');

    const looks = await launcher.ring.evaluate((ring) => {
        const style = getComputedStyle(ring);

        return {
            animation: style.animationName,
            border: style.borderTopWidth,
            opacity: style.opacity,
        };
    });
    const card = await launcher.card.evaluate(
        (element) => getComputedStyle(element).animationName,
    );

    expect(card).toBe('none');
    expect(looks.animation).toBe('none');
    expect(looks.border).toBe('3px');
    // (The ring fades in with the alert state: wait for the end of that transition.)
    await expect
        .poll(() =>
            launcher.ring.evaluate((ring) => getComputedStyle(ring).opacity),
        )
        .toBe('1');

    // The badge and the label are the same: the count is what matters, not the movement.
    await expect(launcher.badge).toHaveText('1');
    await expect(launcher.button).toHaveAttribute('aria-label', label(1));
});

test('a burst of replies is one alert: the badge follows every message, a reply after the 8 second gap alerts again', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher } = await closedBubble(
        { actors, adminApi, instance },
        { clock: true },
    );

    for (const text of ['one', 'two', 'three', 'four']) {
        must(await agent.api.send(ulid, text), `reply ${text}`);
    }

    await expect(launcher.badge).toHaveText('4');
    await expect(launcher.button).toHaveAttribute('aria-label', label(4));
    expect(await launcher.alerts()).toBe(1);

    // Every change of the count was an event, but only one alert ran.
    await expect
        .poll(async () => (await launcher.unreadEvents()).slice(-4))
        .toEqual([1, 2, 3, 4]);

    // More replies inside the window only move the badge ...
    await launcher.page.clock.fastForward(4_000);
    must(await agent.api.send(ulid, 'five'), 'reply five');
    await expect(launcher.badge).toHaveText('5');
    expect(await launcher.alerts()).toBe(1);

    // ... a burst that goes on past 8 seconds alerts again.
    await launcher.page.clock.fastForward(5_000);
    must(await agent.api.send(ulid, 'six'), 'reply six');
    await expect(launcher.badge).toHaveText('6');
    await expect.poll(() => launcher.alerts()).toBe(2);
});

test('a hidden tab owes the alert: the replies are counted but nothing moves or sounds until the tab is visible again, and hiding it again cancels the wait', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher, panel } = await closedBubble(
        { actors, adminApi, instance },
        { clock: true, visibility: true },
    );
    const page = panel.page;

    // The tab goes to the background; a reply arrives.
    await setVisibility(page, 'hidden');
    must(await agent.api.send(ulid, 'Reply into a background tab'), 'a reply');
    await expect(launcher.badge).toHaveText('1');
    await expect(launcher.button).toHaveAttribute('aria-label', label(1));
    await page.clock.fastForward(5_000);
    expect(await launcher.alerts()).toBe(0);
    await expect(launcher.button).toHaveAttribute('data-alert', 'false');

    // Back in front and hidden again before the 1.5 s the loader waits (the panel re-syncs meanwhile): still no alert.
    await setVisibility(page, 'visible');
    await page.clock.fastForward(1_000);
    await setVisibility(page, 'hidden');
    await page.clock.fastForward(3_000);
    expect(await launcher.alerts()).toBe(0);

    // In front for good: the alert that was owed runs once, 1.5 s after the tab became visible.
    await setVisibility(page, 'visible');
    await page.clock.fastForward(1_000);
    expect(await launcher.alerts()).toBe(0);
    await page.clock.fastForward(1_000);
    await expect.poll(() => launcher.alerts()).toBe(1);
    await expect(launcher.button).toHaveAttribute('data-alert', 'true');
    expect(await launcher.count()).toBe(1);
});

test('opening the bubble clears the badge and the agent sees the replies as seen; closing never brings the count back; the next reply counts again', async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher, panel } = await closedBubble({
        actors,
        adminApi,
        instance,
    });

    must(await agent.api.send(ulid, 'Reply one'), 'reply one');
    must(await agent.api.send(ulid, 'Reply two'), 'reply two');
    await expect(launcher.badge).toHaveText('2');

    // Nothing has been read yet: the agent's messages are delivered, not seen.
    const before = await readMessages(agent, ulid);

    expect(
        before
            .filter(
                (message) =>
                    message.sender.type === 'agent' && message.type === 'text',
            )
            .every((message) => message.seenAt === null),
    ).toBe(true);

    // Opening: the badge goes at once, the label loses the count, the host is told 0.
    await launcher.open();
    await expect(panel.container).toBeVisible();
    await expect(panel.root).toBeVisible();
    await expect(launcher.badge).toHaveAttribute('data-show', 'false');
    await expect(launcher.button).not.toHaveAttribute('aria-label', /unread/);
    expect(await launcher.stateUnread()).toBe(0);
    expect((await launcher.unreadEvents()).at(-1)).toBe(0);
    await expect(launcher.announcement).toHaveText('');

    // The panel reports what it showed as seen, and the agent's own view of the chat ticks to "seen".
    await panel.expectMessage('Reply two', 'agent');
    await expectEventually(
        () => readMessages(agent, ulid),
        (messages) =>
            messages
                .filter(
                    (message) =>
                        message.sender.type === 'agent' &&
                        message.type === 'text',
                )
                .every((message) => message.seenAt !== null),
        { message: "the agent's messages are seen" },
    );
    await expect(
        agent.inbox.conversation
            .getByTestId('message-list')
            .locator(
                'li[data-testid^="message-"][data-sender="agent"][data-status="seen"]',
            )
            .filter({ hasText: 'Reply two' }),
    ).toBeVisible();

    // Closing again: nothing comes back, there was nothing new.
    await launcher.close();
    await expect(panel.container).toBeHidden();
    expect(await launcher.count()).toBe(0);
    expect(await launcher.stateUnread()).toBe(0);

    // A reply after the close is new: it counts (1, not 3).
    must(await agent.api.send(ulid, 'Reply three'), 'reply three');
    await expect(launcher.badge).toHaveText('1');
    await expect(launcher.button).toHaveAttribute('aria-label', label(1));
});

test("own messages and system lines never count: only an agent's words do (a transfer's system lines included), and an ended chat shows no badge at all", async ({
    actors,
    adminApi,
    instance,
}) => {
    const { agent, ulid, launcher, panel, world } = await closedBubble({
        actors,
        adminApi,
        instance,
    });
    const ben = await actors.account(world.agents.ben, {
        presence: 'online',
        open: '/inbox',
    });

    // The visitor's own message (sent from the panel while the bubble is open) is not unread, not even after closing the bubble.
    await launcher.open();
    await panel.send('Hello from the visitor');
    await panel.expectMessage('Hello from the visitor', 'visitor');
    await launcher.close();
    await expect(panel.container).toBeHidden();
    expect(await launcher.count()).toBe(0);

    // The agent hands the chat to a colleague while the bubble is closed: system lines ("connecting you to another agent", "Ben joined")
    // appear in the transcript but are not replies.
    must(
        await agent.api.transfer(ulid, { agent_id: world.agents.ben.id }),
        'the transfer',
    );
    await ben.inbox.expectOffer(ulid);
    await ben.inbox.accept(ulid);
    await expectEventually(
        () => readMessages(ben, ulid),
        (messages) =>
            messages.filter((message) => message.sender.type === 'system')
                .length >= 2,
        { message: 'the transfer left its system lines' },
    );
    expect(await launcher.count()).toBe(0);
    expect(await launcher.stateUnread()).toBe(0);
    await expect(launcher.button).toHaveAttribute('data-alert', 'false');
    expect(await launcher.alerts()).toBe(0);

    // The new agent's words do count.
    must(await ben.api.send(ulid, 'Ben here, one moment'), 'Ben writes');
    must(await ben.api.send(ulid, 'Still here'), 'Ben writes again');
    await expect(launcher.badge).toHaveText('2');
    expect(await launcher.alerts()).toBe(1);

    // The chat ends: whatever was unread, an ended chat shows no badge and no count anywhere.
    must(await ben.api.end(ulid), 'Ben ends the chat');
    await expect(launcher.badge).toHaveAttribute('data-show', 'false');
    await expect(launcher.button).not.toHaveAttribute('aria-label', /unread/);
    expect(await launcher.stateUnread()).toBe(0);
    expect((await launcher.unreadEvents()).at(-1)).toBe(0);

    // The visitor opens the bubble: the ended chat (the rating screen), and still no count on the launcher once it is closed again.
    await launcher.open();
    await panel.expectState('ended');
    await launcher.close();
    expect(await launcher.count()).toBe(0);
});
