import { expect, test } from '../support/test';
import { expectEventually } from '../support/wait';
import { must, VisitorApi } from '../support/chat-api';
import { openNavigation } from '../support/helpers';
import {
    isPhone,
    readConversation,
    showList,
    titleCount,
    unseenOf,
} from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * "My chats" and the counters around it: ordering by last activity, unseen badges that grow with the visitor's messages and clear when
 * the agent looks, the `(n)` in the tab title, the sidebar badge, and the search / filter of the list. Own world per test.
 */
test.use({ scenario: 'p4-staff' });

test('waiting offers and unread messages are counted in the tab title and the sidebar badge, and the list orders by last activity', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const category = world.categories.main.slug;
    const alpha = await VisitorApi.start(instance, { key: world.widget.key });
    const beta = await VisitorApi.start(instance, { key: world.widget.key });
    const nav = async (): Promise<number> => {
        // On a phone the sidebar is a drawer behind the menu button: open it, read the badge, close it.
        if (isPhone(ann.page)) {
            await openNavigation(ann.page);
        }

        const badge = ann.page.getByTestId('nav-badge-inbox');
        const text =
            (await badge.count()) === 0 ? '0' : await badge.first().innerText();

        if (isPhone(ann.page)) {
            await ann.page.keyboard.press('Escape');
        }

        return Number.parseInt(text, 10) || 0;
    };

    expect(await titleCount(ann.page)).toBe(0);

    // Two chats start: two waiting requests.
    const first = must<{ ulid: string }>(
        await alpha.startChat({ category, name: 'Alpha Al' }),
        'first chat',
    );
    const second = must<{ ulid: string }>(
        await beta.startChat({ category, name: 'Beta Bo' }),
        'second chat',
    );

    await ann.inbox.expectOffer(first.ulid);
    await ann.inbox.expectOffer(second.ulid);
    await expect.poll(() => titleCount(ann.page)).toBe(2);
    await expect.poll(nav).toBe(2);

    // Ann takes both (Alpha first, then Beta; through the API, so no conversation is open on her screen: a chat that is on screen
    // never collects a badge): the offers are gone, and the newest chat is on top of the list.
    must(await ann.api.claim(first.ulid), 'Ann accepts the first chat');
    await expect(ann.inbox.chatRow(first.ulid)).toBeVisible();
    must(await ann.api.claim(second.ulid), 'Ann accepts the second chat');
    await expect(ann.inbox.chatRow(second.ulid)).toBeVisible();
    await expect(ann.inbox.chatRow(first.ulid)).toBeVisible();
    await expect.poll(() => titleCount(ann.page)).toBe(0);

    const order = async (): Promise<string[]> =>
        (
            await ann.inbox.mine
                .getByTestId(/^chat-row-[0-9a-z]{26}$/)
                .evaluateAll((rows) =>
                    rows.map((row) =>
                        row
                            .getAttribute('data-testid')!
                            .replace('chat-row-', ''),
                    ),
                )
        ).slice();

    await expect.poll(order).toEqual([second.ulid, first.ulid]);

    // Alpha writes twice: its badge counts them, its row moves to the top, the title and the sidebar follow.
    must(await alpha.send(first.ulid, 'Alpha one'), 'alpha writes');
    await expect.poll(() => unseenOf(ann, first.ulid)).toBe(1);
    await expect(ann.inbox.chatRow(first.ulid)).toContainText('Alpha one');
    await expect.poll(order).toEqual([first.ulid, second.ulid]);
    must(await alpha.send(first.ulid, 'Alpha two'), 'alpha writes again');
    await expect.poll(() => unseenOf(ann, first.ulid)).toBe(2);
    await expect.poll(() => titleCount(ann.page)).toBe(2);

    // Beta writes: another badge, the total is 3 and Beta's row is on top.
    must(await beta.send(second.ulid, 'Beta one'), 'beta writes');
    await expect.poll(() => unseenOf(ann, second.ulid)).toBe(1);
    await expect.poll(() => titleCount(ann.page)).toBe(3);
    await expect.poll(nav).toBe(3);
    await expect.poll(order).toEqual([second.ulid, first.ulid]);

    // Ann reads Alpha: its badge clears (here and on the server), the total drops to Beta's one message.
    await ann.inbox.chatRow(first.ulid).click();
    await expect(ann.inbox.conversation).toBeVisible();
    await ann.inbox.expectMessage('Alpha two');
    await expect.poll(() => titleCount(ann.page)).toBe(1);
    expect(
        (
            await expectEventually(
                () => readConversation(ann, first.ulid),
                (conversation) => conversation.unseenByAgent === 0,
                { message: 'the server cleared the unseen counter of Alpha' },
            )
        ).unseenByAgent,
    ).toBe(0);

    // While Ann is looking at Alpha a new message does not raise a badge there ...
    must(await alpha.send(first.ulid, 'Alpha three'), 'alpha writes a third');
    await ann.inbox.expectMessage('Alpha three');
    await expect.poll(() => titleCount(ann.page)).toBe(1);

    // ... and Beta's badge is still waiting on the list.
    await showList(ann);
    await expect.poll(() => unseenOf(ann, second.ulid)).toBe(1);
    expect(await unseenOf(ann, first.ulid)).toBe(0);

    await Promise.all([alpha.dispose(), beta.dispose()]);
});

test('"My chats" can be searched and filtered by unread, active and finished', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, {
        presence: 'online',
        open: '/inbox',
    });
    const category = world.categories.main.slug;
    const visitors = await Promise.all(
        [0, 1, 2].map(() =>
            VisitorApi.start(instance, { key: world.widget.key }),
        ),
    );
    const names = ['Quinn Quartz', 'Rhea Ruby', 'Sol Sapphire'];
    const ulids: string[] = [];

    for (const [index, visitor] of visitors.entries()) {
        const { ulid } = must<{ ulid: string }>(
            await visitor.startChat({ category, name: names[index] }),
            `chat ${index}`,
        );

        ulids.push(ulid);
        await ann.inbox.expectOffer(ulid);
        must(await ann.api.claim(ulid), `Ann accepts ${index}`);
        await expect(ann.inbox.chatRow(ulid)).toBeVisible();
    }

    // Rhea has an unread message, Sol's chat was ended by Ann.
    must(await visitors[1].send(ulids[1], 'Still waiting'), 'Rhea writes');
    await expect.poll(() => unseenOf(ann, ulids[1])).toBe(1);
    must(await ann.api.end(ulids[2]), 'Ann ends Sol');
    await expect(ann.inbox.chatRow(ulids[2])).toContainText('Ended');

    const visible = async (): Promise<number> =>
        ann.inbox.mine.getByTestId(/^chat-row-[0-9a-z]{26}$/).count();

    await expect.poll(visible).toBe(3);

    await ann.inbox.tid('inbox-filter-unread').click();
    await expect(ann.inbox.chatRow(ulids[1])).toBeVisible();
    await expect.poll(visible).toBe(1);

    await ann.inbox.tid('inbox-filter-finished').click();
    await expect(ann.inbox.chatRow(ulids[2])).toBeVisible();
    await expect.poll(visible).toBe(1);

    await ann.inbox.tid('inbox-filter-active').click();
    await expect.poll(visible).toBe(2);
    await expect(ann.inbox.chatRow(ulids[2])).toHaveCount(0);

    await ann.inbox.tid('inbox-filter-all').click();
    await expect.poll(visible).toBe(3);

    // Search by name, by the last message, and a search with no match.
    await ann.inbox.tid('inbox-search').fill('ruby');
    await expect.poll(visible).toBe(1);
    await expect(ann.inbox.chatRow(ulids[1])).toBeVisible();

    await ann.inbox.tid('inbox-search').fill('still waiting');
    await expect.poll(visible).toBe(1);

    await ann.inbox.tid('inbox-search').fill('nobody-by-this-name');
    await expect(ann.inbox.tid('inbox-mine-no-match')).toBeVisible();
    await expect.poll(visible).toBe(0);

    await ann.inbox.tid('inbox-search').fill('');
    await expect.poll(visible).toBe(3);

    await Promise.all(visitors.map((visitor) => visitor.dispose()));
});
