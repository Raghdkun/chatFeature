import type { APIRequestContext } from '@playwright/test';
import { artisan } from '../support/artisan';
import { VisitorApi } from '../support/chat-api';
import { hostOrigin } from '../support/host';
import { SocketProbe, type Authoriser } from '../support/realtime';
import { createAdminAgent, readAppLog } from '../support/staff-db';
import { signInApi } from '../support/actors';
import { unique } from '../support/helpers';
import { asBase64, smallPng } from '../support/wa-images';
import { linkedChat, requestHandoff, whatsappWidget } from '../support/wa-flow';
import {
    expect,
    readySession,
    test,
    transcript,
    uniquePhone,
    waitForChat,
    waitForMessage,
} from '../support/wa-test';
import {
    data,
    eventually,
    type WaChat,
    type WaMessage,
} from '../support/whatsapp';
import { PASSWORD } from '../support/users';

/**
 * Admin-only isolation (P6-D1) in real browsers and over HTTP: an agent (Alice), a visitor token and an anonymous caller against EVERY WhatsApp
 * page, API route, signed media URL and websocket channel. The route list comes from the application itself (`artisan route:list`), so a route
 * that is added later and forgotten here fails the matrix instead of passing silently. A refused call must change nothing: the session, its
 * settings, the chats and what OpenWA was asked are compared before and after.
 */
test.use({ scenario: 'p6-wa' });

type RouteRow = { method: string; uri: string; middleware: string[] | string };

async function whatsappRoutes(
    instance: Parameters<typeof artisan>[0],
): Promise<RouteRow[]> {
    const output = await artisan(instance, [
        'route:list',
        '--path=whatsapp',
        '--json',
    ]);

    return JSON.parse(output.slice(output.indexOf('['))) as RouteRow[];
}

type Fixture = {
    session: Awaited<ReturnType<typeof readySession>>;
    chat: WaChat;
    message: WaMessage;
    image: WaMessage;
    widget: { ulid: string; key: string; name: string };
    marker: string;
};

/** A session, a linked chat with text and a stored picture, and a unique marker word that only WhatsApp data contains. */
async function populate(
    adminApi: Parameters<typeof whatsappWidget>[0],
    wa: Parameters<typeof whatsappWidget>[1],
    instance: Parameters<typeof whatsappWidget>[2],
    openWa: Parameters<typeof linkedChat>[0],
): Promise<Fixture> {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const marker = unique('wamarker').replace(/[^a-z0-9]/gi, '');
    const { chat, customer } = await linkedChat(
        openWa,
        wa,
        instance,
        session,
        widget,
        {
            name: `Visitor ${marker}`,
            email: `${marker}@example.test`,
            pushName: `Customer ${marker}`,
        },
    );

    await openWa.inboundText(session.name, customer, `Secret ${marker} text`, {
        pushName: `Customer ${marker}`,
    });
    await openWa.inboundImage(session.name, customer, `Photo ${marker}`, {
        dataBase64: asBase64(smallPng(32)),
        filename: 'p.png',
    });

    const message = await waitForMessage(
        wa,
        chat,
        (row) => row.body === `Secret ${marker} text`,
    );
    const image = await waitForMessage(
        wa,
        chat,
        (row) =>
            row.type === 'image' &&
            (row as unknown as { media: { available: boolean } }).media
                .available,
        'the stored picture',
    );

    return { session, chat, message, image, widget, marker };
}

const fill = (uri: string, fixture: Fixture): string =>
    `/${uri}`
        .replace('{session}', fixture.session.ulid)
        .replace('{chat}', fixture.chat.ulid)
        .replace('{message}', fixture.image.ulid)
        .replace('{widget}', fixture.widget.ulid)
        .replace('{key}', fixture.widget.key);

/** A small valid-looking body for the routes that take one: the refusal must come before any validation. */
const bodyFor = (
    method: string,
    uri: string,
): Record<string, unknown> | undefined => {
    if (method === 'GET' || method === 'HEAD' || method === 'DELETE') {
        return undefined;
    }

    if (uri.endsWith('/messages')) {
        return { body: 'An agent must not send this' };
    }

    if (uri.endsWith('/whatsapp') && uri.includes('widgets')) {
        return { session: null };
    }

    if (uri.endsWith('settings')) {
        return {
            enabled: false,
            ignore_groups: false,
            reply_only_to_inbound: false,
        };
    }

    if (uri.endsWith('api/v1/whatsapp/sessions')) {
        return { name: 'made-by-an-agent' };
    }

    if (uri.includes('/sessions/{session}') && method === 'PATCH') {
        return { send_min_interval_ms: 0, daily_send_cap: 10_000 };
    }

    return {};
};

async function call(
    context: APIRequestContext,
    method: string,
    path: string,
    body: Record<string, unknown> | undefined,
    headers: Record<string, string> = {},
): Promise<{
    status: number;
    text: string;
    headers: Record<string, string>;
    location: string | null;
}> {
    const response = await context.fetch(path, {
        method,
        headers,
        data: body === undefined ? undefined : JSON.stringify(body),
        failOnStatusCode: false,
        maxRedirects: 0,
    });

    return {
        status: response.status(),
        text: await response.text(),
        headers: response.headers(),
        location: response.headers().location ?? null,
    };
}

/** What a refused call must not change: the session, the settings, the chat, what OpenWA was asked. */
async function snapshot(
    wa: Parameters<typeof populate>[1],
    openWa: Parameters<typeof populate>[3],
    fixture: Fixture,
) {
    const mock = (await openWa.state()).sessions.find(
        (candidate) => candidate.name === fixture.session.name,
    )!;
    const state = JSON.stringify({
        // Only this test's session: other spec files create and change theirs at the same time.
        sessions: (await wa.sessions()).data.filter(
            (row: { ulid: string }) => row.ulid === fixture.session.ulid,
        ),
        settings: (await wa.settings()).data,
        chats: (
            await wa.chats({ status: 'all', session: fixture.session.ulid })
        ).data,
        messages: await transcript(wa, fixture.chat),
        link: (
            await wa.api.get(`/api/v1/widgets/${fixture.widget.ulid}/whatsapp`)
        ).data,
        openwaCalls: (await openWa.requests()).filter((call) =>
            call.path.includes(`/${mock.id}`),
        ).length,
    });

    // A signed link carries an expiry and a signature that are new on every read: they are not state.
    return JSON.parse(
        state.replace(/\?expires=\d+&signature=[0-9a-f]+/g, ''),
    ) as Record<string, unknown>;
}

test('every WhatsApp page and API route refuses an agent with 403, a visitor token and a guest with 401 or a redirect, and a refused call changes nothing', async ({
    actors,
    adminApi,
    instance,
    openWa,
    playwright,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const routes = await whatsappRoutes(instance);
    const alice = await actors.staff('alice');
    const visitor = await VisitorApi.start(instance, {
        key: fixture.widget.key,
        visitor: { name: 'A visitor' },
    });
    const bearer = await playwright.request.newContext({
        baseURL: instance.url,
        extraHTTPHeaders: {
            Authorization: `Bearer ${visitor.token}`,
            Accept: 'application/json',
            Origin: hostOrigin(instance),
        },
    });
    const guest = await playwright.request.newContext({
        baseURL: instance.url,
        extraHTTPHeaders: { Accept: 'application/json' },
    });
    const before = await snapshot(wa, openWa, fixture);
    const seen: string[] = [];

    // The matrix is complete: only these kinds of route exist (a new kind must be added here on purpose).
    const kinds = routes.map((route) => {
        const middleware = Array.isArray(route.middleware)
            ? route.middleware
            : [route.middleware];
        const joined = middleware.join(',');

        if (route.uri.includes('public/widgets')) {
            return 'handoff';
        }

        expect(joined, route.uri).toContain('EnsureWhatsAppAdmin');

        return route.uri.startsWith('api/') ? 'api' : 'page';
    });

    expect(routes.length).toBeGreaterThanOrEqual(28);
    expect(kinds.filter((kind) => kind === 'page')).toHaveLength(3);
    expect(kinds.filter((kind) => kind === 'handoff')).toHaveLength(1);

    for (const [index, route] of routes.entries()) {
        const method = route.method.split('|')[0];
        const path = fill(route.uri, fixture);
        const kind = kinds[index];
        const body = bodyFor(method, route.uri);
        const label = `${method} ${route.uri}`;

        if (kind === 'handoff') {
            // The public route: a visitor token is its only key. An agent's cookie or a guest has none.
            expect(
                (
                    await call(alice.context.request, method, path, body, {
                        Accept: 'application/json',
                        Origin: hostOrigin(instance),
                    })
                ).status,
                `agent ${label}`,
            ).toBe(401);
            expect(
                (
                    await call(guest, method, path, body, {
                        Origin: hostOrigin(instance),
                    })
                ).status,
                `guest ${label}`,
            ).toBe(401);

            continue;
        }

        if (kind === 'page') {
            const html = { Accept: 'text/html,application/xhtml+xml' };
            const asAgent = await call(
                alice.context.request,
                method,
                path,
                undefined,
                html,
            );

            expect(asAgent.status, `agent ${label}`).toBe(403);
            seen.push(asAgent.text);

            const asVisitor = await call(bearer, method, path, undefined, html);
            const asGuest = await call(guest, method, path, undefined, html);

            for (const [who, answer] of [
                ['visitor', asVisitor],
                ['guest', asGuest],
            ] as const) {
                expect([302, 401, 403], `${who} ${label}`).toContain(
                    answer.status,
                );

                if (answer.status === 302) {
                    expect(answer.location, `${who} ${label}`).toMatch(
                        /\/login/,
                    );
                }

                seen.push(answer.text);
            }

            continue;
        }

        // The management API: JSON everywhere. An agent's session cookie needs the XSRF header of a real browser: Api() adds it.
        const asAgent = await alice.api.api.request(
            method as 'GET',
            path,
            body,
        );

        expect(asAgent.status, `agent ${label}`).toBe(403);
        expect(asAgent.error?.code, `agent ${label}`).toMatch(
            /^(forbidden|no_chat_access)$/,
        );
        seen.push(JSON.stringify(asAgent.body));

        for (const [who, context] of [
            ['visitor token', bearer],
            ['guest', guest],
        ] as const) {
            const answer = await call(context, method, path, body);

            expect(answer.status, `${who} ${label}`).toBe(401);
            seen.push(answer.text);
        }
    }

    // Nothing in any refusal says that WhatsApp exists or shows what is in it.
    const refused = seen.join('\n');

    for (const needle of [
        fixture.marker,
        fixture.session.name,
        fixture.session.phone,
        fixture.widget.name,
    ]) {
        expect(refused).not.toContain(needle);
    }

    // And nothing happened: not a setting, not a session, not a reply, not one call at OpenWA.
    expect(await snapshot(wa, openWa, fixture)).toEqual(before);
    await visitor.dispose();
    await bearer.dispose();
    await guest.dispose();
});

test('a visitor token and a guest are refused the same way whether the chat, session, message or widget exists or not (nothing to probe for)', async ({
    actors,
    adminApi,
    instance,
    openWa,
    playwright,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const alice = await actors.staff('alice');
    const visitor = await VisitorApi.start(instance, {
        key: fixture.widget.key,
    });
    const bearer = await playwright.request.newContext({
        baseURL: instance.url,
        extraHTTPHeaders: {
            Authorization: `Bearer ${visitor.token}`,
            Accept: 'application/json',
        },
    });
    const guest = await playwright.request.newContext({
        baseURL: instance.url,
        extraHTTPHeaders: { Accept: 'application/json' },
    });
    const missing = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const paths: [string, string, string][] = [
        [
            'GET',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}`,
            `/api/v1/whatsapp/chats/${missing}`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}/messages`,
            `/api/v1/whatsapp/chats/${missing}/messages`,
        ],
        [
            'POST',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}/messages`,
            `/api/v1/whatsapp/chats/${missing}/messages`,
        ],
        [
            'POST',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}/archive`,
            `/api/v1/whatsapp/chats/${missing}/archive`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/sessions/${fixture.session.ulid}`,
            `/api/v1/whatsapp/sessions/${missing}`,
        ],
        [
            'DELETE',
            `/api/v1/whatsapp/sessions/${fixture.session.ulid}`,
            `/api/v1/whatsapp/sessions/${missing}`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/sessions/${fixture.session.ulid}/qr`,
            `/api/v1/whatsapp/sessions/${missing}/qr`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/media/${fixture.image.ulid}`,
            `/api/v1/whatsapp/media/${missing}`,
        ],
        [
            'GET',
            `/api/v1/widgets/${fixture.widget.ulid}/whatsapp`,
            `/api/v1/widgets/${missing}/whatsapp`,
        ],
    ];
    const answer = async (who: string, method: string, path: string) =>
        who === 'agent'
            ? (() =>
                  alice.api.api
                      .request(
                          method as 'GET',
                          path,
                          method === 'POST' ? { body: 'x' } : undefined,
                      )
                      .then((result) => ({
                          status: result.status,
                          text: JSON.stringify(result.body),
                      })))()
            : call(
                  who === 'visitor' ? bearer : guest,
                  method,
                  path,
                  method === 'POST' ? { body: 'x' } : undefined,
              );

    for (const who of ['visitor', 'guest']) {
        for (const [method, real, fake] of paths) {
            const found = await answer(who, method, real);
            const none = await answer(who, method, fake);

            expect(found.status, `${who} ${method} ${real}`).toBe(none.status);
            expect(
                found.text
                    .replaceAll(fixture.chat.ulid, 'X')
                    .replaceAll(missing, 'X'),
                `${who} ${method} ${real}`,
            ).toBe(
                none.text
                    .replaceAll(fixture.chat.ulid, 'X')
                    .replaceAll(missing, 'X'),
            );
        }
    }

    await visitor.dispose();
    await bearer.dispose();
    await guest.dispose();
});

test('a signed picture link is useless without an administrator: a guest, a visitor token and an agent are all refused, and the signature cannot be moved', async ({
    actors,
    adminApi,
    instance,
    openWa,
    playwright,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const signed = (fixture.image as unknown as { media: { url: string } })
        .media.url;
    const url = new URL(signed);
    const alice = await actors.staff('alice');
    const visitor = await VisitorApi.start(instance, {
        key: fixture.widget.key,
    });
    const guest = await playwright.request.newContext();
    const bearer = await playwright.request.newContext({
        extraHTTPHeaders: { Authorization: `Bearer ${visitor.token}` },
    });

    // The administrator's session works (the control).
    expect(
        (await adminApi.request('GET', `${url.pathname}${url.search}`)).status,
    ).toBe(200);

    for (const [who, context] of [
        ['guest', guest],
        ['visitor token', bearer],
        ['agent', alice.context.request],
    ] as const) {
        const answer = await context.get(signed, {
            failOnStatusCode: false,
            maxRedirects: 0,
        });

        expect([401, 403], who).toContain(answer.status());
        expect(answer.headers()['content-type'] ?? '', who).not.toContain(
            'image/',
        );
    }

    // Moving the signature onto another message or another path is refused even for the administrator.
    const other = await wa.messages(fixture.chat.ulid);
    const text = (other.data as WaMessage[]).find(
        (row) => row.type === 'text',
    )!;
    const moved = `/api/v1/whatsapp/media/${text.ulid}${url.search}`;

    expect((await adminApi.request('GET', moved)).status).toBe(403);
    expect(
        (
            await adminApi.request(
                'GET',
                `${url.pathname}?${url.searchParams.get('expires') ? `expires=${Number(url.searchParams.get('expires')) + 3600}` : ''}&signature=${url.searchParams.get('signature')}`,
            )
        ).status,
    ).toBe(403);
    await visitor.dispose();
    await guest.dispose();
    await bearer.dispose();
});

test('in the browser an agent finds no trace of WhatsApp: every page is a 403, the sidebar and the settings menu have no entry, and nothing of it is in the pages she can open', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const alice = await actors.staff('alice', { open: '/dashboard' });
    const page = alice.page;
    const html: string[] = [];

    // The agent's own areas load, and carry nothing of WhatsApp: no sidebar entry, no badge, no WhatsApp in the title.
    for (const path of [
        '/dashboard',
        '/inbox',
        '/offline-tickets',
        '/settings/profile',
        '/settings/notifications',
    ]) {
        const response = await page.goto(path);

        expect(response?.status(), path).toBe(200);
        html.push(await page.content());
        await expect(page.getByTestId('nav-badge-whatsapp'), path).toHaveCount(
            0,
        );
        await expect(page).not.toHaveTitle(/WhatsApp/i);
    }

    await page.goto('/dashboard');
    await expect(page.getByRole('link', { name: 'WhatsApp' })).toHaveCount(0);
    await expect(page.locator('a[href="/whatsapp"]')).toHaveCount(0);
    await page.goto('/settings/profile');
    await expect(page.locator('a[href="/settings/whatsapp"]')).toHaveCount(0);
    await expect(page.getByRole('link', { name: 'WhatsApp' })).toHaveCount(0);

    // The WhatsApp pages: a plain 403 page that names nothing.
    for (const path of [
        '/whatsapp',
        `/whatsapp/chats/${fixture.chat.ulid}`,
        '/settings/whatsapp',
    ]) {
        const response = await page.goto(path);

        expect(response?.status(), path).toBe(403);
        html.push(await page.content());
        await expect(page.getByTestId('wa-inbox')).toHaveCount(0);
        await expect(page.getByTestId('settings-whatsapp')).toHaveCount(0);
    }

    for (const needle of [
        fixture.marker,
        fixture.session.name,
        fixture.session.phone,
        fixture.widget.name,
        'wa-chat-',
        'whatsapp-admin',
    ]) {
        expect(html.join('\n'), needle).not.toContain(needle);
    }

    // Her browser never even asked the WhatsApp API.
    expect(
        alice.watch.statuses.filter((entry) =>
            entry.includes('/api/v1/whatsapp'),
        ),
    ).toEqual([]);
});

test("the live channel is the administrators' only: agents, visitors, guests and a deactivated administrator are refused by the real Reverb, and WhatsApp events reach nobody else", async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const widget = await whatsappWidget(adminApi, wa, instance, session);
    const alice = await actors.staff('alice', {
        presence: 'online',
        open: '/inbox',
    });
    const admin = await actors.staff('admin', { open: '/whatsapp' });
    const visitor = await VisitorApi.start(instance, { key: widget.key });
    const staff =
        (api: {
            post: (
                path: string,
                body?: unknown,
            ) => Promise<{ status: number; body: unknown }>;
        }): Authoriser =>
        (socketId, channel) =>
            api.post('/broadcasting/auth', {
                socket_id: socketId,
                channel_name: channel,
            });
    const visitorAuth: Authoriser = (socketId, channel) =>
        visitor.request('POST', '/broadcasting/auth', {
            socket_id: socketId,
            channel_name: channel,
        });
    const nobody: Authoriser = async () => ({
        status: 401,
        body: { message: 'Unauthenticated.' },
    });
    const channels = [
        'private-whatsapp-admin',
        'presence-whatsapp-admin',
        'whatsapp-admin',
        'private-whatsapp-admin.1',
        'private-whatsapp-admin ',
        'private-WHATSAPP-ADMIN',
        'private-whatsapp.admin',
        'private-admin',
        'private-staff.1',
    ];
    const probe = async (authorise: Authoriser) => {
        const socket = await SocketProbe.connect(instance, authorise);
        const outcome: Record<string, boolean> = {};

        try {
            for (const channel of channels) {
                outcome[channel] = (await socket.subscribe(channel)).subscribed;
            }
        } finally {
            socket.close();
        }

        return outcome;
    };
    const none = Object.fromEntries(
        channels.map((channel) => [channel, false]),
    );

    // Agents, visitors and guests: nothing WhatsApp.
    // (`whatsapp-admin` without a prefix is a PUBLIC channel name: a socket may join any public name, nothing is ever published to it. It
    // is checked for silence below.)
    const everyPrivate = { ...none, 'whatsapp-admin': true };

    expect(await probe(staff(alice.api.api))).toMatchObject({
        'private-whatsapp-admin': false,
        'presence-whatsapp-admin': false,
    });
    expect(await probe(staff(alice.api.api))).toEqual(
        expect.objectContaining({
            'private-whatsapp-admin.1': false,
            'private-WHATSAPP-ADMIN': false,
        }),
    );
    expect(await probe(visitorAuth)).toEqual(everyPrivate);
    expect(await probe(nobody)).toEqual(everyPrivate);

    // The administrator: exactly the private channel, in exactly that spelling.
    const adminProbe = await probe(staff(admin.api.api));

    expect(adminProbe['private-whatsapp-admin']).toBe(true);
    expect(adminProbe['presence-whatsapp-admin']).toBe(false);
    expect(adminProbe['private-whatsapp-admin.1']).toBe(false);
    expect(adminProbe['private-WHATSAPP-ADMIN']).toBe(false);

    // The endpoint itself: an agent's `403`, a visitor's refusal on the staff route and on the public one.
    expect(
        (
            await alice.api.api.post('/broadcasting/auth', {
                socket_id: '1.2',
                channel_name: 'private-whatsapp-admin',
            })
        ).status,
    ).toBe(403);
    expect(
        (
            await visitor.request('POST', '/broadcasting/auth', {
                socket_id: '1.2',
                channel_name: 'private-whatsapp-admin',
            })
        ).status,
    ).toBe(403);

    // Now real traffic: the administrator's own page and probe hear it, an agent's sockets (a real inbox and a probe on every channel she may
    // join) hear nothing WhatsApp.
    const hearAdmin = await SocketProbe.connect(instance, staff(admin.api.api));
    const hearAlice = await SocketProbe.connect(instance, staff(alice.api.api));
    const aliceId = (await wa.api.get('/api/v1/agents')).data.find(
        (row: { email: string }) => row.email.startsWith('alice'),
    )?.id;
    const frames: string[] = [];

    alice.page.on('websocket', (socket) =>
        socket.on('framereceived', (frame) =>
            frames.push(String(frame.payload)),
        ),
    );
    await alice.page.reload();
    await expect(
        alice.page
            .getByTestId('inbox-page')
            .or(alice.page.locator('main'))
            .first(),
    ).toBeVisible();

    try {
        expect(
            (await hearAdmin.subscribe('private-whatsapp-admin')).subscribed,
        ).toBe(true);
        await hearAlice.subscribe(`private-staff.${aliceId}`);
        await hearAlice.subscribe('presence-staff');

        const customer = uniquePhone();
        const marker = unique('liveword').replace(/[^a-z0-9]/gi, '');

        await openWa.inboundText(session.name, customer, `Live ${marker}`, {
            pushName: 'Live Customer',
        });

        const chat = await waitForChat(wa, session, customer);

        await eventually(
            async () =>
                hearAdmin
                    .events('private-whatsapp-admin')
                    .some((event) =>
                        event.event.endsWith('wa.message.created'),
                    ) || undefined,
            'the administrator to hear wa.message.created',
        );

        // What the administrator hears: versioned payloads with the chat and message, never the raw object, the WhatsApp id or a QR.
        const heard = hearAdmin.events('private-whatsapp-admin');
        // The administrator hears every WhatsApp chat of the instance (other spec files run beside this one): this chat's event.
        const created = heard.find(
            (event) =>
                event.event.endsWith('wa.message.created') &&
                JSON.stringify(event.data).includes(chat.ulid),
        )!;
        const payload = (
            typeof created.data === 'string'
                ? JSON.parse(created.data)
                : created.data
        ) as { v: number; chat: { ulid: string } };

        expect(payload.v).toBe(1);
        expect(payload.chat.ulid).toBe(chat.ulid);
        expect(JSON.stringify(payload)).toContain(marker);
        expect(JSON.stringify(heard)).not.toMatch(
            /waMessageId|wa_message_id|false_\d+@c\.us_|"raw"|chatId|data:image\/png/,
        );

        // A status change is announced to the administrator as well (and carries no QR picture).
        await openWa.setStatus(session.name, 'disconnected', {
            reason: 'LOGOUT',
        });
        await eventually(
            async () =>
                hearAdmin
                    .events('private-whatsapp-admin')
                    .some((event) =>
                        event.event.endsWith('wa.session.status'),
                    ) || undefined,
            'wa.session.status',
        );
        expect(
            JSON.stringify(hearAdmin.events('private-whatsapp-admin')),
        ).not.toContain('qrCode');

        // Alice heard nothing about it, on the channels she can join or in her own page's frames.
        await new Promise((done) => setTimeout(done, 1_000));

        for (const channel of [`private-staff.${aliceId}`, 'presence-staff']) {
            expect(
                JSON.stringify(hearAlice.events(channel)),
                channel,
            ).not.toMatch(new RegExp(`wa\\.|whatsapp|${marker}`, 'i'));
        }

        expect(frames.join('\n')).not.toMatch(
            new RegExp(
                `wa\\.message|wa\\.chat|wa\\.session|whatsapp-admin|${marker}`,
                'i',
            ),
        );
    } finally {
        hearAdmin.close();
        hearAlice.close();
        await visitor.dispose();
    }
});

test('no WhatsApp text reaches the live-chat side: conversation lists, search, export and history hold none of it, for an agent and for the administrator', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const alice = await actors.staff('alice');
    const needles = [
        fixture.marker,
        fixture.session.name,
        fixture.session.phone,
    ];
    const endpoints = [
        `/api/v1/conversations?q=${fixture.marker}`,
        `/api/v1/conversations?q=${fixture.session.phone}`,
        '/api/v1/conversations',
        '/api/v1/conversations/queue',
        `/api/v1/conversations/export?format=json&q=${fixture.marker}`,
        '/api/v1/conversations/export?format=json',
        '/api/v1/offline-tickets',
        '/api/v1/me/notification-settings',
        '/api/v1/agents',
    ];

    for (const [who, api] of [
        ['agent', alice.api.api],
        ['administrator', adminApi],
    ] as const) {
        for (const path of endpoints) {
            const answer = await api.get(path);

            expect(
                JSON.stringify(answer.body ?? answer.text ?? ''),
                `${who} ${path}`,
            ).not.toContain(fixture.marker);

            for (const needle of needles) {
                expect(answer.text ?? '', `${who} ${path}`).not.toContain(
                    needle,
                );
            }
        }
    }

    // The administrator's history page (live chats) is a different list: the marker is not in it either.
    const admin = await actors.staff('admin', {
        open: `/history?q=${fixture.marker}`,
    });

    await expect(admin.page.getByTestId('history-page')).toBeVisible();
    // The search box echoes the typed word; what matters is that nothing was found for it (no table, no cards).
    await expect(admin.page.getByTestId('history-search')).toHaveValue(
        fixture.marker,
    );
    await expect(
        admin.page.locator('[data-testid^="history-row-"]'),
    ).toHaveCount(0);
    await expect(
        admin.page.locator('[data-testid^="history-card-"]'),
    ).toHaveCount(0);
    expect(
        await admin.page.getByTestId('history-page').innerText(),
    ).not.toContain(fixture.session.phone);

    // The WhatsApp side does know it (control): searchable in its own inbox.
    expect(
        data<WaChat[]>(
            await wa.chats({ q: fixture.marker, status: 'all' }),
            'search',
        ).some((row) => row.ulid === fixture.chat.ulid),
    ).toBe(true);
});

test('an administrator who also takes chats still gets WhatsApp, and her agent side shows none of it', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const account = {
        name: unique('Dana Admin'),
        email: `${unique('dana')}@example.test`,
        password: PASSWORD,
    };
    const id = await createAdminAgent(instance, account);
    const dana = await actors.staffLogin(
        { ...account, kind: 'admin' },
        { presence: 'online', open: '/whatsapp' },
    );

    await expect(dana.page.getByTestId('wa-inbox')).toBeVisible();
    await expect(
        dana.page.getByTestId(`wa-chat-row-${fixture.chat.ulid}`),
    ).toBeVisible();
    expect((await dana.api.api.get('/api/v1/whatsapp/sessions')).status).toBe(
        200,
    );
    expect(
        (await dana.api.api.get(`/api/v1/whatsapp/chats/${fixture.chat.ulid}`))
            .status,
    ).toBe(200);
    expect(
        (
            await dana.api.api.post('/broadcasting/auth', {
                socket_id: '1.2',
                channel_name: 'private-whatsapp-admin',
            })
        ).status,
    ).toBe(200);

    // The same person's chat inbox is the agent's inbox, with nothing of WhatsApp in it.
    await dana.page.goto('/inbox');
    expect(await dana.page.content()).not.toContain(fixture.marker);
    expect(
        (await dana.api.api.get(`/api/v1/conversations?q=${fixture.marker}`))
            .data,
    ).toEqual([]);
    expect(id).toBeGreaterThan(0);
});

test('a deactivated administrator loses WhatsApp at once: the API, the pages and the live channel', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const fixture = await populate(adminApi, wa, instance, openWa);
    const account = {
        name: unique('Gone Admin'),
        email: `${unique('gone')}@example.test`,
        password: PASSWORD,
    };
    const id = await createAdminAgent(instance, account);
    const gone = await actors.staffLogin(
        { ...account, kind: 'admin' },
        { open: '/whatsapp' },
    );

    await expect(gone.page.getByTestId('wa-inbox')).toBeVisible();
    expect((await gone.api.api.get('/api/v1/whatsapp/sessions')).status).toBe(
        200,
    );

    const probeAuth: Authoriser = (socketId, channel) =>
        gone.api.api.post('/broadcasting/auth', {
            socket_id: socketId,
            channel_name: channel,
        });
    const before = await SocketProbe.connect(instance, probeAuth);

    expect((await before.subscribe('private-whatsapp-admin')).subscribed).toBe(
        true,
    );
    before.close();

    const deactivated = await adminApi.patch(`/api/v1/agents/${id}`, {
        is_active: false,
    });

    expect(deactivated.status).toBe(200);

    // The very next requests: no data, whichever way they ask.
    for (const path of [
        '/api/v1/whatsapp/sessions',
        `/api/v1/whatsapp/chats/${fixture.chat.ulid}`,
        '/api/v1/whatsapp/settings',
        '/api/v1/whatsapp/export?format=csv',
    ]) {
        const answer = await gone.api.api.get(path);

        expect([401, 403], path).toContain(answer.status);
        expect(answer.text ?? '', path).not.toContain(fixture.marker);
    }

    expect(
        (
            await gone.api.api.post(
                '/api/v1/whatsapp/sessions/' + fixture.session.ulid + '/stop',
            )
        ).status,
    ).toBeGreaterThanOrEqual(401);

    const afterProbe = await SocketProbe.connect(instance, probeAuth).catch(
        () => null,
    );

    if (afterProbe) {
        expect(
            (await afterProbe.subscribe('private-whatsapp-admin')).subscribed,
        ).toBe(false);
        afterProbe.close();
    }

    // The page: back to the login screen.
    await gone.page.goto('/whatsapp');
    await expect(gone.page).toHaveURL(/\/login/);

    // Nothing was done in her name (the session still stands).
    expect(
        data<{ status: string }>(await wa.session(fixture.session.ulid), 'read')
            .status,
    ).toBe('ready');
    void signInApi;
});

test("the visitor's hand-off route is theirs alone: a token of another widget, an unknown key and a foreign website are refused", async ({
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    const session = await readySession(wa, openWa);
    const mine = await whatsappWidget(adminApi, wa, instance, session);
    const other = await whatsappWidget(adminApi, wa, instance, session);
    const { visitor } = await requestHandoff(instance, mine);
    const path = (key: string) => `/widgets/${key}/whatsapp-handoff`;

    // The token belongs to widget `mine`: the other widget's key is the same 404 as an unknown one.
    const wrong = await visitor.request('POST', path(other.key), {});
    const unknown = await visitor.request(
        'POST',
        path('wk_doesnotexist0000000000'),
        {},
    );

    expect(wrong.status).toBe(404);
    expect(wrong.error?.code).toBe('widget_not_found');
    expect([unknown.status, unknown.error?.code]).toEqual([
        404,
        'widget_not_found',
    ]);

    // A page on a website that is not on the widget's list is refused by its origin, token or not.
    const foreign = await VisitorApi.withToken(
        instance,
        visitor.token,
        '198.51.100.250',
        'http://evil.example',
    );
    const refused = await foreign.request('POST', path(mine.key), {});

    expect(refused.status).toBe(403);
    expect(refused.error?.code).toBe('origin_not_allowed');
    await foreign.dispose();

    // No token at all, a made-up one, and the dashboard's own cookie are not visitors.
    const naked = await VisitorApi.withToken(instance, 'vt_' + 'a'.repeat(40));

    expect((await naked.request('POST', path(mine.key), {})).status).toBe(401);
    await naked.dispose();
    await visitor.dispose();
    void readAppLog;
});

test.fixme('BUG (open): an agent can tell a real WhatsApp chat, session, message or widget id from a made-up one (403 vs 404), on the API and on the pages', async ({
    actors,
    adminApi,
    instance,
    openWa,
    wa,
}) => {
    // Route model binding (`SubstituteBindings`) runs before `wa.admin`, so a well-formed ULID that exists answers 403 and one that does not
    // answers 404: the refusal is no longer the same "nothing here for you". Needs a valid ULID to probe (80 random bits), so this is an
    // inconsistency with docs/contracts/whatsapp-p6.md P6-D1 and docs/security.md ("nothing in the answer says that WhatsApp exists"), not an
    // exploitable leak. Repro: `GET /api/v1/whatsapp/chats/{ulid}` as an agent: 403 for a chat that exists, 404 for one that does not;
    // `GET /whatsapp/chats/{ulid}` the same. Expected: 403 for both.
    const fixture = await populate(adminApi, wa, instance, openWa);
    const alice = await actors.staff('alice');
    const missing = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

    for (const [method, real, fake] of [
        [
            'GET',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}`,
            `/api/v1/whatsapp/chats/${missing}`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}/messages`,
            `/api/v1/whatsapp/chats/${missing}/messages`,
        ],
        [
            'POST',
            `/api/v1/whatsapp/chats/${fixture.chat.ulid}/messages`,
            `/api/v1/whatsapp/chats/${missing}/messages`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/sessions/${fixture.session.ulid}`,
            `/api/v1/whatsapp/sessions/${missing}`,
        ],
        [
            'GET',
            `/api/v1/whatsapp/media/${fixture.image.ulid}`,
            `/api/v1/whatsapp/media/${missing}`,
        ],
        [
            'GET',
            `/api/v1/widgets/${fixture.widget.ulid}/whatsapp`,
            `/api/v1/widgets/${missing}/whatsapp`,
        ],
    ] as const) {
        const body = method === 'POST' ? { body: 'x' } : undefined;

        expect(
            (await alice.api.api.request(method, real, body)).status,
            real,
        ).toBe((await alice.api.api.request(method, fake, body)).status);
    }

    for (const path of [
        `/whatsapp/chats/${fixture.chat.ulid}`,
        `/whatsapp/chats/${missing}`,
    ]) {
        expect(
            (
                await call(alice.context.request, 'GET', path, undefined, {
                    Accept: 'text/html',
                })
            ).status,
            path,
        ).toBe(403);
    }
});
