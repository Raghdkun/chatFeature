import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { API, bootConfig } from '@/tests/msw/chat-visitor';
import { server, useBackend } from '@/tests/msw/server';
import { createHarness, makeInit, settle, until } from '@/tests/embed-harness';

type Boot = ReturnType<typeof bootConfig>;

/** A boot config for a widget that offers WhatsApp (the feature AND a connected session: `availability.whatsapp.enabled`). */
function whatsappBoot(
    options: {
        categories?: number;
        preChat?: boolean;
        online?: boolean;
        offered?: boolean;
    } = {},
): Boot {
    const base = bootConfig();
    const config = base.config as {
        features: Record<string, unknown>;
        preChat: unknown;
    };
    const categories = base.categories.slice(0, options.categories ?? 2);
    const offered = options.offered ?? true;

    return bootConfig({
        config: {
            ...config,
            features: {
                ...config.features,
                whatsapp: offered,
                preChat: options.preChat ?? false,
            },
        },
        categories,
        availability: {
            ...base.availability,
            online: options.online ?? true,
            openNow: options.online ?? true,
            categories: categories.map((c) => ({
                slug: c.slug,
                online: options.online ?? true,
            })),
            whatsapp: { enabled: offered },
        },
    });
}

function setup(boot: Boot = whatsappBoot()) {
    const backend = useBackend({
        config: boot,
        availability: boot.availability as Record<string, unknown>,
    });
    const h = createHarness({ backend });

    return { backend, h, boot };
}

const handoffs = (backend: ReturnType<typeof setup>['backend']) =>
    backend.callsTo('POST', '/whatsapp-handoff');

describe('the channel choice', () => {
    it('opens on the idle screen even with a pre-chat form and several topics', async () => {
        const { h, boot } = setup(whatsappBoot({ preChat: true }));

        await h.init(makeInit({ boot }));

        expect(h.state().phase).toBe('idle');
        expect(h.snapshot().config?.features.whatsapp).toBe(true);
        expect(h.state().flow.whatsapp).toBe(true);
    });

    it('is not offered when the feature is on but no session is connected (availability says no)', async () => {
        const base = whatsappBoot();
        const boot = bootConfig({
            ...base,
            availability: {
                ...base.availability,
                whatsapp: { enabled: false },
            },
        });
        const { h } = setup(boot);

        await h.init(makeInit({ boot }));

        expect(h.snapshot().config?.features.whatsapp).toBe(false);
        // The old first step: the topic picker (two topics, no form).
        expect(h.state().phase).toBe('category');
    });

    it('"Chat here" is the old start', async () => {
        const { h, boot } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.controller.start();
        await until(() => h.state().phase === 'queued');

        expect(h.backend.callsTo('POST', '/conversations')).toHaveLength(1);
        expect(handoffs(h.backend)).toHaveLength(0);
    });
});

describe('Continue on WhatsApp', () => {
    it('with one topic asks for the code at once, with that topic and nothing about the visitor', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.open();
        h.controller.startWhatsApp();

        expect(h.state().busy).toBe('whatsapp');
        await until(() => h.state().phase === 'whatsapp');

        expect(handoffs(backend)).toHaveLength(1);
        expect(handoffs(backend)[0].body).toEqual({ category: 'billing' });
        expect(handoffs(backend)[0].auth).toMatch(/^Bearer vt_/);
        expect(h.state().whatsapp.handoff).toMatchObject({
            code: 'K7M2Q001',
            waUrl: expect.stringMatching(
                /^https:\/\/wa\.me\/491701234567\?text=/,
            ),
        });
        // A hand-off is not a chat: no conversation, no realtime connection, no chat events.
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
        expect(h.sockets).toHaveLength(0);
        expect(h.events()).toEqual([]);
        // The launcher sees an idle panel.
        expect(h.hostStates().at(-1)).toEqual({
            status: 'idle',
            open: true,
            unread: 0,
        });
    });

    it('skips the pre-chat form: the visitor gives their name to WhatsApp, not to us', async () => {
        const { h, boot, backend } = setup(
            whatsappBoot({ categories: 1, preChat: true }),
        );

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');

        expect(h.state().form).toEqual({
            name: '',
            email: '',
            phone: '',
            consent: false,
        });
        expect(handoffs(backend)[0].body).toEqual({ category: 'billing' });
    });

    it('with several topics asks which one first (no request yet), then asks for the code', async () => {
        const { h, boot, backend } = setup();

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();

        expect(h.state().phase).toBe('category');
        expect(h.state().channel).toBe('whatsapp');
        expect(handoffs(backend)).toHaveLength(0);

        h.controller.chooseCategory('tech');
        await until(() => h.state().phase === 'whatsapp');

        expect(handoffs(backend)[0].body).toEqual({ category: 'tech' });
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });

    it('does not mark a topic offline for WhatsApp: no agent has to be there', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ online: true }));

        backend.state.availability = {
            ...(boot.availability as Record<string, unknown>),
            categories: [
                { slug: 'billing', online: false },
                { slug: 'tech', online: false },
            ],
        };

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'whatsapp');

        // The offline form is for chats; the hand-off went through.
        expect(h.state().offline.ticket).toBeNull();
        expect(handoffs(backend)).toHaveLength(1);
    });

    it('works from the offline screen: nobody to talk to is exactly when WhatsApp helps', async () => {
        const { h, boot, backend } = setup(
            whatsappBoot({ categories: 1, online: false }),
        );

        await h.init(makeInit({ boot }));

        expect(h.state().phase).toBe('offline');

        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');

        expect(handoffs(backend)).toHaveLength(1);
    });

    it('asks again for a topic the server refused', async () => {
        const { h, boot, backend } = setup();

        backend.fail(
            'POST',
            /whatsapp-handoff$/,
            422,
            {
                error: {
                    code: 'validation_failed',
                    message: 'Invalid.',
                    details: { category: ['The selected topic is invalid.'] },
                },
            },
            1,
        );
        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        h.controller.chooseCategory('tech');
        await until(() => h.state().busy === null);

        expect(h.state().phase).toBe('category');
        expect(h.state().fieldErrors.category).toBe(
            'The selected topic is invalid.',
        );
    });
});

describe('when the hand-off cannot be had', () => {
    it.each([
        [
            409,
            { error: { code: 'whatsapp_unavailable', message: 'No session.' } },
            { code: 'whatsapp_unavailable' },
        ],
        [
            409,
            { error: { code: 'something_else', message: 'Conflict.' } },
            { code: 'whatsapp_unavailable' },
        ],
        [
            403,
            { error: { code: 'feature_disabled', message: 'Off.' } },
            { code: 'feature_disabled' },
        ],
        [
            404,
            { error: { code: 'widget_not_found', message: 'Gone.' } },
            { code: 'unavailable' },
        ],
        [500, undefined, { code: 'generic' }],
    ])(
        'answers %i with a message that tells the visitor what to do',
        async (status, body, notice) => {
            const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

            backend.fail('POST', /whatsapp-handoff$/, status, body, 1);
            await h.init(makeInit({ boot }));
            h.controller.startWhatsApp();
            await until(() => h.state().busy === null);

            expect(h.state().phase).toBe('idle');
            expect(h.state().notice).toEqual(notice);
            expect(h.state().whatsapp.handoff).toBeNull();
        },
    );

    it('says how long to wait when the limiter answers 429', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

        backend.fail(
            'POST',
            /whatsapp-handoff$/,
            429,
            { error: { code: 'rate_limited', message: 'Slow down.' } },
            1,
            { 'Retry-After': '12' },
        );
        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().busy === null);

        expect(h.state().notice).toEqual({ code: 'rate_limited', seconds: 12 });
    });

    it('says the network is down, and lets the visitor try again', async () => {
        const { h, boot } = setup(whatsappBoot({ categories: 1 }));

        server.use(
            http.post(`${API}/widgets/:key/whatsapp-handoff`, () =>
                HttpResponse.error(),
            ),
        );
        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().busy === null);

        expect(h.state().phase).toBe('idle');
        expect(h.state().notice).toEqual({ code: 'network' });

        server.resetHandlers(...h.backend.handlers);
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');
    });

    it('starts a new session when the stored one is gone, and asks again', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));
        const stale = backend.issueToken();

        backend.state.revoked.add(stale.token);
        await h.init(makeInit({ boot, visitorSession: stale }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');

        expect(handoffs(backend).length).toBeGreaterThanOrEqual(1);
        expect(h.state().whatsapp.handoff?.code).toBe('K7M2Q001');
    });
});

describe('on the hand-off screen', () => {
    it('gives the same code again for the same topic (the server keeps one live ticket per visitor and topic)', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');

        const first = h.state().whatsapp.handoff?.code;

        h.controller.newWhatsAppCode();
        await until(() => h.state().busy === null);

        expect(h.state().whatsapp.handoff?.code).toBe(first);
        expect(handoffs(backend)).toHaveLength(2);
    });

    it('gets a new code once the old one ran out', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

        backend.state.handoffTtlMs = 15;
        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');
        await settle(40);

        h.controller.newWhatsAppCode();
        expect(h.state().busy).toBe('whatsapp');
        // The screen stays: the visitor keeps looking at the old code until the new one arrives.
        expect(h.state().phase).toBe('whatsapp');
        await until(() => h.state().busy === null);

        expect(h.state().whatsapp.handoff?.code).toBe('K7M2Q002');
    });

    it('keeps the old code and says why when a new one cannot be had', async () => {
        const { h, boot, backend } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');
        backend.fail('POST', /whatsapp-handoff$/, 409, undefined, 1);
        h.controller.newWhatsAppCode();
        await until(() => h.state().busy === null);

        expect(h.state().phase).toBe('whatsapp');
        expect(h.state().whatsapp.handoff?.code).toBe('K7M2Q001');
        expect(h.state().notice).toEqual({ code: 'whatsapp_unavailable' });
    });

    it('"I sent it" closes the panel state with the friendly reason, and a new chat starts clean', async () => {
        const { h, boot } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');
        h.controller.whatsAppSent();

        expect(h.state().phase).toBe('closed');
        expect(h.state().closedReason).toBe('whatsapp');
        expect(h.state().whatsapp.handoff).toBeNull();

        h.controller.newChat();
        await settle();

        expect(h.state().phase).toBe('idle');
        expect(h.state().channel).toBe('chat');
        expect(h.state().closedReason).toBeNull();
    });

    it('goes back to the channel choice', async () => {
        const { h, boot } = setup(whatsappBoot({ categories: 1 }));

        await h.init(makeInit({ boot }));
        h.controller.startWhatsApp();
        await until(() => h.state().phase === 'whatsapp');
        h.controller.back();

        expect(h.state().phase).toBe('idle');
        expect(h.state().whatsapp.handoff).toBeNull();
    });
});
