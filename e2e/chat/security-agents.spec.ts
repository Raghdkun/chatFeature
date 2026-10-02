import type { Api } from '../support/api';
import type { StaffActor } from '../support/actors';
import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import type { Instance } from '../support/scenarios';
import { png } from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * Who may see and do what in the staff API and the dashboard pages, asserted with real sessions: an agent never reaches a chat that is
 * not theirs (page, every endpoint, lists, filters, search, cursors), cannot claim what they do not serve or have no room for, sees an
 * offered chat only until a colleague takes it, and the dashboard's POSTs are CSRF-protected. The administrator is the positive
 * control for every refusal. Own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

const SECRET = 'swordfish-7731';

type Chat = { ulid: string };

/** A chat in `category` by a visitor with a recognisable name and message. */
async function startFor(
    instance: Instance,
    key: string,
    category: string,
    name: string,
    /** The code word in the visitor's first message (each chat of a test has its own, so a leak is attributable). */
    secret = 'plain-words',
): Promise<{ visitor: VisitorApi; chat: Chat }> {
    const visitor = await VisitorApi.start(instance, { key });
    const chat = must<Chat>(
        await visitor.startChat({
            category,
            name,
            email: `${name.toLowerCase().replace(/\W+/g, '.')}@example.test`,
            message: `The code word is ${secret} for ${name}.`,
        }),
        `${name} starts a chat`,
    );

    return { visitor, chat };
}

/** A well-formed ulid that belongs to nothing. */
const MISSING_ULID = '1'.repeat(26);

/** Every staff endpoint that takes a conversation, with a body that would be valid for the caller. */
function endpoints(
    ulid: string,
    category: string,
): [string, string, unknown?][] {
    const base = `/api/v1/conversations/${ulid}`;

    return [
        ['GET', base],
        ['GET', `${base}/messages?after_seq=0`],
        [
            'POST',
            `${base}/messages`,
            { client_msg_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', body: 'hello' },
        ],
        ['POST', `${base}/claim`],
        ['POST', `${base}/receipts`, { seen_upto: 1 }],
        ['POST', `${base}/typing`, { typing: true }],
        ['POST', `${base}/end`],
        ['POST', `${base}/close`],
        ['POST', `${base}/transfer`, { category }],
        ['GET', `${base}/transfer-targets`],
    ];
}

/** A real image upload as that staff member (multipart + the session's XSRF token, like the dashboard's composer). */
async function uploadAs(
    actor: StaffActor,
    instance: Instance,
    ulid: string,
): Promise<number> {
    const state = await actor.context.storageState();
    const xsrf = state.cookies.find((cookie) => cookie.name === 'XSRF-TOKEN');
    const response = await actor.context.request.post(
        `${instance.url}/api/v1/conversations/${ulid}/attachments`,
        {
            headers: {
                Accept: 'application/json',
                Origin: instance.url,
                Referer: `${instance.url}/`,
                'X-XSRF-TOKEN': decodeURIComponent(xsrf?.value ?? ''),
            },
            multipart: {
                file: {
                    name: 'proof.png',
                    mimeType: 'image/png',
                    buffer: png(16, 16),
                },
            },
            failOnStatusCode: false,
        },
    );

    return response.status();
}

async function expectRefusedEverywhere(
    api: Api,
    ulid: string,
    category: string,
    /** An agent who WAS offered the chat gets the documented `409 already_claimed` for a late claim, everybody else a 403. */
    wasOffered: boolean,
): Promise<void> {
    for (const [method, path, body] of endpoints(ulid, category)) {
        const result = await api.request(method as 'GET' | 'POST', path, body);
        const expected = wasOffered && path.endsWith('/claim') ? 409 : 403;

        expect(result.status, `${method} ${path}`).toBe(expected);
        expect(
            JSON.stringify(result.body ?? ''),
            `${method} ${path} leaks nothing`,
        ).not.toContain(SECRET);
    }
}

test("agent B cannot reach agent A's chat: the page, every endpoint, the lists, the filters, the search and the cursors", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        categories: ['main', 'other'],
        agents: { ann: ['main'], ann2: ['main'], ben: ['other'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const ann2 = await actors.account(world.agents.ann2, {
        presence: 'online',
    });
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const admin = await actors.staff('admin');
    const mainSlug = world.categories.main.slug;

    // X: Ann's active chat in "main". Y: Ben's active chat in "other".
    const x = await startFor(
        instance,
        world.widget.key,
        mainSlug,
        'Secret Sam',
        SECRET,
    );
    const y = await startFor(
        instance,
        world.widget.key,
        world.categories.other.slug,
        'Other Olga',
    );

    must(await ann.api.claim(x.chat.ulid), 'Ann claims X');
    must(await ben.api.claim(y.chat.ulid), 'Ben claims Y');

    // Ben's browser: the page of a chat that is not his is a 403, and so is Ann2's (same topic, not assigned).
    for (const stranger of [ben, ann2] as StaffActor[]) {
        const page = await stranger.page.goto(`/inbox/${x.chat.ulid}`);

        expect(page?.status(), `${stranger.name} opening /inbox/X`).toBe(403);
        await expectRefusedEverywhere(
            stranger.api.api,
            x.chat.ulid,
            world.categories.other.slug,
            stranger === ann2,
        );
        expect(
            await uploadAs(stranger, instance, x.chat.ulid),
            `${stranger.name} uploading into X`,
        ).toBe(403);
    }

    // The owner and the administrator can (the positive controls).
    expect((await ann.api.conversation(x.chat.ulid)).status).toBe(200);
    expect((await admin.api.conversation(x.chat.ulid)).status).toBe(200);
    expect((await admin.page.goto(`/inbox/${x.chat.ulid}`))?.status()).toBe(
        200,
    );

    // Lists, filters, search: nothing of X reaches Ben (or Ann2), whatever he asks for.
    const queries: Record<string, string | number>[] = [
        {},
        { limit: 100 },
        { status: 'active' },
        { status: 'active,queued,ended,closed,missed' },
        { type: 'live' },
        { agent: world.agents.ann.id },
        { agent: 'me' },
        { widget: world.widget.ulid },
        { category: mainSlug },
        { category: world.categories.main.ulid },
        { from: '2000-01-01', to: '2100-01-01' },
        { updated_after: '2000-01-01T00:00:00Z' },
        { q: SECRET },
        { q: 'Secret Sam' },
        { q: 'secret.sam@example.test' },
        { q: x.chat.ulid },
        { q: 'Secret', widget: world.widget.ulid, agent: world.agents.ann.id },
    ];

    for (const stranger of [ben, ann2] as StaffActor[]) {
        for (const query of queries) {
            const answer = await stranger.api.conversations(query);

            expect(
                answer.status,
                `${stranger.name} lists ${JSON.stringify(query)}`,
            ).toBe(200);

            const text = JSON.stringify(answer.body);

            expect(
                text,
                `${stranger.name} lists ${JSON.stringify(query)}`,
            ).not.toContain(x.chat.ulid);
            expect(text).not.toContain(SECRET);
            expect(text).not.toContain('Secret Sam');
        }

        const queue = await stranger.api.queue();

        expect(JSON.stringify(queue.body)).not.toContain(x.chat.ulid);
    }

    // Ben does see his own chat, and the administrator's list (with the search) finds both.
    expect(
        must<{ ulid: string }[]>(
            await ben.api.conversations({ agent: 'me' }),
            'Ben lists his chats',
        ).map((conversation) => conversation.ulid),
    ).toEqual([y.chat.ulid]);

    const everything = must<{ ulid: string }[]>(
        await admin.api.conversations({ widget: world.widget.ulid }),
        'the administrator lists the widget',
    ).map((conversation) => conversation.ulid);

    expect(everything.sort()).toEqual([x.chat.ulid, y.chat.ulid].sort());
    expect(
        must<{ ulid: string }[]>(
            await admin.api.conversations({ q: SECRET }),
            'the administrator searches',
        ).map((conversation) => conversation.ulid),
    ).toContain(x.chat.ulid);

    // Cursors: a real one (page size 1 for the administrator) is opaque base64 JSON. Tampering with it (a far id, another key, junk,
    // an injection attempt) never widens what Ben sees and never makes the server fail.
    const page = await admin.api.conversations({
        limit: 1,
        widget: world.widget.ulid,
    });
    const cursor = (page.body as { meta: { next_cursor: string | null } }).meta
        .next_cursor;

    expect(cursor).not.toBeNull();

    const forged = [
        Buffer.from(
            JSON.stringify({
                'conversations.id': 999_999_999,
                _pointsToNextItems: true,
            }),
        ).toString('base64'),
        Buffer.from(
            JSON.stringify({
                'conversations.id': 0,
                _pointsToNextItems: false,
            }),
        ).toString('base64'),
        Buffer.from(
            JSON.stringify({
                'conversations.id': '1 OR 1=1',
                _pointsToNextItems: true,
            }),
        ).toString('base64'),
        Buffer.from(
            JSON.stringify({
                assigned_agent_id: world.agents.ann.id,
                _pointsToNextItems: true,
            }),
        ).toString('base64'),
        Buffer.from('{"conversations.id":').toString('base64'),
        'not-a-cursor',
        String(cursor).slice(0, -3),
        'A'.repeat(300),
    ];

    for (const value of forged) {
        const answer = await ben.api.api.get(
            `/api/v1/conversations?cursor=${encodeURIComponent(value)}&limit=100`,
        );

        expect(
            answer.status,
            `a forged cursor ${value.slice(0, 20)}`,
        ).toBeLessThan(500);
        expect(JSON.stringify(answer.body ?? '')).not.toContain(x.chat.ulid);
        expect(JSON.stringify(answer.body ?? '')).not.toContain(SECRET);
    }

    await Promise.all([x.visitor.dispose(), y.visitor.dispose()]);
});

test('an agent cannot claim a chat of a topic they do not serve, or one nobody offered them; an offered chat is visible only until a colleague takes it', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        categories: ['main', 'other'],
        agents: { ann: ['main'], ann2: ['main'], ben: ['other'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const ann2 = await actors.account(world.agents.ann2, {
        presence: 'online',
    });
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const z = await startFor(
        instance,
        world.widget.key,
        world.categories.main.slug,
        'Queued Quin',
    );

    // Ben does not serve "main": the chat is not on his queue, he may not read it and he may not claim it.
    expect(JSON.stringify((await ben.api.queue()).body)).not.toContain(
        z.chat.ulid,
    );
    expect((await ben.api.conversation(z.chat.ulid)).status).toBe(403);
    expect((await ben.api.claim(z.chat.ulid)).status).toBe(403);
    expect((await ben.page.goto(`/inbox/${z.chat.ulid}`))?.status()).toBe(403);

    // Ann and Ann2 were both offered it: each may read it while it is queued.
    expect((await ann.api.conversation(z.chat.ulid)).status).toBe(200);
    expect((await ann2.api.conversation(z.chat.ulid)).status).toBe(200);
    expect((await ann2.page.goto(`/inbox/${z.chat.ulid}`))?.status()).toBe(200);

    // Ann takes it: from then on it is hers alone. Ann2 loses the page and the API (the offer is no longer open).
    must(await ann.api.claim(z.chat.ulid), 'Ann claims it');
    expect((await ann2.api.conversation(z.chat.ulid)).status).toBe(403);
    expect((await ann2.page.goto(`/inbox/${z.chat.ulid}`))?.status()).toBe(403);
    expect(JSON.stringify((await ann2.api.queue()).body)).not.toContain(
        z.chat.ulid,
    );

    // A late claim by somebody who WAS offered it is the documented conflict, naming the winner (not a bare 403).
    const late = await ann2.api.claim(z.chat.ulid);

    expect(late.status).toBe(409);
    expect(late.error?.code).toBe('already_claimed');
    expect(late.error?.details).toMatchObject({ by: world.agents.ann.name });
    await z.visitor.dispose();
});

test('an agent at their limit cannot take another chat (409 at_capacity) and a colleague can', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'], ann2: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const ann2 = await actors.account(world.agents.ann2, {
        presence: 'online',
    });
    const slug = world.categories.main.slug;

    must(
        await adminApi.patch(`/api/v1/agents/${world.agents.ann.id}`, {
            max_concurrent_chats: 2,
        }),
        'Ann may hold two chats',
    );

    const first = await startFor(
        instance,
        world.widget.key,
        slug,
        'First Fran',
    );

    must(await ann.api.claim(first.chat.ulid), 'Ann claims the first chat');

    // A second chat is offered to her (one of two slots used) ...
    const second = await startFor(
        instance,
        world.widget.key,
        slug,
        'Second Sid',
    );

    expect(JSON.stringify((await ann.api.queue()).body)).toContain(
        second.chat.ulid,
    );

    // ... then the administrator lowers her limit to one before she accepts.
    must(
        await adminApi.patch(`/api/v1/agents/${world.agents.ann.id}`, {
            max_concurrent_chats: 1,
        }),
        'Ann may hold one chat',
    );

    const refused = await ann.api.claim(second.chat.ulid);

    expect(refused.status).toBe(409);
    expect(refused.error?.code).toBe('at_capacity');

    // The chat is still waiting, and her colleague takes it.
    expect(
        must<{ status: string }>(
            await adminApi.get(`/api/v1/conversations/${second.chat.ulid}`),
            'read',
        ).status,
    ).toBe('queued');
    expect((await ann2.api.claim(second.chat.ulid)).status).toBe(200);

    // A third chat is no longer offered to her at all (she is full).
    const third = await startFor(instance, world.widget.key, slug, 'Third Tia');

    expect(JSON.stringify((await ann.api.queue()).body)).not.toContain(
        third.chat.ulid,
    );
    expect((await ann.api.claim(third.chat.ulid)).status).toBe(403);

    await Promise.all([
        first.visitor.dispose(),
        second.visitor.dispose(),
        third.visitor.dispose(),
    ]);
});

test('dashboard writes need the CSRF token (419), and an unknown conversation is a 404 for staff', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const post = (headers: Record<string, string>) =>
        ann.context.request.post(
            `${instance.url}/api/v1/me/presence/heartbeat`,
            {
                headers: {
                    Accept: 'application/json',
                    Origin: instance.url,
                    Referer: `${instance.url}/`,
                    ...headers,
                },
                failOnStatusCode: false,
            },
        );

    // The session cookie alone is not enough: no token, or a wrong one, is refused.
    const without = await post({});

    expect(without.status()).toBe(419);
    expect(
        ((await without.json()) as { error: { code: string } }).error.code,
    ).toBe('csrf_mismatch');
    expect((await post({ 'X-XSRF-TOKEN': 'not-the-token' })).status()).toBe(
        419,
    );

    // With the token the dashboard itself sends it works.
    // (P5: the heartbeat answers the effective status, `200`.)
    expect((await ann.api.heartbeat()).status).toBe(200);

    // The same for the dashboard's own web routes: a sign-out without the token is refused and the session lives on. (The Pusher
    // channel authorisation `/broadcasting/auth` is exempt from the token check by the framework: it only signs a channel name.)
    const logout = await ann.context.request.post(`${instance.url}/logout`, {
        headers: { Accept: 'application/json' },
        failOnStatusCode: false,
    });

    expect(logout.status()).toBe(419);
    expect((await ann.api.presence()).status).toBe(200);

    // An id that does not exist is a plain 404 for staff, not a 500 and not a 403 that would confirm anything.
    expect((await ann.api.conversation(MISSING_ULID)).status).toBe(404);
    expect(
        (await ann.api.api.get('/api/v1/conversations/not-a-ulid')).status,
    ).toBe(404);
});
