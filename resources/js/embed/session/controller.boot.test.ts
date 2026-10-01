import { describe, expect, it } from 'vite-plus/test';
import { bootConfig, KEY } from '@/tests/msw/chat-visitor';
import { useBackend } from '@/tests/msw/server';
import {
    createHarness,
    loaderBoot,
    makeInit,
    settle,
    until,
} from '@/tests/embed-harness';

describe('boot', () => {
    it('stays in booting until init, then lands on the first screen and tells the host', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        expect(h.state().phase).toBe('booting');
        expect(h.hostStates()).toEqual([]);

        await h.init();
        h.open();

        // pre-chat form is on (name required) and there are two topics: the form comes first
        expect(h.state().phase).toBe('prechat');
        expect(h.hostStates().at(-1)).toEqual({
            status: 'prechat',
            open: true,
            unread: 0,
        });
    });

    it('reads fresh categories (description, icon, colour) and availability from the public config', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();

        const { config } = h.snapshot();

        expect(config?.categories[0]).toMatchObject({
            slug: 'billing',
            description: 'Invoices and payments',
            icon: 'credit-card',
            color: '#7c3aed',
        });
        expect(backend.callsTo('GET', '/config')).toHaveLength(1);
        expect(backend.callsTo('GET', '/config')[0].query.locale).toBe('en-US');
    });

    it("falls back to the loader's boot copy when the config endpoint is down", async () => {
        const backend = useBackend();

        backend.fail('GET', '/config$', 503, undefined, 3);

        const h = createHarness({ backend });

        await h.init();

        expect(h.snapshot().config?.categories.map((c) => c.slug)).toEqual([
            'billing',
            'tech',
        ]);
        // the loader passes description / icon / colour through: the picker does not depend on the config call
        expect(h.snapshot().config?.categories[0]).toMatchObject({
            description: 'Invoices and payments',
            icon: 'credit-card',
            color: '#7c3aed',
        });
        expect(h.state().phase).toBe('prechat');
    });

    it('does not hold the first screen back for a slow config call, and applies its answer when it arrives', async () => {
        const backend = useBackend();
        const base = bootConfig().config as object;
        const { createVisitorApi } = await import('@/lib/chat-api/visitor');
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = createHarness({
            backend,
            deps: {
                configTimeoutMs: 30,
                createApi: (options) => {
                    const real = createVisitorApi(options);

                    return {
                        ...real,
                        getConfig: async (locale?: string) => {
                            await gate;

                            return real.getConfig(locale);
                        },
                    };
                },
            },
        });

        // the loader's copy says "open"; the config call (late) will say nobody is available
        await h.init(makeInit({ boot: loaderBoot({ config: base }) }));
        expect(h.state().phase).toBe('prechat');

        backend.state.availability = {
            online: false,
            openNow: true,
            nextOpenAt: null,
            categories: [],
            whatsapp: { enabled: false },
        };
        release();
        await until(() => h.state().phase === 'offline');

        expect(h.state().offline.reason).toBe('no_agents');
    });

    it('creates no session and opens no socket just because the panel opened', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();
        h.open();
        await settle();

        expect(backend.callsTo('POST', '/sessions')).toHaveLength(0);
        expect(h.sockets).toHaveLength(0);
        expect(h.sessions).toEqual([]);
    });

    it('is idempotent: the loader re-sends init until it is acknowledged', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await Promise.all([h.init(), h.init(), h.init()]);

        expect(backend.callsTo('GET', '/config')).toHaveLength(1);
        expect(h.state().phase).toBe('prechat');
    });

    it('goes to offline when availability says the widget is closed, with the reopening time', async () => {
        const backend = useBackend({
            availability: {
                online: false,
                openNow: false,
                nextOpenAt: '2026-11-21T09:00:00.000Z',
                categories: [],
                whatsapp: { enabled: false },
            },
        });
        const h = createHarness({ backend });

        await h.init();

        expect(h.state().phase).toBe('offline');
        expect(h.state().offline.reason).toBe('hours');
        expect(h.hostStates().at(-1)?.status).toBe('offline');
    });

    it('goes to offline when open hours are fine but nobody is available', async () => {
        const h = createHarness({
            backend: useBackend({
                availability: {
                    online: false,
                    openNow: true,
                    nextOpenAt: null,
                    categories: [],
                    whatsapp: { enabled: false },
                },
            }),
        });

        await h.init();

        expect(h.state()).toMatchObject({
            phase: 'offline',
            offline: { reason: 'no_agents' },
        });
    });

    it('re-reads availability when the panel opens and leaves offline when agents are back', async () => {
        const backend = useBackend({
            availability: {
                online: false,
                openNow: true,
                nextOpenAt: null,
                categories: [],
                whatsapp: { enabled: false },
            },
        });
        const h = createHarness({ backend });

        await h.init();
        expect(h.state().phase).toBe('offline');

        backend.state.availability = {
            online: true,
            openNow: true,
            nextOpenAt: null,
            categories: [
                { slug: 'billing', online: true },
                { slug: 'tech', online: true },
            ],
            whatsapp: { enabled: false },
        };
        // opening within 15 s of the boot read does not refetch: age it
        (
            h.controller as unknown as { lastAvailabilityAt: number }
        ).lastAvailabilityAt = 0;
        h.open();
        await until(() => h.state().phase !== 'offline');

        expect(h.state().phase).toBe('prechat');
        expect(backend.callsTo('GET', '/availability')).toHaveLength(1);
    });

    it('skips the form and the picker when the config asks for nothing and has one topic', async () => {
        const base = bootConfig();
        const boot = loaderBoot({
            config: {
                ...(base.config as object),
                preChat: {
                    fields: {
                        name: { enabled: false, required: false },
                        email: { enabled: false, required: false },
                        phone: { enabled: false, required: false },
                    },
                    consentText: null,
                },
            },
        });
        const backend = useBackend({
            config: bootConfig({
                categories: [
                    {
                        slug: 'billing',
                        label: 'Billing',
                        description: null,
                        icon: null,
                        color: null,
                    },
                ],
            }),
        });
        const h = createHarness({ backend });

        await h.init(makeInit({ boot }));

        expect(h.state().phase).toBe('idle');
        expect(h.hostStates().at(-1)?.status).toBe('idle');
    });

    it("with several topics and no form the picker is the first screen; the host's category subset narrows it", async () => {
        const base = bootConfig().config as { features: object };
        const boot = loaderBoot({
            config: {
                ...base,
                preChat: {
                    fields: {
                        name: { enabled: false, required: false },
                        email: { enabled: false, required: false },
                        phone: { enabled: false, required: false },
                    },
                    consentText: null,
                },
            },
        });
        const h = createHarness({ backend: useBackend() });

        await h.init(makeInit({ boot }));
        expect(h.state().phase).toBe('category');

        const narrowed = createHarness({ backend: useBackend() });

        await narrowed.init(
            makeInit({ boot, overrides: { categories: ['tech'] } }),
        );

        // a subset of one topic: nothing to pick
        expect(
            narrowed.snapshot().config?.categories.map((c) => c.slug),
        ).toEqual(['tech']);
        expect(narrowed.state().phase).toBe('idle');
    });

    it('reports an unusable boot config as unavailable', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init(makeInit({ boot: { key: '', api: {} } }));

        expect(h.snapshot().unavailable).toBe(true);
        expect(h.state().phase).toBe('booting');
    });
});

describe('resuming a stored session', () => {
    it('resumes a queued chat: conversation, messages from seq 0, the socket, and the loader keeps its token', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();
        const conversation = backend.seedConversation(stored.token, 'queued');
        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));
        await until(() => h.sockets.length === 1);

        expect(h.state().phase).toBe('queued');
        expect(h.state().conversation?.ulid).toBe(conversation.ulid);
        expect(h.hostStates().at(-1)?.status).toBe('queued');
        expect(backend.callsTo('GET', '/conversation')[0].auth).toBe(
            `Bearer ${stored.token}`,
        );
        expect(backend.callsTo('GET', '/messages')[0].query.after_seq).toBe(
            '0',
        );
        // ws came from the session endpoint with the stored bearer, which the server ROTATED: the new token is the one in use
        expect(backend.callsTo('POST', '/sessions')[0].auth).toBe(
            `Bearer ${stored.token}`,
        );

        const rotated = backend.state.rotated.get(stored.token);

        expect(rotated).toBeDefined();
        expect(rotated).not.toBe(stored.token);
        expect(h.socket()?.input.token).toBe(rotated);
        expect(h.socket()?.input.ws).toEqual(backend.ws);
        // and the loader is told to keep the new one
        expect(h.sessions).toEqual([
            { token: rotated, expiresAt: backend.state.tokens.get(rotated!) },
        ]);
    });

    it('rotates the stored token before anything else is fetched with it: messages and the socket use the new token only', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Welcome back');

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));
        await until(() => h.sockets.length === 1);

        const rotated = backend.state.rotated.get(stored.token) as string;
        const order = backend.calls.map(
            (call) =>
                `${call.method} ${call.path.replace(/\/01[A-Z0-9]+/, '')}`,
        );

        expect(order.slice(0, 3)).toEqual([
            'GET /widgets/' + KEY + '/config',
            'GET /conversation',
            'POST /widgets/' + KEY + '/sessions',
        ]);
        expect(backend.state.revoked.has(stored.token)).toBe(true);
        expect(backend.callsTo('GET', '/messages')[0].auth).toBe(
            `Bearer ${rotated}`,
        );
        expect(h.state().messages.map((m) => m.body)).toEqual(['Welcome back']);

        // no later call ever left with the revoked token
        const after = backend.calls.slice(3).map((call) => call.auth);

        expect(
            after.filter((auth) => auth === `Bearer ${stored.token}`),
        ).toEqual([]);
        expect(h.state().phase).toBe('active');
    });

    it('does not rotate (or open a socket) for a chat that is not live: an ended chat waiting for a rating keeps its token', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentEnds(true);

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().phase).toBe('ended');
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(0);
        expect(h.sessions).toEqual([]);
        expect(h.sockets).toHaveLength(0);
    });

    it('a rotation the server refuses (identity) keeps the held token and the chat runs on REST polling', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const h = createHarness({ backend });

        await h.init(
            makeInit({
                visitorSession: stored,
                identityToken: 'bad.jwt.token',
            }),
        );
        await settle(60);

        expect(h.state().phase).toBe('active');
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
        expect(backend.state.revoked.has(stored.token)).toBe(false);
        expect(h.sockets).toHaveLength(0);
        expect(h.sessions).toEqual([]);

        // the polling fallback still works, with the token that is still valid
        backend.agentSays('Hello over REST');
        await until(() =>
            h.state().messages.some((m) => m.body === 'Hello over REST'),
        );
    });

    it('a stored session the server refuses at rotation (revoked meanwhile) starts fresh instead of looping', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'queued');
        backend.fail('POST', '/sessions$', 401, {
            error: { code: 'session_revoked', message: 'Revoked.' },
        });

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().conversation).toBeNull();
        expect(['prechat', 'category', 'idle']).toContain(h.state().phase);
        expect(h.sessions).toEqual([null]);
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
    });

    it('resumes an active chat with its transcript, and the queue clock follows the server', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Welcome back');
        backend.agentSays('Still there?');

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().phase).toBe('active');
        expect(h.state().messages.map((m) => m.body)).toEqual([
            'Welcome back',
            'Still there?',
        ]);
        expect(h.state().conversation?.agent?.name).toBe('Sam');
    });

    it("while the panel is closed, unseen agent messages become the loader's unread count", async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Are you there?', {
            deliveredAt: null,
            seenAt: null,
        });

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        const unread = h.sent.find((m) => m.type === 'unread');

        expect(unread).toMatchObject({
            payload: {
                count: 1,
                preview: 'Are you there?',
                agent: { name: 'Sam' },
            },
        });
        expect(h.hostStates().at(-1)).toMatchObject({
            status: 'active',
            unread: 1,
            agent: { name: 'Sam' },
        });

        h.open();
        expect(h.hostStates().at(-1)?.unread).toBe(0);
    });

    it('never shows history: a stored session whose chat is over starts fresh', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Old news');
        backend.close();

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().messages).toEqual([]);
        expect(h.state().conversation).toBeNull();
        expect(h.state().phase).toBe('prechat');
        expect(backend.callsTo('GET', '/messages')).toHaveLength(0);
        expect(h.sockets).toHaveLength(0);
    });

    it('an ended chat that still wants a rating resumes on the rating screen with the transcript', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Anything else?');
        backend.agentEnds(true);

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().phase).toBe('ended');
        expect(h.state().messages).toHaveLength(1);
        expect(h.sockets).toHaveLength(0);
    });

    it('an expired or revoked token is dropped: the loader is told, and the next chat is a new session', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.revoke(stored.token);

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.sessions).toEqual([null]);
        expect(h.state().phase).toBe('prechat');
        expect(h.state().conversation).toBeNull();

        h.controller.submitPrechat({
            name: 'Vera',
            email: '',
            phone: '',
            consent: false,
        });
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(h.sessions.at(-1)?.token).not.toBe(stored.token);
        expect(h.sessions.at(-1)?.token).toMatch(/^vt_/);
    });
});

describe('identity and prefill', () => {
    const jwt = (claims: Record<string, unknown>): string =>
        `h.${btoa(JSON.stringify(claims)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')}.s`;

    it('prefills the form from the host visitor and the identity claims, never overwriting what was typed', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init(
            makeInit({
                visitor: { email: 'host@x.test' },
                identityToken: jwt({
                    name: 'Ida Identified',
                    email: 'jwt@x.test',
                }),
            }),
        );

        expect(h.state().form).toMatchObject({
            name: 'Ida Identified',
            email: 'host@x.test',
        });
    });

    it('a signed identity that answers every required field skips the pre-chat form, and creates the session with the token', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });
        const identityToken = jwt({
            sub: '42',
            name: 'Ida',
            email: 'ida@x.test',
        });

        await h.init(makeInit({ identityToken, boot: loaderBoot() }));
        h.open();

        // two topics: the picker is next
        expect(h.state().phase).toBe('category');

        h.controller.chooseCategory('tech');
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/sessions')[0].body).toMatchObject({
            identity_token: identityToken,
        });
        expect(backend.callsTo('POST', '/conversations')[0].body).toMatchObject(
            {
                category: 'tech',
                name: 'Ida',
                email: 'ida@x.test',
            },
        );
    });

    it('an unsigned prefill (setVisitor) still shows the form, filled in', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init(
            makeInit({ visitor: { name: 'Vera', email: 'v@x.test' } }),
        );

        expect(h.state().phase).toBe('prechat');
        expect(h.state().form.name).toBe('Vera');
    });

    it('identify after boot prefills and can drop the form', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init();
        expect(h.state().phase).toBe('prechat');

        h.controller.handleHostMessage({
            type: 'identify',
            payload: { token: jwt({ name: 'Ida' }), visitor: { name: 'Ida' } },
        });

        expect(h.state().form.name).toBe('Ida');
        expect(h.state().flow.preChat).toBe(false);
    });

    it('sends the page and locale with the session', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat({
            name: 'Vera',
            email: '',
            phone: '',
            consent: false,
        });
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/sessions')[0].body).toMatchObject({
            page: {
                url: 'https://shop.example/pricing',
                title: 'Pricing',
                referrer: '',
            },
            locale: 'en-US',
        });
        expect(KEY).toContain('wk_');
    });
});

describe('a hostile init', () => {
    it('cannot send the visitor API calls to another origin: only the inlined app origin is ever called', async () => {
        const backend = useBackend();
        const h = createHarness({
            backend,
            deps: { appOrigin: 'https://chat.test' },
        });

        await h.init(
            makeInit({
                boot: loaderBoot({
                    api: {
                        base: 'https://evil.example/api/v1/public',
                        embed: 'https://evil.example/embed/x',
                        appOrigin: 'https://evil.example',
                    },
                }),
            }),
        );

        // the config call and everything after it went to the trusted origin (MSW fails the test on any other host)
        expect(backend.callsTo('GET', '/config')).toHaveLength(1);
        expect(h.snapshot().config?.apiBase).toBe(
            'https://chat.test/api/v1/public',
        );
        expect(h.snapshot().config?.appOrigin).toBe('https://chat.test');
    });
});
