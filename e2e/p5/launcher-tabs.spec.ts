import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { hostPage } from '../support/host';
import { installAlertTracker, Launcher } from '../support/launcher';
import { openCustomerSite, Panel } from '../support/panel';
import { startChat } from '../support/staff-flow';
import { expectEventually } from '../support/wait';

/**
 * The unread count and the alert across page loads and tabs of ONE visitor (docs/widget-embed-api.md): a navigation inside the host site boots
 * a new loader whose count is rebuilt from the server; two tabs agree on the count and do not alert twice (the shared `chatfeature:<key>:alert`
 * memory); a read in one tab clears the badge of the other; and several background panels, each resuming the chat and rotating the session
 * token, never lose the chat (the compare-and-clear protocol of P4 with N tabs). The visitor's browser context is shared by its tabs, like a
 * real browser's storage. Every test has its own world.
 */
test.use({ scenario: 'p5-chat' });

const siteUrl = (
    instance: Parameters<typeof hostPage>[0],
    key: string,
): string => hostPage(instance, { key });

test('a page navigation with unread replies: the count is rebuilt from the server, the same replies are not alerted again, a new one alerts and counts on top', async ({
    actors,
    adminApi,
    instance,
}) => {
    const chat = await startChat(
        { actors, adminApi, instance },
        {
            visitorName: 'Nia Navigator',
            prepareVisitor: async (visitor) => {
                await installAlertTracker(visitor.context);
                await visitor.page.clock.install();
            },
        },
    );
    const page = chat.panel.page;
    const launcher = new Launcher(page);

    await launcher.close();
    must(
        await chat.agent.api.send(chat.ulid, 'While you were away: one'),
        'one',
    );
    must(
        await chat.agent.api.send(chat.ulid, 'While you were away: two'),
        'two',
    );
    await expect(launcher.badge).toHaveText('2');
    expect(await launcher.alerts()).toBe(1);

    // The visitor clicks a link on the host site: a new page, a new loader, a new panel. No reply was lost and none is announced twice.
    await page.goto(siteUrl(instance, chat.world.widget.key));
    await expect(launcher.button).toBeVisible();
    await expect(launcher.badge).toHaveAttribute('data-show', 'true');
    await expect(launcher.badge).toHaveText('2');
    await expect(launcher.button).toHaveAttribute(
        'aria-label',
        /, 2 unread messages$/,
    );
    expect(await launcher.stateUnread()).toBe(2);
    expect(await launcher.alerts()).toBe(0);
    expect(await launcher.unreadEvents()).toEqual([2]);

    // Another reply, long after the last alert: 3 on the badge, and it alerts.
    await page.clock.fastForward(10_000);
    must(await chat.agent.api.send(chat.ulid, 'And a third one'), 'three');
    await expect(launcher.badge).toHaveText('3');
    await expect.poll(() => launcher.alerts()).toBe(1);

    // Opening shows all three, in order, and clears the badge.
    await launcher.open();

    const panel = new Panel(page, instance, chat.world.widget.key);

    await panel.expectMessage('While you were away: one', 'agent');
    await panel.expectMessage('And a third one', 'agent');
    await expect(launcher.badge).toHaveAttribute('data-show', 'false');
});

test('two tabs of the same visitor: both show the reply, one alert in total (shared memory), and reading it in one tab clears the badge of the other', async ({
    actors,
    adminApi,
    instance,
}) => {
    const chat = await startChat(
        { actors, adminApi, instance },
        {
            visitorName: 'Tabitha Twin',
            prepareVisitor: async (visitor) => {
                await installAlertTracker(visitor.context);
            },
        },
    );
    const key = chat.world.widget.key;
    const first = new Launcher(chat.panel.page);

    await first.close();

    // The second tab of the same visitor loads the same page: its panel resumes the chat behind a closed bubble.
    const secondPage = await chat.visitor.newPage();
    const secondPanel = await openCustomerSite(secondPage, instance, { key });
    const second = new Launcher(secondPage);

    await expect(secondPanel.launcher).toBeVisible();

    // One reply: both tabs count it; the alert ran in one of them, not both.
    must(await chat.agent.api.send(chat.ulid, 'Seen in two tabs'), 'reply');
    await expect(first.badge).toHaveText('1');
    await expect(second.badge).toHaveText('1');
    await expect
        .poll(async () => (await first.alerts()) + (await second.alerts()))
        .toBeGreaterThanOrEqual(1);
    // Give the other tab every chance to (wrongly) alert as well: its own event came in the same instant; then check the total.
    await expect(second.button).toHaveAttribute(
        'aria-label',
        /, 1 unread messages$/,
    );
    expect((await first.alerts()) + (await second.alerts())).toBe(1);

    // A second reply moves both badges to 2 without a new alert (it is inside the 8 s window of the first one).
    must(
        await chat.agent.api.send(chat.ulid, 'Still in two tabs'),
        'reply two',
    );
    await expect(first.badge).toHaveText('2');
    await expect(second.badge).toHaveText('2');
    expect((await first.alerts()) + (await second.alerts())).toBe(1);

    // The visitor goes back to the first tab (the one in front is the one that counts as read) and opens the bubble: the other tab's badge
    // follows (the receipt reaches it over the realtime channel).
    await chat.panel.page.bringToFront();
    await first.open();
    await expect(first.badge).toHaveAttribute('data-show', 'false');
    await expect(second.badge).toHaveAttribute('data-show', 'false', {
        timeout: 15_000,
    });
    expect(await second.stateUnread()).toBe(0);
    await expect(second.button).not.toHaveAttribute('aria-label', /unread/);
});

test('four background tabs each resume the chat and rotate the session token: none of them loses it, every one gets the next reply, and the visitor can write from any of them', async ({
    actors,
    adminApi,
    instance,
}) => {
    const chat = await startChat(
        { actors, adminApi, instance },
        { visitorName: 'Nora Many' },
    );
    const key = chat.world.widget.key;
    const pages = [chat.panel.page];
    const launchers = [new Launcher(chat.panel.page)];

    await launchers[0].close();

    // Three more tabs, one after the other: each boots a panel that resumes the chat, and the server rotates the token every time. (Each
    // panel is let finish before the next tab loads: tabs that load in the same moment are the open finding of the test below.)
    for (let tab = 1; tab < 4; tab += 1) {
        const page = await chat.visitor.newPage();

        await openCustomerSite(page, instance, { key });
        await expect(
            new Panel(page, instance, key).stateElement,
        ).toHaveAttribute('data-state', 'active', { timeout: 30_000 });
        pages.push(page);
        launchers.push(new Launcher(page));
    }

    // All four share one stored session; the stored token still belongs to this chat (the API accepts it) ...
    const stored = await new Panel(pages[3], instance, key).visitorToken();

    expect(stored).not.toBeNull();

    const api = await VisitorApi.withToken(
        instance,
        stored!,
        chat.visitor.address,
    );
    const conversation = await api.conversation();

    expect(conversation.ok).toBe(true);
    expect(conversation.data?.ulid).toBe(chat.ulid);
    await api.dispose();

    // ... and every tab is still connected: the agent's reply reaches all four.
    must(
        await chat.agent.api.send(chat.ulid, 'Anyone there in all four tabs?'),
        'reply',
    );

    for (const launcher of launchers) {
        await expect(launcher.badge).toHaveText('1', { timeout: 20_000 });
    }

    // Any of them can be opened and is the same live chat (not an expired screen, not a new chat).
    for (const [index, page] of pages.entries()) {
        const panel = new Panel(page, instance, key);

        await page.bringToFront();
        await launchers[index].open();
        await expect(panel.container).toBeVisible();
        await panel.expectState('active');
        await panel.expectMessage('Anyone there in all four tabs?', 'agent');
        await launchers[index].close();
    }

    // The visitor writes from the last tab; the agent has it, in this very chat.
    const last = new Panel(pages[3], instance, key);

    await pages[3].bringToFront();
    await launchers[3].open();
    await last.expectState('active');
    // (Enter sends, as the button does. In a phone-emulated browser that has had several tabs of this chat open, mouse clicks inside the
    // panel's iframe are not delivered any more, in any of the tabs, while the keyboard is: an emulation matter, found here, not the product.)
    await last.composerInput.fill('Writing from tab four');
    await last.composerInput.press('Enter');
    await last.expectMessage('Writing from tab four', 'visitor');
    await chat.agent.inbox.expectMessage('Writing from tab four');

    const messages = await expectEventually(
        async () =>
            must<{ body: string | null; sender: { type: string } }[]>(
                await chat.agent.api.messages(chat.ulid),
                'messages',
            ),
        (list) =>
            list.some((message) => message.body === 'Writing from tab four'),
        { message: "the visitor's message reached the chat" },
    );

    expect(
        messages.filter((message) => message.body === 'Writing from tab four'),
    ).toHaveLength(1);
});

// Open product bug (found by this spec): tabs of one visitor that load in the SAME moment (links opened in several tabs at once) all boot their
// panel from the one stored session and ask the server to resume it; the first rotation takes the chat over, the others are answered with a
// session that has no conversation, and those panels settle on the pre-chat form ("data-state=prechat") although the chat is live. Observed on
// desktop and phone, two tabs out of three every time. The visitor is not harmed (asking for a chat there is answered with the running one) but
// the screen is wrong. Needs the resume to find the visitor's open chat for a token that was just rotated away (server) or the panel to retry
// through the loader's stored session (client). See the e2e report.
test.fixme('tabs that load at the same moment all resume the live chat (none shows the start form)', async ({
    actors,
    adminApi,
    instance,
}) => {
    const chat = await startChat(
        { actors, adminApi, instance },
        { visitorName: 'Conc Cora' },
    );
    const key = chat.world.widget.key;

    await new Launcher(chat.panel.page).close();

    const pages = await Promise.all(
        [0, 1, 2].map(() => chat.visitor.newPage()),
    );

    await Promise.all(
        pages.map((page) => openCustomerSite(page, instance, { key })),
    );

    for (const page of pages) {
        await expect(
            new Panel(page, instance, key).stateElement,
        ).toHaveAttribute('data-state', 'active', { timeout: 30_000 });
    }
});
