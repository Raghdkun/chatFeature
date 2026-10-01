import type { StaffActor } from '../support/actors';
import { expect, test } from '../support/test';
import { must, VisitorApi } from '../support/chat-api';
import { SocketProbe, type Authoriser } from '../support/realtime';
import { createWorld } from '../support/world';

/**
 * Who may subscribe to which websocket channel, asked of the real Reverb with a real `pusher-js` client (the Node side of the test)
 * and the authorisers the product ships: a visitor's bearer token against `POST /api/v1/public/broadcasting/auth`, a staff session
 * against `POST /broadcasting/auth`. A refusal is a `pusher:subscription_error` for the client, so what matters is whether the
 * subscription succeeds. Own world per test (`world.ts`).
 */
test.use({ scenario: 'p4-staff' });

const visitorAuthoriser =
    (visitor: VisitorApi): Authoriser =>
    (socketId, channel) =>
        visitor.request('POST', '/broadcasting/auth', {
            socket_id: socketId,
            channel_name: channel,
        });

const staffAuthoriser =
    (actor: StaffActor): Authoriser =>
    (socketId, channel) =>
        actor.api.api.post('/broadcasting/auth', {
            socket_id: socketId,
            channel_name: channel,
        });

/** Subscribes to every channel and returns which ones the socket accepted. */
async function accepted(
    probe: SocketProbe,
    channels: string[],
): Promise<Record<string, boolean>> {
    const outcome: Record<string, boolean> = {};

    for (const channel of channels) {
        outcome[channel] = (await probe.subscribe(channel)).subscribed;
    }

    return outcome;
}

test('a visitor can subscribe only to the channel of their own conversation', async ({
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
        await one.startChat({ category: slug, name: 'Channel One' }),
        'one starts a chat',
    );
    const theirs = must<{ ulid: string }>(
        await two.startChat({ category: slug, name: 'Channel Two' }),
        'two starts a chat',
    );
    const probe = await SocketProbe.connect(instance, visitorAuthoriser(one));

    try {
        const channel = (ulid: string) => `private-conversation.${ulid}`;
        const outcome = await accepted(probe, [
            channel(mine.ulid),
            channel(theirs.ulid),
            channel('1'.repeat(26)),
            channel(mine.ulid.toUpperCase()),
            `presence-conversation.${mine.ulid}`,
            `private-staff.${world.agents.ann.id}`,
            'presence-staff',
            'private-admin',
            'private-whatsapp-admin',
            `private-App.Models.User.${world.agents.ann.id}`,
            'private-conversation.',
            'private-conversation.*',
        ]);

        // Only their own conversation, spelled exactly as the events are published.
        expect(outcome).toEqual({
            [channel(mine.ulid)]: true,
            [channel(theirs.ulid)]: false,
            [channel('1'.repeat(26))]: false,
            [channel(mine.ulid.toUpperCase())]: false,
            [`presence-conversation.${mine.ulid}`]: false,
            [`private-staff.${world.agents.ann.id}`]: false,
            'presence-staff': false,
            'private-admin': false,
            'private-whatsapp-admin': false,
            [`private-App.Models.User.${world.agents.ann.id}`]: false,
            'private-conversation.': false,
            'private-conversation.*': false,
        });
    } finally {
        probe.close();
    }

    // Straight at the endpoint: a refusal is `403 channel_forbidden`, a bad request `422`, no token `401`.
    const forbidden = await two.request('POST', '/broadcasting/auth', {
        socket_id: '123.456',
        channel_name: `private-conversation.${mine.ulid}`,
    });

    expect(forbidden.status).toBe(403);
    expect(forbidden.error?.code).toBe('channel_forbidden');
    expect(
        (await two.request('POST', '/broadcasting/auth', { channel_name: 'x' }))
            .status,
    ).toBe(422);
    expect(
        (
            await two.request('POST', '/broadcasting/auth', {
                socket_id: 'abc',
                channel_name: `private-conversation.${theirs.ulid}`,
            })
        ).status,
    ).toBe(422);

    const anonymous = await one.context.fetch(
        '/api/v1/public/broadcasting/auth',
        {
            method: 'POST',
            data: {
                socket_id: '123.456',
                channel_name: `private-conversation.${mine.ulid}`,
            },
            failOnStatusCode: false,
        },
    );

    expect(anonymous.status()).toBe(401);

    // The same visitor after a sign-out: the dead token cannot authorise anything any more.
    must(await one.signOut(), 'one signs out');

    const dead = await one.request('POST', '/broadcasting/auth', {
        socket_id: '123.456',
        channel_name: `private-conversation.${mine.ulid}`,
    });

    expect(dead.status).toBe(401);
    expect(ann.name).toBeTruthy();

    await Promise.all([one.dispose(), two.dispose()]);
});

test('a staff member subscribes only to their own staff channel, the roster and the conversations they may see; admin channels are for administrators', async ({
    actors,
    adminApi,
    instance,
}) => {
    const world = await createWorld(adminApi, instance, {
        categories: ['main', 'other'],
        agents: { ann: ['main'], ben: ['other'] },
    });
    const ann = await actors.account(world.agents.ann, { presence: 'online' });
    const ben = await actors.account(world.agents.ben, { presence: 'online' });
    const admin = await actors.staff('admin');
    const visitor = await VisitorApi.start(instance, { key: world.widget.key });
    const chat = must<{ ulid: string }>(
        await visitor.startChat({
            category: world.categories.main.slug,
            name: 'Staff Channel',
        }),
        'the visitor starts a chat',
    );

    must(await ann.api.claim(chat.ulid), 'Ann claims it');

    const conversation = `private-conversation.${chat.ulid}`;
    const annProbe = await SocketProbe.connect(instance, staffAuthoriser(ann));
    const benProbe = await SocketProbe.connect(instance, staffAuthoriser(ben));
    const adminProbe = await SocketProbe.connect(
        instance,
        staffAuthoriser(admin),
    );

    try {
        const channels = [
            `private-staff.${world.agents.ann.id}`,
            `private-staff.${world.agents.ben.id}`,
            `private-staff.${admin.user.email}`,
            'presence-staff',
            'private-admin',
            'private-whatsapp-admin',
            conversation,
            `presence-conversation.${chat.ulid}`,
            'private-staff',
            'private-staff.',
            `private-App.Models.User.${world.agents.ann.id}`,
            `private-App.Models.User.${world.agents.ben.id}`,
            'private-something.else',
        ];
        const forAnn = await accepted(annProbe, channels);

        expect(forAnn).toEqual({
            [`private-staff.${world.agents.ann.id}`]: true,
            [`private-staff.${world.agents.ben.id}`]: false,
            [`private-staff.${admin.user.email}`]: false,
            'presence-staff': true,
            'private-admin': false,
            'private-whatsapp-admin': false,
            [conversation]: true,
            [`presence-conversation.${chat.ulid}`]: false,
            'private-staff': false,
            'private-staff.': false,
            [`private-App.Models.User.${world.agents.ann.id}`]: true,
            [`private-App.Models.User.${world.agents.ben.id}`]: false,
            'private-something.else': false,
        });

        // Ben serves another topic: his own channel and the roster, nobody else's, and not Ann's conversation.
        const forBen = await accepted(benProbe, channels);

        expect(forBen[`private-staff.${world.agents.ben.id}`]).toBe(true);
        expect(forBen[`private-staff.${world.agents.ann.id}`]).toBe(false);
        expect(forBen['presence-staff']).toBe(true);
        expect(forBen['private-admin']).toBe(false);
        expect(forBen[conversation]).toBe(false);

        // The administrator: the admin channel and any conversation, but staff channels of others stay self-only, and the WhatsApp
        // admin channel is not registered yet (P6): nobody, administrators included, can join it.
        const forAdmin = await accepted(adminProbe, [
            'private-admin',
            conversation,
            `private-staff.${world.agents.ann.id}`,
            'private-whatsapp-admin',
        ]);

        expect(forAdmin).toEqual({
            'private-admin': true,
            [conversation]: true,
            [`private-staff.${world.agents.ann.id}`]: false,
            'private-whatsapp-admin': false,
        });
    } finally {
        annProbe.close();
        benProbe.close();
        adminProbe.close();
    }

    // Without a session the dashboard's authoriser says no (and a visitor token does not make a staff member).
    const stranger = await visitor.context.fetch('/broadcasting/auth', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${visitor.token}`,
            Accept: 'application/json',
        },
        form: {
            socket_id: '123.456',
            channel_name: `private-staff.${world.agents.ann.id}`,
        },
        failOnStatusCode: false,
    });

    expect([401, 403, 419]).toContain(stranger.status());

    await visitor.dispose();
});

test("a visitor's socket receives the messages of their own chat and nothing of anybody else's", async ({
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
        await one.startChat({ category: slug, name: 'Listen One' }),
        'one starts a chat',
    );
    const theirs = must<{ ulid: string }>(
        await two.startChat({ category: slug, name: 'Listen Two' }),
        'two starts a chat',
    );

    must(await ann.api.claim(mine.ulid), 'Ann claims one');
    must(await ann.api.claim(theirs.ulid), 'Ann claims two');

    const probe = await SocketProbe.connect(instance, visitorAuthoriser(one));

    try {
        const own = await probe.subscribe(`private-conversation.${mine.ulid}`);
        const foreign = await probe.subscribe(
            `private-conversation.${theirs.ulid}`,
        );
        // A public channel of the same name needs no authorisation, but nothing is ever published there.
        const publicName = await probe.subscribe(`conversation.${theirs.ulid}`);

        expect(own.subscribed).toBe(true);
        expect(foreign.subscribed).toBe(false);
        expect(publicName.authStatus).toBeNull();

        // Ann writes in both chats: the visitor's socket gets only the message of its own chat, in its visitor-safe form.
        must(
            await ann.api.send(theirs.ulid, 'for visitor two only'),
            'Ann writes to two',
        );
        must(
            await ann.api.send(mine.ulid, 'for visitor one'),
            'Ann writes to one',
        );

        await expect
            .poll(() =>
                probe
                    .events(`private-conversation.${mine.ulid}`)
                    .map((event) => event.event),
            )
            .toContain('message.created');

        const heard = JSON.stringify([
            probe.events(`private-conversation.${mine.ulid}`),
            probe.events(`private-conversation.${theirs.ulid}`),
        ]);

        expect(probe.events(`conversation.${theirs.ulid}`)).toEqual([]);
        expect(heard).toContain('for visitor one');
        expect(heard).not.toContain('for visitor two only');
        // The staff user id of the writer never goes over the shared channel.
        expect(heard).not.toContain(`"id":${world.agents.ann.id}`);
    } finally {
        probe.close();
    }

    await Promise.all([one.dispose(), two.dispose()]);
});
