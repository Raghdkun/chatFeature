import { must, VisitorApi } from '../support/chat-api';
import {
    ageConversation,
    readConversationRow,
    runSweep,
} from '../support/chat-db';
import {
    createTeam,
    expect,
    startActiveChat,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { recordedEvents } from '../support/host';
import { expectEventually } from '../support/wait';

/**
 * How a live chat ends and what happens to the rating, through the real panel on the customer site, the agent's inbox and the
 * administrator's history, with the persisted truth (`readConversationRow`) checked after every step:
 *
 *  - the visitor ends it and rates 1-5 with a comment (stored; the administrator sees the score in the history),
 *  - the agent ends it and the visitor skips the rating (`skipped`, no rating row),
 *  - the rating window closes (`chat:close-unrated`, reason `timeout`) and a late rating is `409 rating_window_closed`,
 *  - the idle sweep (`chat:close-idle`, reason `idle`) closes an active chat without a rating prompt,
 *  - a visitor cancels while queued (`cancelled`, the agents' offers leave; the 10 s cooldown after a cancel is per visitor),
 *  - a widget with the rating feature off goes straight to `closed` / `skipped`.
 *
 * Time moves only through `ageConversation()` + `runSweep()`. The seeded Alice serves Billing and General; widgets of their own come
 * from `createTeam()` so nothing here changes what the other files of this scenario see.
 */
test.use({ scenario: 'p4-chat' });
// Several browsers per test, and the machine also runs other suites: the per-test budget is generous (a test takes 3-12 s on a quiet machine).
test.setTimeout(120_000);

test('the visitor ends the chat and rates it 4 with a comment: stored, and the administrator sees the score in the history', async ({
    actors,
    chats,
    instance,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid, ticketNo, visitor } = await startActiveChat(
        actors,
        instance,
        chats,
        alice,
        { category: 'billing', name: 'Vera Visitor' },
    );

    await panel.send('Where is my invoice for March?');
    await alice.inbox.expectMessage('invoice for March');
    await alice.inbox.send('Sending it to you now.');
    await panel.expectMessage('Sending it to you now', 'agent');

    // The visitor ends the chat from the header and confirms.
    await panel.endChat();
    await panel.expectState('ended');
    await expect(panel.tid('rating-stars')).toBeVisible();

    const ended = await expectEventually(
        () => readConversationRow(instance, ulid),
        (row) => row.conversation.status === 'ended',
        { message: 'the visitor ending the chat is stored' },
    );

    expect(ended.conversation).toMatchObject({
        status: 'ended',
        ended_by: 'visitor',
    });
    expect(ended.rating).toBeNull();
    // The agent's inbox learns it too: the composer is gone for a chat that has ended.
    expect(
        must<{ status: string }>(
            await alice.api.conversation(ulid),
            'Alice reads the ended chat',
        ).status,
    ).toBe('ended');

    await panel.rate(4, 'Helpful, thank you.');
    await panel.expectState('closed');

    const closed = await expectEventually(
        () => readConversationRow(instance, ulid),
        (row) => row.conversation.status === 'closed',
        { message: 'the rating closes the chat' },
    );

    expect(closed.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'rated',
        ended_by: 'visitor',
    });
    expect(closed.rating).toMatchObject({
        score: 4,
        comment: 'Helpful, thank you.',
    });
    expect(closed.events.map((event) => event.type)).toEqual(
        expect.arrayContaining(['ended', 'rated']),
    );

    // The customer's page heard about it through the documented host events (names and counts, never the text).
    const events = await recordedEvents(visitor.page);

    expect(events.map((event) => event.name)).toEqual(
        expect.arrayContaining([
            'chat-started',
            'agent-joined',
            'message-sent',
            'message-received',
            'chat-ended',
            'rating-submitted',
        ]),
    );

    // The administrator finds the chat by its ticket number in the history and sees the score (the comment is the tooltip).
    const admin = await actors.staff('admin');

    await admin.page.goto(`/history?q=${ticketNo}`);

    const row = admin.page
        .locator(
            `[data-testid="history-row-${ulid}"], [data-testid="history-card-${ulid}"]`,
        )
        .filter({ visible: true });

    await expect(row).toContainText('Vera Visitor');
    await expect(row).toContainText('Billing');
    await expect(row).toContainText('Rated 4 out of 5');
    // The comment is on the page itself, not only in a tooltip.
    await expect(row.getByTestId('history-rating-comment')).toHaveText(
        'Helpful, thank you.',
    );
});

test('the agent ends the chat and the visitor skips the rating: closed as skipped, no rating stored', async ({
    actors,
    chats,
    instance,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid, visitor } = await startActiveChat(
        actors,
        instance,
        chats,
        alice,
        { category: 'general', name: 'Sam Skipper' },
    );

    await panel.send('Thanks, that was all I needed.');
    await alice.inbox.expectMessage('that was all');
    await alice.inbox.endChat();

    await panel.expectState('ended');
    await panel.skipRating();
    await panel.expectState('closed');
    await expect(
        panel.frame.getByText('Thanks for your feedback!'),
    ).toBeVisible();

    const row = await expectEventually(
        () => readConversationRow(instance, ulid),
        (stored) => stored.conversation.status === 'closed',
        { message: 'skipping the rating closes the chat' },
    );

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'skipped',
        ended_by: 'agent',
    });
    expect(row.rating).toBeNull();

    const names = (await recordedEvents(visitor.page)).map(
        (event) => event.name,
    );

    expect(names).toContain('chat-ended');
    expect(names).not.toContain('rating-submitted');

    // The closed screen invites a new chat, which clears the session: the next chat is a new ticket and starts from the pre-chat form.
    await panel.newChat();
    await panel.expectState('prechat');
    expect(await panel.visitorToken()).toBeNull();
});

test('the rating window closes: a late rating is 409 rating_window_closed and the sweep closes the chat as timeout, no rating', async ({
    actors,
    chats,
    instance,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid, visitor } = await startActiveChat(
        actors,
        instance,
        chats,
        alice,
        { category: 'billing', name: 'Tess Tardy' },
    );

    await alice.inbox.send('Anything else?');
    await panel.expectMessage('Anything else?', 'agent');
    await alice.inbox.endChat();
    await panel.expectState('ended');

    const token = await panel.visitorToken();

    expect(token).toMatch(/^vt_/);

    // The window is over, but nothing closed the chat yet (the sweep runs every minute in production).
    await ageConversation(instance, ulid, { ratingWindowExpired: true });

    const api = await VisitorApi.withToken(instance, token!, visitor.address);
    const late = await api.rate(ulid, 5, 'Too late');
    const lateSkip = await api.skipRating(ulid);

    expect(late.status).toBe(409);
    expect(late.error?.code).toBe('rating_window_closed');
    expect(lateSkip.status).toBe(409);
    expect(lateSkip.error?.code).toBe('rating_window_closed');

    await runSweep(instance, 'chat:close-unrated');

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'timeout',
        ended_by: 'agent',
    });
    expect(row.rating).toBeNull();

    // The panel closed its socket when the chat ended, so it is still showing the rating card; the visitor who finally rates is
    // told the chat is over (the 409 is handled: the closed screen, no error, nothing stored).
    await expect(panel.tid('rating-stars')).toBeVisible();
    await panel.rate(5, 'Sorry, I was away.');
    await panel.expectState('closed');
    expect((await readConversationRow(instance, ulid)).rating).toBeNull();

    // And once it is closed the API says "not ended" (nothing left to rate).
    const afterwards = await api.rate(ulid, 5);

    expect(afterwards.status).toBe(409);
    expect(afterwards.error?.code).toBe('conversation_not_ended');
    await api.dispose();
});

test('an idle chat is closed by the sweep as idle: no rating prompt, the visitor sees the closed screen and the agent loses the chat', async ({
    actors,
    chats,
    instance,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid, visitor } = await startActiveChat(
        actors,
        instance,
        chats,
        alice,
        { category: 'general', name: 'Ida Idle' },
    );

    await panel.send('Hello?');
    await alice.inbox.expectMessage('Hello?');

    await ageConversation(instance, ulid, { idleExpired: true });
    await runSweep(instance, 'chat:close-idle');

    await panel.expectState('closed');
    await expect(
        panel.frame.getByText('closed because it had been quiet'),
    ).toBeVisible();
    await expect(panel.tid('rating-stars')).toHaveCount(0);

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'idle',
    });
    expect(row.rating).toBeNull();

    // The agent's view of the chat is closed too (the list item leaves "My chats" or reads as closed).
    await expectEventually(
        async () =>
            must<{ status: string }>(
                await alice.api.conversation(ulid),
                'Alice reads the chat',
            ).status,
        (status) => status === 'closed',
        { message: 'Alice sees the idle chat closed' },
    );

    // A message after the close is refused by the API: nothing sends into a closed chat.
    const api = await VisitorApi.withToken(
        instance,
        (await panel.visitorToken())!,
        visitor.address,
    );
    const refused = await api.send(ulid, 'Anyone there?');

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('conversation_not_active');
    await api.dispose();
});

test('cancelling while queued closes the chat as cancelled and takes the offer away from the agent', async ({
    actors,
    chats,
    instance,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const { panel, ulid } = await startQueuedChat(actors, instance, chats, {
        category: 'billing',
        name: 'Carl Canceller',
    });

    await alice.inbox.expectOffer(ulid);
    await panel.cancelQueued();
    await panel.expectState('closed');
    await expect(
        panel.frame.getByText('You cancelled the chat.'),
    ).toBeVisible();

    // The offer leaves Alice's queue without a reload (an expired / taken card fades out first).
    await expect(alice.inbox.offer(ulid)).toHaveCount(0);

    const row = await readConversationRow(instance, ulid);

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'cancelled',
    });
    expect(row.rating).toBeNull();

    // Accepting it now is refused: the chat is gone.
    const late = await alice.api.claim(ulid);

    expect(late.status).toBe(409);
    expect(late.error?.code).toBe('conversation_not_queued');

    // "Start a new chat" begins a new session, so a new ticket is possible at once.
    await panel.newChat();

    const again = await panel.startChat({
        category: 'billing',
        name: 'Carl Canceller',
    });

    chats.track(again.ulid);
    expect(again.status).toBe(201);
    expect(again.ulid).not.toBe(ulid);
    await alice.inbox.expectOffer(again.ulid!);
});

test('the cancel cooldown is per visitor: the same visitor waits about 10 s (429 with Retry-After), then can start again', async ({
    actors,
    chats,
    instance,
    seed,
}) => {
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await VisitorApi.start(instance, { key: seed.widget.key });
    const first = must<{ ulid: string }>(
        await visitor.startChat({ category: 'billing', name: 'Cora Cooldown' }),
        'the first chat starts',
    );

    chats.track(first.ulid);
    await alice.inbox.expectOffer(first.ulid);
    must(await visitor.cancel(first.ulid), 'the visitor cancels');

    const refused = await visitor.startChat({
        category: 'billing',
        name: 'Cora Cooldown',
    });

    expect(refused.status).toBe(429);
    expect(refused.error?.code).toBe('rate_limited');
    expect(refused.error?.details).toMatchObject({
        retry_after: expect.any(Number),
    });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(refused.headers['retry-after'])).toBeLessThanOrEqual(10);

    // Real time: the cooldown is a cache entry that runs out by itself. One wait of exactly what the server announced (polling would
    // use up the 3-a-minute start limiter of the widget and network).
    await new Promise((resolve) =>
        setTimeout(
            resolve,
            Number(refused.headers['retry-after']) * 1000 + 1000,
        ),
    );

    const second = await visitor.startChat({
        category: 'billing',
        name: 'Cora Cooldown',
    });

    expect(second.status).toBe(201);
    chats.track(second.data.ulid);
    expect(second.data.ulid).not.toBe(first.ulid);
    await visitor.dispose();
});

test('a widget with the rating feature off: ending the chat goes straight to closed / skipped, no rating card', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Rita'],
        config: { features: { rating: false } },
    });
    const rita = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const flow = await startActiveChat(actors, instance, chats, rita, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Rob Rated-not',
    });

    await flow.panel.send('Just one question.');
    await rita.inbox.expectMessage('one question');
    await flow.panel.endChat();

    await flow.panel.expectState('closed');
    await expect(flow.panel.tid('rating-stars')).toHaveCount(0);
    await expect(
        flow.panel.frame.getByText('This chat has ended.'),
    ).toBeVisible();

    const row = await expectEventually(
        () => readConversationRow(instance, flow.ulid),
        (stored) => stored.conversation.status === 'closed',
        { message: 'the chat closes without a rating' },
    );

    expect(row.conversation).toMatchObject({
        status: 'closed',
        close_reason: 'skipped',
        ended_by: 'visitor',
        rating_requested: 0,
    });
    expect(row.rating).toBeNull();

    // The same on the agent's side: ending closes it at once. (On a phone the open conversation hides the list with the offers: back to it.)
    await rita.inbox.goto();

    const second = await startActiveChat(actors, instance, chats, rita, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Ruth Rated-not',
    });

    await rita.inbox.endChat();
    await second.panel.expectState('closed');

    const secondRow = await expectEventually(
        () => readConversationRow(instance, second.ulid),
        (stored) => stored.conversation.status === 'closed',
        { message: 'the agent ending the chat closes it at once' },
    );

    expect(secondRow.conversation).toMatchObject({
        close_reason: 'skipped',
        ended_by: 'agent',
    });
});

test('the rating API: every score from 1 to 5 is stored with its comment, a bad score or comment is refused, and a chat is rated once', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Rae'] });
    const rae = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        keepAlive: true,
    });

    for (const score of [1, 2, 3, 4, 5]) {
        const visitor = await VisitorApi.start(instance, {
            key: team.widget.key,
        });
        const chat = must<{ ulid: string }>(
            await visitor.startChat({
                category: team.category.slug,
                name: `Rater ${score}`,
            }),
            `chat ${score} starts`,
        );

        chats.track(chat.ulid);
        must(await rae.api.claim(chat.ulid), `Rae takes chat ${score}`);
        must(await rae.api.end(chat.ulid), `Rae ends chat ${score}`);

        if (score === 1) {
            // What the server refuses, on a chat that is waiting for its rating.
            for (const bad of [0, 6, 2.5, -1]) {
                const refused = await visitor.rate(chat.ulid, bad);

                expect(refused.status, `score ${bad}`).toBe(422);
                expect(refused.error?.code).toBe('validation_failed');
            }

            const long = await visitor.rate(chat.ulid, 3, 'x'.repeat(2001));

            expect(long.status).toBe(422);
        }

        const rated = await visitor.rate(
            chat.ulid,
            score,
            `Comment for ${score} stars`,
        );

        expect(rated.status).toBe(201);
        expect(rated.data).toMatchObject({
            score,
            comment: `Comment for ${score} stars`,
        });

        const row = await readConversationRow(instance, chat.ulid);

        expect(row.rating).toMatchObject({
            score,
            comment: `Comment for ${score} stars`,
        });
        expect(row.conversation).toMatchObject({
            status: 'closed',
            close_reason: 'rated',
        });

        // Rated once: a second rating (or a skip) finds nothing left to rate.
        const again = await visitor.rate(chat.ulid, 5);

        expect(again.status).toBe(409);
        await visitor.dispose();
    }
});
