import { expect, test } from '../support/test';
import { clientAddress, must, VisitorApi } from '../support/chat-api';
import { createWorld } from '../support/world';

/**
 * The anti-automation limits of the public chat API, hit for real: the fourth chat start from one network inside a minute, the cancel
 * cooldown (kept per visitor, so a new token does not skip it), the 30 messages a minute of one session and the offline-ticket budget.
 * Every refusal is `429 rate_limited` with `Retry-After`. Each test has its own widget (the budgets are per widget) and its own client
 * addresses (`X-Forwarded-For`, trusted in these scenarios), so nothing here uses up another test's budget.
 */
test.use({ scenario: 'p4-staff' });

test('the fourth chat start from one network within a minute is 429 with Retry-After; another network is not affected', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });

    await actors.account(world.agents.ann, { presence: 'online' });

    const category = world.categories.main.slug;
    const address = clientAddress();
    const visitors: VisitorApi[] = [];

    // Three visitors behind one network start a chat each ...
    for (let index = 0; index < 3; index += 1) {
        const visitor = await VisitorApi.start(instance, {
            key: world.widget.key,
            address,
        });

        visitors.push(visitor);
        expect(
            (await visitor.startChat({ category, name: `Network ${index}` }))
                .status,
            `start number ${index + 1}`,
        ).toBe(201);
    }

    // ... the fourth, whoever they are, is refused for a while.
    const fourth = await VisitorApi.start(instance, {
        key: world.widget.key,
        address,
    });

    visitors.push(fourth);

    const refused = await fourth.startChat({ category, name: 'Network 3' });

    expect(refused.status).toBe(429);
    expect(refused.error?.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    // A visitor on another network starts a chat at once.
    const elsewhere = await VisitorApi.start(instance, {
        key: world.widget.key,
    });

    visitors.push(elsewhere);
    expect(
        (await elsewhere.startChat({ category, name: 'Elsewhere' })).status,
    ).toBe(201);

    // And the refusal is only about starting: the fourth visitor can still read what they have.
    expect((await fourth.conversation()).status).toBe(200);

    await Promise.all(visitors.map((visitor) => visitor.dispose()));
});

test('after cancelling a queued chat the same visitor must wait before starting another, even with a new token', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });

    await actors.account(world.agents.ann, { presence: 'online' });

    const category = world.categories.main.slug;
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const first = must<{ ulid: string }>(
        await visitor.startChat({ category, name: 'Cooldown Cora' }),
        'the first chat',
    );

    must(await visitor.cancel(first.ulid), 'the visitor cancels');

    // Straight away: refused, with how long to wait.
    const again = await visitor.startChat({ category, name: 'Cooldown Cora' });

    expect(again.status).toBe(429);
    expect(again.error?.code).toBe('rate_limited');
    expect(Number(again.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(again.error?.details?.retry_after)).toBeGreaterThan(0);
    expect(Number(again.error?.details?.retry_after)).toBeLessThanOrEqual(10);

    // A fresh token for the same visitor (rotation) does not skip it.
    const rotated = await visitor.rotate(instance, world.widget.key);
    const viaRotation = await rotated.startChat({
        category,
        name: 'Cooldown Cora',
    });

    expect(viaRotation.status).toBe(429);

    // The server said how long to wait; once that time is over a new chat can be started (one attempt: every attempt also counts
    // against the per-minute start budget, so polling for it would only use that up).
    const wait = Number(viaRotation.error?.details?.retry_after ?? 10);

    await new Promise((resolve) => setTimeout(resolve, (wait + 1) * 1000));
    expect(
        (await rotated.startChat({ category, name: 'Cooldown Cora' })).status,
    ).toBe(201);

    await Promise.all([visitor.dispose(), rotated.dispose()]);
});

test('a session may send 30 messages a minute: the 31st is 429 with Retry-After', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const { ulid } = must<{ ulid: string }>(
        await visitor.startChat({
            category: world.categories.main.slug,
            name: 'Chatty Chad',
        }),
        'the chat',
    );

    must(await ann.api.claim(ulid), 'Ann claims it');

    const statuses: number[] = [];
    let last: Awaited<ReturnType<VisitorApi['send']>> | null = null;

    for (let index = 1; index <= 31; index += 1) {
        last = await visitor.send(ulid, `message ${index}`);
        statuses.push(last.status);
    }

    expect(statuses.slice(0, 30).every((status) => status === 201)).toBe(true);
    expect(statuses[30]).toBe(429);
    expect(last?.error?.code).toBe('rate_limited');
    expect(Number(last?.headers['retry-after'])).toBeGreaterThan(0);

    // The agent can still answer, and the visitor's refused message was not stored.
    must(await ann.api.send(ulid, 'slow down a little'), 'Ann answers');

    const stored = must<{ body: string }[]>(
        await ann.api.messages(ulid, 0, 200),
        'read',
    );

    expect(
        stored.filter((message) => message.body?.startsWith('message ')),
    ).toHaveLength(30);

    await visitor.dispose();
});

test('offline tickets are limited too: three a minute from one session, then 429', async ({
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const ticket = (index: number) =>
        visitor.offlineTicket({
            name: `Ticket ${index}`,
            email: `ticket${index}@example.test`,
            message: `Message ${index}`,
            category: world.categories.main.slug,
        });

    for (let index = 1; index <= 3; index += 1) {
        expect((await ticket(index)).status, `ticket ${index}`).toBe(201);
    }

    const refused = await ticket(4);

    expect(refused.status).toBe(429);
    expect(refused.error?.code).toBe('rate_limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);

    await visitor.dispose();
});
