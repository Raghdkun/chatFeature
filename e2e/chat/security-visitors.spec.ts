import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import {
    expireVisitorToken,
    revokeVisitorToken,
    tokenHash,
} from '../support/staff-db';
import { png } from '../support/staff-ui';
import { createWorld } from '../support/world';

/**
 * Visitor tokens against conversations that are not theirs, and against the staff API: every route answers 404 for another visitor's
 * conversation (never 403: no oracle), the attachment URLs are signed capabilities that cannot be altered, an unknown / expired /
 * revoked token is a 401 with the documented code. Real visitor sessions over the public API, own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

const MISSING_ULID = '1'.repeat(26);

/** A visitor call with ANY bearer (the `VisitorApi` helper always sends its own token). */
async function call(
    api: VisitorApi,
    token: string | null,
    method: 'GET' | 'POST' | 'DELETE',
    path: string,
    body?: unknown,
) {
    const response = await api.context.fetch(`/api/v1/public${path}`, {
        method,
        headers: token === null ? {} : { Authorization: `Bearer ${token}` },
        data: body === undefined ? undefined : body,
        failOnStatusCode: false,
    });
    const text = await response.text();

    return {
        status: response.status(),
        headers: response.headers(),
        text,
        json: (() => {
            try {
                return JSON.parse(text) as { error?: { code: string } };
            } catch {
                return undefined;
            }
        })(),
    };
}

/** Uploads an image to a conversation as that visitor (multipart). */
async function upload(api: VisitorApi, ulid: string, name = 'photo.png') {
    const response = await api.context.fetch(
        `/api/v1/public/conversations/${ulid}/attachments`,
        {
            method: 'POST',
            headers: { Authorization: `Bearer ${api.token}` },
            multipart: {
                file: { name, mimeType: 'image/png', buffer: png(32, 32) },
            },
            failOnStatusCode: false,
        },
    );

    return {
        status: response.status(),
        body: (await response.json().catch(() => undefined)) as
            | { data?: { ulid: string; url: string; thumbUrl: string | null } }
            | undefined,
    };
}

test("another visitor's conversation is a 404 on every route, indistinguishable from one that does not exist; the staff API is closed to visitor tokens", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const slug = world.categories.main.slug;
    const one = await VisitorApi.start(instance, { key: world.widget.key });
    const two = await VisitorApi.start(instance, { key: world.widget.key });
    const mine = must<{ ulid: string }>(
        await one.startChat({ category: slug, name: 'Visitor One' }),
        'visitor one starts a chat',
    );
    const theirs = must<{ ulid: string }>(
        await two.startChat({
            category: slug,
            name: 'Visitor Two',
            message: 'private words of two',
        }),
        'visitor two starts a chat',
    );

    must(await ann.api.claim(mine.ulid), 'Ann claims one');
    must(await ann.api.claim(theirs.ulid), 'Ann claims two');
    must(await two.send(theirs.ulid, 'a second private message'), 'two writes');

    const routes: ['GET' | 'POST', (ulid: string) => string, unknown?][] = [
        ['GET', (ulid) => `/conversations/${ulid}/messages?after_seq=0`],
        [
            'POST',
            (ulid) => `/conversations/${ulid}/messages`,
            { client_msg_id: '01ARZ3NDEKTSV4RRFFQ69G5FAV', body: 'intruder' },
        ],
        ['POST', (ulid) => `/conversations/${ulid}/receipts`, { seen_upto: 1 }],
        ['POST', (ulid) => `/conversations/${ulid}/typing`, { typing: true }],
        ['POST', (ulid) => `/conversations/${ulid}/end`],
        ['POST', (ulid) => `/conversations/${ulid}/cancel`],
        ['POST', (ulid) => `/conversations/${ulid}/rating`, { score: 1 }],
        ['POST', (ulid) => `/conversations/${ulid}/rating/skip`],
    ];

    for (const [method, path, body] of routes) {
        const foreign = await call(
            one,
            one.token,
            method,
            path(theirs.ulid),
            body,
        );
        const missing = await call(
            one,
            one.token,
            method,
            path(MISSING_ULID),
            body,
        );

        expect(foreign.status, `${method} ${path(theirs.ulid)}`).toBe(404);
        expect(foreign.json?.error?.code).toBe('not_found');
        expect(foreign.text).not.toContain('private words');
        // The answer for somebody else's conversation is the answer for one that does not exist.
        expect(foreign.status).toBe(missing.status);
        expect(foreign.json?.error?.code).toBe(missing.json?.error?.code);
    }

    // Uploading into another visitor's conversation, too.
    const intruder = await upload(one, theirs.ulid);

    expect(intruder.status).toBe(404);

    // Nothing of the intruder's attempts arrived: Visitor Two's chat has exactly its own two messages (and the system line).
    const stored = must<{ body: string; sender: { type: string } }[]>(
        await two.messages(theirs.ulid),
        'two reads its chat',
    );

    expect(
        stored
            .filter((message) => message.sender.type === 'visitor')
            .map((message) => message.body),
    ).toEqual(['private words of two', 'a second private message']);
    expect(stored.some((message) => message.body === 'intruder')).toBe(false);
    expect((await ann.api.conversation(theirs.ulid)).data.status).toBe(
        'active',
    );

    // A visitor token on the staff API is nothing: not a staff session, not a bearer a staff route understands.
    const staffRoutes = [
        `/api/v1/conversations/${mine.ulid}`,
        `/api/v1/conversations/${theirs.ulid}/messages`,
        '/api/v1/conversations',
        '/api/v1/conversations/queue',
        '/api/v1/me/presence',
    ];

    for (const path of staffRoutes) {
        const response = await one.context.fetch(path, {
            headers: {
                Authorization: `Bearer ${one.token}`,
                Accept: 'application/json',
            },
            failOnStatusCode: false,
        });

        expect(response.status(), path).toBe(401);
        expect(await response.text()).not.toContain('private words');
    }

    await Promise.all([one.dispose(), two.dispose()]);
});

test("attachments are reachable only through their own signed URL: altered, stripped, swapped or foreign signatures are refused, and a visitor cannot attach somebody else's upload", async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const slug = world.categories.main.slug;
    const one = await VisitorApi.start(instance, { key: world.widget.key });
    const two = await VisitorApi.start(instance, { key: world.widget.key });
    const first = must<{ ulid: string }>(
        await one.startChat({ category: slug, name: 'Pic One' }),
        'one starts a chat',
    );
    const second = must<{ ulid: string }>(
        await two.startChat({ category: slug, name: 'Pic Two' }),
        'two starts a chat',
    );

    must(await ann.api.claim(first.ulid), 'Ann claims one');
    must(await ann.api.claim(second.ulid), 'Ann claims two');

    // Each visitor uploads an image and sends it.
    const a = await upload(one, first.ulid, 'one.png');
    const b = await upload(two, second.ulid, 'two.png');

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);

    const attachmentA = a.body!.data!;
    const attachmentB = b.body!.data!;

    must(
        await one.request('POST', `/conversations/${first.ulid}/messages`, {
            attachments: [attachmentA.ulid],
        }),
        'one sends its picture',
    );
    must(
        await two.request('POST', `/conversations/${second.ulid}/messages`, {
            attachments: [attachmentB.ulid],
        }),
        'two sends its picture',
    );

    // The signed URL works for whoever holds it, and serves the image with the hardening headers.
    const open = await one.context.fetch(attachmentB.url, {
        failOnStatusCode: false,
    });

    expect(open.status()).toBe(200);
    expect(open.headers()['content-type']).toMatch(/^image\//);
    expect(open.headers()['x-content-type-options']).toBe('nosniff');
    expect(open.headers()['content-security-policy']).toContain(
        "default-src 'none'",
    );
    expect(open.headers()['content-disposition'] ?? '').not.toContain(
        'two.png',
    );

    // Altered: a changed signature, a missing one, another file's signature on this file, a thumbnail flag nobody signed, a later expiry.
    const url = new URL(attachmentB.url);
    const signature = url.searchParams.get('signature')!;
    const withParams = (change: (params: URLSearchParams) => void): string => {
        const copy = new URL(attachmentB.url);

        change(copy.searchParams);

        return copy.toString();
    };
    const tampered: Record<string, string> = {
        'a flipped signature character': withParams((params) =>
            params.set(
                'signature',
                `${signature.slice(0, -1)}${signature.endsWith('0') ? '1' : '0'}`,
            ),
        ),
        'no signature': withParams((params) => params.delete('signature')),
        'an empty signature': withParams((params) =>
            params.set('signature', ''),
        ),
        'a thumbnail flag nobody signed': withParams((params) =>
            params.set('thumb', '1'),
        ),
        'another expiry': withParams((params) =>
            params.set(
                'expires',
                String(Math.floor(Date.now() / 1000) + 10 * 86_400),
            ),
        ),
        'an expiry in the past': withParams((params) =>
            params.set('expires', String(Math.floor(Date.now() / 1000) - 60)),
        ),
        "the other visitor's file under this signature":
            attachmentB.url.replace(attachmentB.ulid, attachmentA.ulid),
        'the bare path': `${url.origin}${url.pathname}`,
    };

    for (const [label, tamperedUrl] of Object.entries(tampered)) {
        const response = await one.context.fetch(tamperedUrl, {
            failOnStatusCode: false,
        });

        expect(response.status(), label).toBe(403);
    }

    // A visitor token is not what opens an attachment: with a token but no signature it is just as refused.
    const bearerOnly = await one.context.fetch(
        `/api/v1/public/attachments/${attachmentB.ulid}`,
        {
            headers: { Authorization: `Bearer ${one.token}` },
            failOnStatusCode: false,
        },
    );

    expect(bearerOnly.status()).toBe(403);

    // Somebody else's upload cannot be attached to my message (it belongs to one conversation).
    const stolen = await one.request(
        'POST',
        `/conversations/${first.ulid}/messages`,
        {
            attachments: [attachmentB.ulid],
        },
    );

    expect(stolen.ok).toBe(false);
    expect([404, 422]).toContain(stolen.status);

    const mine = must<{ attachments: { ulid: string }[] }[]>(
        await one.messages(first.ulid),
        'one reads',
    );

    expect(JSON.stringify(mine)).not.toContain(attachmentB.ulid);

    // A signature minted for one conversation's file is worthless for the same file with another host or path casing.
    expect(
        (
            await one.context.fetch(
                attachmentB.url.replace(
                    attachmentB.ulid,
                    attachmentB.ulid.toUpperCase(),
                ),
                { failOnStatusCode: false },
            )
        ).status(),
    ).toBe(403);

    await Promise.all([one.dispose(), two.dispose()]);
});

test('a token the server does not know, one that expired, one that was revoked and one that signed out are all 401 with their code', async ({
    adminApi,
    instance,
    actors,
}) => {
    const world = await createWorld(adminApi, instance, {
        agents: { ann: ['main'] },
    });

    await actors.account(world.agents.ann, { presence: 'online' });

    const key = world.widget.key;
    const unknown = await VisitorApi.start(instance, { key });

    // Unknown, malformed or missing: `unauthenticated`.
    for (const token of ['vt_' + 'x'.repeat(40), 'not-a-token', '', null]) {
        const answer = await call(unknown, token, 'GET', '/conversation');

        expect(answer.status, `token ${String(token)}`).toBe(401);
        expect(answer.json?.error?.code).toBe('unauthenticated');
    }

    // A live token works ...
    expect((await unknown.conversation()).status).toBe(200);

    // ... until it expires: `session_revoked`, on every route.
    const expiring = await VisitorApi.start(instance, { key });

    await expireVisitorToken(instance, expiring.token);
    for (const [method, path] of [
        ['GET', '/conversation'],
        ['POST', '/conversations'],
        ['GET', `/conversations/${MISSING_ULID}/messages`],
    ] as const) {
        const answer = await call(
            expiring,
            expiring.token,
            method,
            path,
            method === 'POST'
                ? { category: world.categories.main.slug }
                : undefined,
        );

        expect(answer.status, `${method} ${path}`).toBe(401);
        expect(answer.json?.error?.code).toBe('session_revoked');
    }

    // Revoked by the server side (an administrator's action in the database): the same.
    const revoked = await VisitorApi.start(instance, { key });

    await revokeVisitorToken(instance, revoked.token);
    expect((await revoked.conversation()).status).toBe(401);
    expect((await revoked.conversation()).error?.code).toBe('session_revoked');

    // Signing out revokes the session; the old token is dead afterwards.
    const leaving = await VisitorApi.start(instance, { key });

    expect((await leaving.signOut()).status).toBe(204);
    expect((await leaving.conversation()).status).toBe(401);
    expect((await leaving.conversation()).error?.code).toBe('session_revoked');

    // Only the hash of a token is stored: the plaintext is nowhere in the answer of the next session either.
    const next = await VisitorApi.start(instance, {
        key,
        bearer: unknown.token,
    });

    expect(next.token).not.toBe(unknown.token);
    expect(JSON.stringify(next.session)).not.toContain(
        tokenHash(unknown.token),
    );

    await Promise.all(
        [unknown, expiring, revoked, leaving, next].map((visitor) =>
            visitor.dispose(),
        ),
    );
});
