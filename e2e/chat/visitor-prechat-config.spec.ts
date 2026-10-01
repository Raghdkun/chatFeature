import { must, VisitorApi } from '../support/chat-api';
import {
    createTeam,
    expect,
    startQueuedChat,
    test,
} from '../support/chat-flows';
import { openCustomerSite } from '../support/panel';
import { expectEventually } from '../support/wait';

/**
 * What the widget's configuration does to the visitor's panel, through the real panel on the customer site: the pre-chat form
 * (required / optional fields, consent, the server's 422 mapped to the right field), the topic picker (skipped for one topic, online
 * and offline topics), features switched off (attachments, end chat by the visitor, pre-chat, "Powered by"), and the texts per
 * language with the right-to-left layout of an Arabic visitor. Every test uses a widget of its own (`createTeam()` with a config).
 */
test.use({ scenario: 'p4-chat' });

const PRECHAT = {
    fields: {
        name: { enabled: true, required: true },
        email: { enabled: true, required: true },
        phone: { enabled: true, required: false },
    },
    consentText: 'I agree to the privacy policy.',
};

test('the pre-chat form follows the widget: required and optional fields, consent, client-side messages, and what the agent receives', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Pre'],
        config: { preChat: PRECHAT },
    });
    const pre = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    // With the pre-chat form on, the panel opens on the form itself (the welcome text is its header).
    await panel.expectState('prechat');

    const form = panel.tid('prechat-form');
    const field = (name: string) => form.locator(`input[name="${name}"]`);
    const posts: string[] = [];

    visitor.page.on('request', (request) => {
        if (
            request.method() === 'POST' &&
            request.url().includes('/public/conversations')
        ) {
            posts.push(request.url());
        }
    });

    // Name and email are required, the phone is marked optional, and consent has its own box with the configured text.
    await expect(form.getByText('(optional)')).toHaveCount(1);
    await expect(field('phone')).toBeVisible();
    await expect(
        form.getByLabel('I agree to the privacy policy.'),
    ).not.toBeChecked();

    await form.locator('button[type="submit"]').click();
    await expect(field('name')).toHaveAttribute('aria-invalid', 'true');
    await expect(field('email')).toHaveAttribute('aria-invalid', 'true');
    await expect(form.getByText('This field is required.')).toHaveCount(2);
    await expect(form.getByText('Please accept to continue.')).toBeVisible();
    expect(posts).toEqual([]);

    await field('name').fill('Dana Details');
    await field('email').fill('not-an-address');
    await field('phone').fill('call me maybe');
    await form.locator('button[type="submit"]').click();
    await expect(form.getByText('Enter a valid email address.')).toBeVisible();
    await expect(form.getByText('Enter a valid phone number.')).toBeVisible();
    expect(posts).toEqual([]);

    // Fixing the fields (the phone stays optional: empty is fine) and ticking the consent starts the chat.
    await field('email').fill('dana@example.test');
    await field('phone').fill('');
    await form.getByLabel('I agree to the privacy policy.').check();

    const created = visitor.page.waitForResponse(
        (response) =>
            new URL(response.url()).pathname ===
                '/api/v1/public/conversations' &&
            response.request().method() === 'POST',
    );

    await form.locator('button[type="submit"]').click();

    const ulid = chats.track(
        ((await (await created).json()) as { data: { ulid: string } }).data
            .ulid,
    );

    await panel.expectState('queued');
    await pre.inbox.expectOffer(ulid);

    // The agent has exactly what the visitor typed.
    const conversation = must<{
        visitor: {
            name: string;
            email: string;
            phone: string | null;
            verified: boolean;
        };
    }>(await pre.api.conversation(ulid), 'the agent reads the chat');

    expect(conversation.visitor).toMatchObject({
        name: 'Dana Details',
        email: 'dana@example.test',
        verified: false,
    });
    expect(conversation.visitor.phone ?? null).toBeNull();
});

test('a stale form is corrected by the server: a field that became required after the page loaded comes back as an error on that field, and the visitor can fix it', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const base = {
        hours: { mode: 'always_online' },
        greetings: { enabled: false },
    };
    const team = await createTeam(adminApi, instance, {
        agents: ['Stale'],
        config: {
            ...base,
            preChat: {
                fields: {
                    name: { enabled: true, required: true },
                    email: { enabled: true, required: false },
                    phone: { enabled: false, required: false },
                },
                consentText: null,
            },
        },
    });
    const stale = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    await panel.expectState('prechat');

    // Meanwhile the administrator makes the e-mail required (the visitor's page still has the old form).
    must(
        await adminApi.put(`/api/v1/widgets/${team.widget.ulid}/draft`, {
            config: {
                ...base,
                routing: {
                    waves: [
                        { afterSeconds: 0, statuses: ['online'] },
                        { afterSeconds: 20, statuses: ['away'] },
                    ],
                    wakeOfflineViaPush: false,
                    queueTimeoutSeconds: 45,
                },
                preChat: {
                    fields: {
                        name: { enabled: true, required: true },
                        email: { enabled: true, required: true },
                        phone: { enabled: false, required: false },
                    },
                    consentText: null,
                },
            },
        }),
        'the administrator edits the draft',
    );
    must(
        await adminApi.post(`/api/v1/widgets/${team.widget.ulid}/publish`),
        'the administrator publishes',
    );

    const form = panel.tid('prechat-form');

    visitor.watch.allow(/422/);
    await form.locator('input[name="name"]').fill('Stan Stale');
    await form.locator('button[type="submit"]').click();

    // The 422 names the email field: the error sits on that field (not a generic banner) and the form stays.
    const email = form.locator('input[name="email"]');

    await expect(email).toHaveCount(1);
    await expect(email).toHaveAttribute('aria-invalid', 'true');
    await panel.expectState('prechat');

    // Typing the address clears the error and the next submit goes through.
    await email.fill('stan@example.test');
    await form.locator('button[type="submit"]').click();
    await panel.expectState('queued');

    const queued = must<{ ulid: string }[]>(
        await stale.api.queue(),
        'the agent reads the queue',
    );

    chats.track(queued[0]?.ulid);
    expect(queued).toHaveLength(1);
});

test('topics: one topic skips the picker; with several the cards say which topic has nobody online and an offline topic leads to the message form', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    // One topic: no picker.
    const single = await createTeam(adminApi, instance, { agents: ['Solo'] });
    const solo = await actors.staffLogin(single.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const first = await startQueuedChat(actors, instance, chats, {
        key: single.widget.key,
        category: single.category.slug,
        name: 'Uno Topic',
    });

    await expect(
        first.panel.tid(`category-option-${single.category.slug}`),
    ).toHaveCount(0);
    await solo.inbox.expectOffer(first.ulid);

    // Two topics: the first has an agent online, the second has nobody.
    const team = await createTeam(adminApi, instance, {
        agents: ['Duo'],
        emptyCategories: ['Returns'],
    });

    await actors.staffLogin(team.agents[0], {
        presence: 'online',
        keepAlive: true,
    });

    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    await panel.expectState(['prechat', 'category']);

    if ((await panel.state()) === 'prechat') {
        await panel
            .tid('prechat-form')
            .locator('input[name="name"]')
            .fill('Duo Topic');
        await panel
            .tid('prechat-form')
            .locator('button[type="submit"]')
            .click();
    }

    await panel.expectState('category');

    const cards = panel.frame.locator('[data-testid^="category-option-"]');

    await expect(cards).toHaveCount(2);
    await expect(
        panel.tid(`category-option-${team.category.slug}`),
    ).toContainText('Online');
    await expect(cards.nth(1)).toContainText('Offline: leave a message');

    // The offline topic goes to the message form (the server answers `409 no_agents` for it).
    await cards.nth(1).click();
    await panel.expectState('offline');
    await expect(panel.tid('offline-form')).toBeVisible();
    await expect(
        panel.tid('offline-form').locator('select[name="category"]'),
    ).toHaveValue(/returns/);
});

test('features switched off: no attach button and the server refuses uploads, no end-chat button and the server refuses it, no pre-chat form, no "Powered by"', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Lean'],
        config: {
            features: {
                attachments: false,
                endChatByVisitor: false,
                preChat: false,
                poweredBy: false,
            },
        },
    });
    const lean = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });
    const visitor = await actors.visitor();
    const panel = await openCustomerSite(visitor.page, instance, {
        key: team.widget.key,
        open: true,
    });

    // No pre-chat form: "Start chat" goes straight to the chat request; nobody asked for a name.
    await panel.tid('idle-start').click();
    await panel.expectState('queued');

    const ulid = chats.track(
        must<{ ulid: string }[]>(await lean.api.queue(), 'the queue')[0].ulid,
    );

    await lean.inbox.expectOffer(ulid);
    await lean.inbox.accept(ulid);
    await panel.expectState('active');

    expect(
        must<{ visitor: { name: string | null } }>(
            await lean.api.conversation(ulid),
            'the chat',
        ).visitor.name,
    ).toBeNull();

    await expect(panel.tid('composer-attach')).toHaveCount(0);
    await expect(panel.tid('end-chat')).toHaveCount(0);
    await expect(panel.frame.getByText('Powered by PNE Chat')).toHaveCount(0);

    // The server says the same to a client that tries anyway.
    const api = await VisitorApi.withToken(
        instance,
        (await panel.visitorToken())!,
        visitor.address,
    );
    const upload = await api.upload(ulid, {
        name: 'x.png',
        mimeType: 'image/png',
        buffer: Buffer.from('89504e470d0a1a0a', 'hex'),
    });
    const end = await api.end(ulid);

    expect(upload.status).toBe(403);
    expect(upload.error?.code).toBe('feature_disabled');
    expect(end.status).toBe(403);
    expect(end.error?.code).toBe('feature_disabled');
    await api.dispose();

    // The agent can still end it (the switch is about the visitor).
    await lean.inbox.endChat();
    await expectEventually(
        async () =>
            must<{ status: string }>(
                await lean.api.conversation(ulid),
                'the chat after the agent ended it',
            ).status,
        (status) => status === 'ended' || status === 'closed',
        { message: 'the agent ends the chat' },
    );
});

test('texts per language: an English visitor reads the English texts, an Arabic visitor the Arabic ones with the panel laid out right to left', async ({
    actors,
    adminApi,
    chats,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Poly'],
        config: {
            texts: {
                en: {
                    title: 'Acme support',
                    welcome: 'Hi! How can we help you today?',
                    placeholder: 'Type your message…',
                },
                ar: {
                    title: 'دعم أكمي',
                    welcome: 'مرحباً! كيف يمكننا مساعدتك؟',
                    placeholder: 'اكتب رسالتك…',
                },
            },
        },
    });
    const poly = await actors.staffLogin(team.agents[0], {
        presence: 'online',
        open: '/inbox',
    });

    const layout = async (
        locale: string,
    ): Promise<{ dir: string; sendAfterInput: boolean; title: string }> => {
        const visitor = await actors.visitor({ locale });
        const panel = await openCustomerSite(visitor.page, instance, {
            key: team.widget.key,
            open: true,
        });
        const flow = await startQueuedChat(actors, instance, chats, {
            actor: visitor,
            key: team.widget.key,
            category: team.category.slug,
            name: 'Poly Glot',
        });

        await poly.inbox.expectOffer(flow.ulid);
        await poly.inbox.accept(flow.ulid);
        await panel.expectState('active');

        const input = (await panel.composerInput.boundingBox())!;
        const send = (await panel.tid('composer-send').boundingBox())!;

        return {
            dir: (await panel.root.getAttribute('dir')) ?? '',
            sendAfterInput: send.x > input.x,
            title: (await panel.frame.locator('h1').innerText()).trim(),
        };
    };

    const english = await layout('en-US');

    expect(english.dir).toBe('ltr');
    expect(english.sendAfterInput).toBe(true);

    await poly.inbox.goto();

    const arabic = await layout('ar');

    expect(arabic.dir).toBe('rtl');
    // Right to left: the send button sits at the visual left of the box, the box and its controls are mirrored.
    expect(arabic.sendAfterInput).toBe(false);
    await poly.inbox.goto();
});

test('the Arabic panel speaks Arabic from the first screen on: welcome text, direction and document language', async ({
    actors,
    adminApi,
    instance,
}) => {
    const team = await createTeam(adminApi, instance, {
        agents: ['Arab'],
        config: {
            texts: {
                en: { welcome: 'Hi! How can we help you today?' },
                ar: { welcome: 'مرحباً! كيف يمكننا مساعدتك؟' },
            },
        },
    });
    await actors.staffLogin(team.agents[0], {
        presence: 'online',
        keepAlive: true,
    });

    const english = await actors.visitor({ locale: 'en-US' });
    const arabic = await actors.visitor({ locale: 'ar' });
    const englishPanel = await openCustomerSite(english.page, instance, {
        key: team.widget.key,
        open: true,
    });
    const arabicPanel = await openCustomerSite(arabic.page, instance, {
        key: team.widget.key,
        open: true,
    });

    await expect(
        englishPanel.frame.getByText('Hi! How can we help you today?'),
    ).toBeVisible();
    await expect(
        arabicPanel.frame.getByText('مرحباً! كيف يمكننا مساعدتك؟'),
    ).toBeVisible();
    await expect(arabicPanel.root).toHaveAttribute('dir', 'rtl');
    await expect(arabicPanel.root).toHaveAttribute('lang', /^ar/);
    await expect(englishPanel.root).toHaveAttribute('dir', 'ltr');
    await expect(englishPanel.root).toHaveAttribute('lang', /^en/);
});
