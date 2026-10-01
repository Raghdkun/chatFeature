import { must, VisitorApi } from '../support/chat-api';
import {
    createTeam,
    expect,
    startActiveChat,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { chatFeature, recordedEvents } from '../support/host';
import { mintIdentityToken, rotateIdentitySecret } from '../support/identity';
import { openCustomerSite } from '../support/panel';

/**
 * Signed visitor identity (the host's backend mints an HS256 token with the widget's secret): the agent sees a verified badge with
 * the name and e-mail from the claims, the claims win over what the pre-chat form says, a forged or expired token is refused with
 * the panel's notice (and never downgraded to an anonymous chat), unsigned data stays unverified, and a verified visitor's chat is
 * resumed from another browser. Every test has its own widget, so its identity secret is its own.
 */
test.use({ scenario: 'p4-chat' });

type StaffConversation = {
    visitor: {
        ulid: string;
        name: string | null;
        email: string | null;
        verified: boolean;
    };
};

test('a signed identity: the agent sees the verified badge with the name and e-mail from the claims, and the pre-chat form cannot overwrite them', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ida'] });
    const secret = await rotateIdentitySecret(adminApi, team.widget.ulid);
    const ida = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const token = mintIdentityToken(secret, {
        key: team.widget.key,
        sub: 'customer-1001',
        name: 'Dana Verified',
        email: 'dana.verified@example.test',
        meta: { plan: 'pro' },
    });
    const flow = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        // What the visitor types into the pre-chat form is not what the agent sees: the signed claims are authoritative.
        name: 'Somebody Else',
        email: 'somebody.else@example.test',
        identityToken: token,
    });

    // The offer card already carries the verified mark and the claimed name.
    const offer = ida.inbox.offer(flow.ulid);

    await ida.inbox.expectOffer(flow.ulid);
    await expect(offer).toContainText('Dana Verified');
    await expect(offer.getByLabel('Verified')).toBeVisible();

    await ida.inbox.accept(flow.ulid);
    await flow.panel.expectState('active');
    await expect(ida.inbox.tid('conversation-name')).toHaveText(
        'Dana Verified',
    );
    await expect(ida.inbox.tid('conversation-verified')).toBeVisible();

    const chat = must<StaffConversation>(
        await ida.api.conversation(flow.ulid),
        'the agent reads the chat',
    );

    expect(chat.visitor).toMatchObject({
        name: 'Dana Verified',
        email: 'dana.verified@example.test',
        verified: true,
    });

    // The visitor's own messages show the way they always do.
    await flow.panel.send('I am logged in on your site.');
    await ida.inbox.expectMessage('logged in on your site');
});

test('unsigned visitor data from the host page is shown to the agent but never marked verified', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Una'] });
    const una = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const flow = await startQueuedChat(actors, instance, chats, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Unsigned Uma',
        visitor: { name: 'Unsigned Uma', email: 'uma@example.test' },
    });

    await una.inbox.expectOffer(flow.ulid);
    await una.inbox.accept(flow.ulid);
    await expect(una.inbox.tid('conversation-name')).toHaveText('Unsigned Uma');
    await expect(una.inbox.tid('conversation-verified')).toHaveCount(0);
    expect(
        must<StaffConversation>(
            await una.api.conversation(flow.ulid),
            'the chat',
        ).visitor.verified,
    ).toBe(false);
});

test("a forged or an expired identity is refused with the panel's notice, no chat is created and nothing is downgraded to anonymous; a fresh valid one works after a reload", async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ivo'] });
    const secret = await rotateIdentitySecret(adminApi, team.widget.ulid);
    const ivo = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const claims = {
        key: team.widget.key,
        sub: 'customer-2002',
        name: 'Dora Forged',
        email: 'dora@example.test',
    };
    const forged = mintIdentityToken('not-the-widgets-secret', claims);
    const expired = mintIdentityToken(secret, { ...claims, ttl: -120 });
    const wrongWidget = mintIdentityToken(secret, {
        ...claims,
        claims: { iss: 'wk_someotherwidgetkey000' },
    });

    for (const [name, token] of [
        ['forged', forged],
        ['expired', expired],
        ['for another widget', wrongWidget],
    ] as const) {
        const visitor = await actors.visitor();

        visitor.watch.allow(/422/);

        const panel = await openCustomerSite(visitor.page, instance, {
            key: team.widget.key,
            identityToken: token,
            open: true,
        });

        await panel.tid('idle-start').click();

        const prechat = panel.tid('prechat-form');

        if (await prechat.isVisible().catch(() => false)) {
            await prechat.locator('input[name="name"]').fill('Dora Forged');
            await prechat.locator('button[type="submit"]').click();
        }

        // The notice is the panel's own words, and the visitor is not put into a chat without identity.
        await expect(
            panel.frame.getByText(
                "We couldn't verify your sign-in. Reload the page and try again.",
            ),
            `${name}: the notice`,
        ).toBeVisible();
        await expect(panel.tid('queued-timer')).toHaveCount(0);
        expect(
            await panel.visitorToken(),
            `${name}: no session is stored`,
        ).toBeNull();
    }

    expect(must<unknown[]>(await ivo.api.queue(), 'the queue')).toEqual([]);

    // The same refusal at the API (`details.identity_token`), never a silent anonymous session.
    await expect(
        VisitorApi.start(instance, {
            key: team.widget.key,
            identityToken: forged,
        }),
    ).rejects.toThrow(/422/);

    // A fresh, valid token (the host page reloaded and minted a new one) works.
    const visitor = await actors.visitor();
    const flow = await startQueuedChat(actors, instance, chats, {
        actor: visitor,
        key: team.widget.key,
        category: team.category.slug,
        name: 'Dora Forged',
        identityToken: mintIdentityToken(secret, claims),
    });

    await ivo.inbox.expectOffer(flow.ulid);
    expect(
        must<StaffConversation>(
            await ivo.api.conversation(flow.ulid),
            'the chat',
        ).visitor.verified,
    ).toBe(true);
});

test("a verified visitor's chat is resumed from another browser: same ticket, same transcript, one conversation; the first browser loses the chat", async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ines'] });
    const secret = await rotateIdentitySecret(adminApi, team.widget.ulid);
    const ines = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const claims = {
        key: team.widget.key,
        sub: 'customer-3003',
        name: 'Rhea Roaming',
        email: 'rhea@example.test',
    };
    const first = await startActiveChat(actors, instance, chats, ines, {
        key: team.widget.key,
        category: team.category.slug,
        name: 'Rhea Roaming',
        identityToken: mintIdentityToken(secret, claims),
    });

    await first.panel.send('Started on my laptop.');
    await ines.inbox.expectMessage('Started on my laptop');

    // The same customer signs in on a phone: another browser with its own storage and a freshly minted token.
    const phone = await actors.visitor({ device: 'desktop' });
    const second = await openCustomerSite(phone.page, instance, {
        key: team.widget.key,
        identityToken: mintIdentityToken(secret, claims),
        open: true,
    });

    // The session of a visitor is made when they first write, so the phone shows the start screen; asking for a chat (the same
    // topic) is answered with the chat that is already running (`409 conversation_exists`): the panel carries on with it.
    await second.expectState(['idle', 'prechat', 'category']);

    const resumed = await second.startChat({
        category: team.category.slug,
        name: 'Rhea Roaming',
    });

    expect(resumed.status).toBe(409);
    await second.expectState('active');
    await second.expectMessage('Started on my laptop', 'visitor');
    await expect(
        second.root.getByRole('heading', { name: team.agents[0].name }),
    ).toBeVisible();

    await second.send('Continuing on my phone.');
    await ines.inbox.expectMessage('Continuing on my phone');

    // One visitor, one conversation, the same ticket.
    const all = must<{ ulid: string; visitor: { verified: boolean } }[]>(
        await adminApi.get(
            `/api/v1/conversations?widget=${team.widget.ulid}&limit=50`,
        ),
        "the widget's conversations",
    );

    expect(all.map((conversation) => conversation.ulid)).toEqual([first.ulid]);
    expect(all[0].visitor.verified).toBe(true);

    // The first browser's session was revoked when the chat moved: its next message ends in the "session expired" screen, the chat
    // itself is not lost for the customer (it is on the phone).
    await first.panel.send('Still typing on the laptop?');
    await first.panel.expectState('closed');
    await expect(
        first.panel.frame.getByText(
            'Your session expired. Start a new chat to continue.',
        ),
    ).toBeVisible();

    const stored = must<{ sender: { type: string }; body: string }[]>(
        await ines.api.messages(first.ulid),
        'the stored messages',
    )
        .filter((message) => message.sender.type === 'visitor')
        .map((message) => message.body);

    expect(stored).toEqual([
        'Started on my laptop.',
        'Continuing on my phone.',
    ]);
    expect(
        (await recordedEvents(phone.page)).map((event) => event.name),
    ).toEqual(expect.arrayContaining(['ready']));
});

test('identify() hands the panel a signed identity after the page loaded: the next chat is verified', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, { agents: ['Ian'] });
    const secret = await rotateIdentitySecret(adminApi, team.widget.ulid);
    const ian = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
    });

    // The customer logs in on the page and the page tells the widget (no token was there at load time).
    await chatFeature(
        visitor.page,
        'identify',
        mintIdentityToken(secret, {
            key: team.widget.key,
            sub: 'customer-4004',
            name: 'Ivy Identified',
            email: 'ivy@example.test',
        }),
    );
    await panel.open();

    const started = await panel.startChat({
        category: team.category.slug,
        name: 'Ivy Identified',
    });

    chats.track(started.ulid);
    await ian.inbox.expectOffer(started.ulid!);
    expect(
        must<StaffConversation>(
            await ian.api.conversation(started.ulid!),
            'the chat',
        ).visitor,
    ).toMatchObject({ name: 'Ivy Identified', verified: true });
});
