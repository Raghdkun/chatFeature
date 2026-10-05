import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vite-plus/test';
import { makeAgentMessage, makeMessage } from '@/lib/chat/fixtures';
import { bootConfig } from '@/tests/msw/chat-visitor';
import { server, useBackend } from '@/tests/msw/server';
import {
    createHarness,
    loaderBoot,
    makeInit,
    settle,
    until,
    type Harness,
} from '@/tests/embed-harness';

const FORM = { name: 'Vera', email: 'vera@x.test', phone: '', consent: false };

/** Boot, fill the form, pick a topic: the panel is `queued` and the socket is open. */
async function queue(h: Harness, topic = 'billing'): Promise<void> {
    await h.init();
    h.open();
    h.controller.submitPrechat(FORM);
    h.controller.chooseCategory(topic);
    await until(() => h.state().phase === 'queued');
    await until(() => h.socket()?.status() === 'connected');
}

async function activate(h: Harness, agent = 'Sam'): Promise<void> {
    await queue(h);
    h.backend.claim(agent);
    h.socket()?.emit('chat.claimed', {
        v: 1,
        agent: { name: agent, avatarUrl: null },
        claimedAt: 'x',
    });
    await until(() => h.state().phase === 'active');
    await until(() => h.state().messages.length > 0);
}

describe('starting a chat', () => {
    it('creates the session just before the first write, persists it for the loader, and sends the form', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();
        h.open();
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(0);

        h.controller.submitPrechat(FORM);
        expect(h.state().phase).toBe('category');
        expect(h.state().busy).toBeNull();

        h.controller.chooseCategory('billing');
        expect(h.state().busy).toBe('starting');
        await until(() => h.state().phase === 'queued');

        expect(h.sessions).toHaveLength(1);
        expect(h.sessions[0]).toMatchObject({
            token: expect.stringMatching(/^vt_/),
        });
        expect(backend.callsTo('POST', '/conversations')[0]).toMatchObject({
            auth: `Bearer ${h.sessions[0]?.token}`,
            body: { category: 'billing', name: 'Vera', email: 'vera@x.test' },
        });
        expect(h.events()).toContain('chat-started');
        expect(h.hostStates().at(-1)).toEqual({
            status: 'queued',
            open: true,
            unread: 0,
        });
    });

    it('opens the websocket only now, authorised with the visitor token for this conversation', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        expect(h.sockets).toHaveLength(0);

        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await until(() => h.sockets.length === 1);

        const input = h.socket()?.input;

        expect(input).toMatchObject({
            ws: backend.ws,
            token: h.sessions[0]?.token,
            conversation: h.state().conversation?.ulid,
            authEndpoint: 'https://chat.test/api/v1/public/broadcasting/auth',
        });
        // the session response already carried the ws block: no second session call
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
    });

    it('a single topic and no form: "Start chat" creates the chat directly', async () => {
        const base = bootConfig().config as object;
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
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);

        h.controller.start();
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')[0].body).toEqual({
            category: 'billing',
        });
    });

    it('consent text adds the consent flag to the request', async () => {
        const base = bootConfig().config as { preChat: object };
        const boot = loaderBoot({
            config: {
                ...base,
                preChat: {
                    ...base.preChat,
                    consentText: 'I agree to the privacy policy',
                },
            },
        });
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init(makeInit({ boot }));
        h.controller.submitPrechat({ ...FORM, consent: true });
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')[0].body).toMatchObject(
            { consent: true },
        );
    });

    it('startChat from the host honours the form: category preset skips the picker, the message travels with the request', async () => {
        const base = bootConfig().config as object;
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
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init(makeInit({ boot }));
        expect(h.state().phase).toBe('category');

        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'tech', message: 'Where is my invoice?' },
        });
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')[0].body).toEqual({
            category: 'tech',
            message: 'Where is my invoice?',
        });
    });

    it('startChat with a form lands on the form first, with the category remembered', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init();
        h.controller.handleHostMessage({
            type: 'startChat',
            payload: { category: 'tech', message: 'Hi there' },
        });

        expect(h.state().phase).toBe('prechat');
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);

        h.controller.submitPrechat(FORM);
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')[0].body).toMatchObject(
            {
                category: 'tech',
                message: 'Hi there',
            },
        );
    });

    it('setCategory pre-selects a topic and ignores unknown ones', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init();
        h.controller.handleHostMessage({
            type: 'setCategory',
            payload: { slug: 'nope' },
        });
        expect(h.state().category).toBeNull();

        h.controller.handleHostMessage({
            type: 'setCategory',
            payload: { slug: 'billing' },
        });
        h.controller.submitPrechat(FORM);

        // the picker is skipped: the chat starts straight away
        expect(h.state().busy).toBe('starting');
        await until(() => h.state().phase === 'queued');
    });

    it('server field errors send the visitor back to the form with the messages', async () => {
        const backend = useBackend({ requireEmail: true });
        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat({ ...FORM, email: '' });
        h.controller.chooseCategory('billing');
        await until(() => h.state().busy === null);

        expect(h.state().phase).toBe('prechat');
        expect(h.state().fieldErrors.email).toBe(
            'The email field is required.',
        );
    });

    it('409 no_agents leads to the offline form', async () => {
        const h = createHarness({ backend: useBackend({ noAgents: true }) });

        await h.init();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'offline');

        expect(h.state().offline.reason).toBe('no_agents');
        expect(h.sockets).toHaveLength(0);
    });

    it('409 conversation_exists continues the chat the session already has', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();
        const open = backend.seedConversation(stored.token, 'queued');
        // the loader's token was not handed over (a second tab): the panel creates a session... then collides
        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat(FORM);
        // simulate the tab holding the same token
        (h.controller as unknown as { token: string }).token = stored.token;
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(h.state().conversation?.ulid).toBe(open.ulid);
    });

    it('a rate limit on the start keeps the screen and says how long to wait', async () => {
        const backend = useBackend();

        backend.fail(
            'POST',
            '/conversations$',
            429,
            { error: { code: 'rate_limited', message: 'x' } },
            1,
            { 'Retry-After': '9' },
        );

        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().busy === null);

        expect(h.state().phase).toBe('category');
        expect(h.state().notice).toEqual({ code: 'rate_limited', seconds: 9 });
    });

    it('a network failure on the start keeps the screen with a retryable notice', async () => {
        const backend = useBackend();

        backend.fail('POST', '/sessions$', 500, undefined, 1);

        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().busy === null);

        expect(h.state().notice).toEqual({ code: 'generic' });

        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
    });

    it('a signed identity the server refuses (422 identity_token) shows one clear notice and is not retried', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await h.init(makeInit({ identityToken: 'bad.jwt.token' }));
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().notice !== null);

        expect(h.state().notice).toEqual({ code: 'identity' });
        expect(h.state().phase).not.toBe('queued');
        expect(h.state().fieldErrors).toEqual({});
        await settle(60);
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });

    it('a 429 with Retry-After on the session is not retried behind the visitor back: the notice says how long to wait', async () => {
        const backend = useBackend();

        backend.fail(
            'POST',
            '/sessions$',
            429,
            { error: { code: 'rate_limited', message: 'Slow down.' } },
            1,
            { 'Retry-After': '12' },
        );

        const h = createHarness({ backend });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().notice !== null);

        expect(h.state().notice).toEqual({ code: 'rate_limited', seconds: 12 });
        expect(backend.callsTo('POST', '/sessions')).toHaveLength(1);
    });

    it('an expired token mid-start gets a fresh session and the start is retried once', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();
        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));
        backend.revoke(stored.token);
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(h.sessions.at(-1)?.token).not.toBe(stored.token);
    });
});

describe('queued', () => {
    it('becomes active when an agent claims: header agent, host state, agent-joined, system message loaded', async () => {
        const h = createHarness({ backend: useBackend() });

        await queue(h);
        h.backend.claim('Sam');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');
        await until(() => h.state().messages.length === 1);

        expect(h.state().conversation?.agent?.name).toBe('Sam');
        expect(h.hostStates().at(-1)).toEqual({
            status: 'active',
            open: true,
            unread: 0,
            agent: { name: 'Sam' },
        });
        expect(h.events()).toContain('agent-joined');
        expect(h.state().messages[0].body).toBe('Sam joined the chat.');
    });

    it('notices a claim that happened while the socket was away (watchdog poll)', async () => {
        const h = createHarness({ backend: useBackend(), pollMs: 15 });

        await queue(h);
        h.backend.claim('Kim');
        await until(() => h.state().phase === 'active');

        expect(h.state().conversation?.agent?.name).toBe('Kim');
    });

    it('a missed queue becomes the offline form, and the ticket records the missed chat', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 15 });

        await queue(h);

        const missed = h.state().conversation?.ulid;

        backend.miss();
        await until(() => h.state().phase === 'offline');

        expect(h.state().offline).toMatchObject({ reason: 'missed', missed });
        expect(h.sockets.at(-1)?.closed).toBe(true);

        await h.controller.submitOffline({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Call me',
            category: 'billing',
        });

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'ticket',
        });
        expect(backend.callsTo('POST', '/offline-tickets')[0].body).toEqual({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Call me',
            category: 'billing',
            missed_conversation: missed,
        });
        expect(h.state().offline.ticket?.type).toBe('offline');
    });

    it('cancel closes the chat through POST .../cancel (ending a queued chat is a 409)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await queue(h);
        await h.controller.cancelQueued();

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'cancelled',
        });
        expect(backend.callsTo('POST', '/cancel')).toHaveLength(1);
        expect(backend.callsTo('POST', '/end')).toHaveLength(0);
        expect(h.sockets.at(-1)?.closed).toBe(true);
        expect(h.events()).toContain('chat-ended');
    });

    it('a sync that lands while the visitor\'s own cancel is still on its way does not turn it into a missed queue (no offline form after "Cancel")', async () => {
        const backend = useBackend();
        const { createVisitorApi } = await import('@/lib/chat-api/visitor');
        let release: () => void = () => undefined;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const h = createHarness({
            backend,
            deps: {
                createApi: (options) => {
                    const real = createVisitorApi(options);

                    return {
                        ...real,
                        // the server has cancelled; the answer reaches the panel late
                        cancelConversation: async (ulid) => {
                            const result = await real.cancelConversation(ulid);

                            await gate;

                            return result;
                        },
                    };
                },
            },
        });

        await queue(h);

        const cancelling = h.controller.cancelQueued();

        await until(() => backend.callsTo('POST', '/cancel').length === 1);
        await h.controller.syncConversation();

        expect(h.state().phase).toBe('queued');

        release();
        await cancelling;

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'cancelled',
        });
    });

    it("a poll that finds the chat closed while the visitor's own cancel is still in flight does not turn it into a missed queue", async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await queue(h);

        // The server has already processed the cancel, but its answer is slow ...
        server.use(
            http.post('*/conversations/:ulid/cancel', async () => {
                backend.state.conversation = {
                    ...(backend.state.conversation as object),
                    status: 'closed',
                } as typeof backend.state.conversation;
                await new Promise((resolve) => setTimeout(resolve, 80));

                return HttpResponse.json({ data: backend.state.conversation });
            }),
        );

        const cancel = h.controller.cancelQueued();

        // ... and the watchdog poll lands first: the chat is closed, which is what the visitor asked for, not "nobody came".
        await h.controller.syncConversation();
        expect(h.state().phase).toBe('queued');
        await cancel;

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'cancelled',
        });
    });

    it('cancel that loses the race to an agent (409 conversation_not_queued) shows the chat the server has', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await queue(h);
        backend.claim('Sam');
        await h.controller.cancelQueued();

        expect(backend.callsTo('POST', '/cancel')).toHaveLength(1);
        await until(() => h.state().phase === 'active');
        expect(h.state().conversation?.agent?.name).toBe('Sam');
    });

    it('a transfer sends an active chat back to the queue and the next claim resumes it', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        // the server re-queues the chat (and the watchdog poll must agree with the event)
        h.backend.state.conversation = {
            ...(h.backend.state.conversation as object),
            status: 'queued',
            agent: null,
        } as never;
        h.socket()?.emit('conversation.transferred', { v: 1 });
        expect(h.state()).toMatchObject({ phase: 'queued', transferred: true });
        expect(h.state().messages).toHaveLength(1);

        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Kim', avatarUrl: null },
            claimedAt: 'x',
        });
        expect(h.state()).toMatchObject({
            phase: 'active',
            transferred: false,
        });
        expect(h.state().conversation?.agent?.name).toBe('Kim');
        // still one connection for the whole chat
        expect(h.sockets).toHaveLength(1);
    });
});

describe('messages', () => {
    it('sends optimistically: sending -> sent, with a client_msg_id, trimmed text, and the message-sent event', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.send({ body: '  Hello there  ' });

        const pending = h.state().messages.at(-1);

        expect(pending).toMatchObject({
            body: 'Hello there',
            status: 'sending',
            seq: null,
            sender: { type: 'visitor', name: 'Vera' },
        });
        await until(() => h.state().messages.at(-1)?.status === 'sent');

        const request = backend.callsTo('POST', '/messages')[0].body as {
            client_msg_id: string;
            body: string;
        };

        expect(request.body).toBe('Hello there');
        expect(request.client_msg_id).toBe(pending?.clientMsgId);
        expect(
            h.state().messages.filter((m) => m.body === 'Hello there'),
        ).toHaveLength(1);
        expect(h.events()).toContain('message-sent');
    });

    it('ignores empty drafts and sends nothing outside an active chat', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await queue(h);
        h.controller.send({ body: 'too early' });
        expect(backend.callsTo('POST', '/messages')).toHaveLength(0);

        h.backend.claim();
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');
        h.controller.send({ body: '   ' });
        expect(backend.callsTo('POST', '/messages')).toHaveLength(0);
    });

    it('the broadcast of our own message does not duplicate it', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.send({ body: 'Echo' });
        await until(() => h.state().messages.at(-1)?.status === 'sent');

        const server = backend.state.messages.at(-1);

        h.socket()?.emit('message.created', { v: 1, message: server });
        expect(
            h.state().messages.filter((m) => m.body === 'Echo'),
        ).toHaveLength(1);
    });

    it('keeps typed order for quick sends (delivered one after the other)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.send({ body: 'one' });
        h.controller.send({ body: 'two' });
        h.controller.send({ body: 'three' });
        await until(
            () =>
                h
                    .state()
                    .messages.filter(
                        (m) =>
                            m.sender.type === 'visitor' && m.status === 'sent',
                    ).length === 3,
        );

        expect(
            backend.state.messages
                .filter((m) => m.sender.type === 'visitor')
                .map((m) => m.body),
        ).toEqual(['one', 'two', 'three']);
        expect(
            h
                .state()
                .messages.slice(-3)
                .map((m) => m.body),
        ).toEqual(['one', 'two', 'three']);
    });

    it('a failed send shows retry, and the retry reuses the client_msg_id (idempotent)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        backend.fail('POST', '/messages$', 500, undefined, 1);
        h.controller.send({ body: 'Will fail' });
        await until(() => h.state().messages.at(-1)?.status === 'failed');

        const clientMsgId = h.state().messages.at(-1)?.clientMsgId ?? '';

        h.controller.retry(clientMsgId);
        expect(h.state().messages.at(-1)?.status).toBe('sending');
        await until(() => h.state().messages.at(-1)?.status === 'sent');

        const posts = backend.callsTo('POST', '/messages');

        expect(posts).toHaveLength(2);
        expect((posts[1].body as { client_msg_id: string }).client_msg_id).toBe(
            clientMsgId,
        );
        expect(
            h.state().messages.filter((m) => m.body === 'Will fail'),
        ).toHaveLength(1);
    });

    it('a failed send can be discarded', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        backend.fail('POST', '/messages$', 500, undefined, 1);
        h.controller.send({ body: 'Nope' });
        await until(() => h.state().messages.at(-1)?.status === 'failed');
        h.controller.discard(h.state().messages.at(-1)?.clientMsgId ?? '');

        expect(h.state().messages.some((m) => m.body === 'Nope')).toBe(false);
    });

    it('409 conversation_not_active: the message fails and the chat is re-read (it ended)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        backend.agentEnds(true);
        h.controller.send({ body: 'Too late' });
        await until(() => h.state().phase === 'ended');

        expect(h.state().messages.at(-1)?.status).toBe('failed');
    });

    it('sends attachment ids with the message', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);

        const file = new File(['x'], 'photo.png', { type: 'image/png' });
        const attachment = await h.controller.uploadAttachment(file);

        expect(backend.callsTo('POST', '/attachments')).toHaveLength(1);

        h.controller.send({ body: '', attachments: [attachment] });
        await until(() => h.state().messages.at(-1)?.status === 'sent');

        expect(
            (
                backend.callsTo('POST', '/messages')[0].body as {
                    attachments: string[];
                }
            ).attachments,
        ).toEqual([attachment.ulid]);
        expect(h.state().messages.at(-1)?.attachments[0].ulid).toBe(
            attachment.ulid,
        );
    });

    it('agent messages arrive in order, with sound only while the panel is open and the widget has sounds on', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        const first = makeAgentMessage({
            conversation: h.state().conversation?.ulid,
            seq: 2,
            body: 'Hi Vera',
        });

        h.socket()?.emit('message.created', { v: 1, message: first });
        expect(h.state().messages.at(-1)?.body).toBe('Hi Vera');
        expect(h.pings).toHaveLength(1);
        expect(h.events()).toContain('message-received');

        h.close();
        h.socket()?.emit('message.created', {
            v: 1,
            message: makeAgentMessage({
                conversation: first.conversation,
                seq: 3,
                body: 'Hello?',
            }),
        });
        expect(h.pings).toHaveLength(1);
    });

    it('widget sounds off: no sound', async () => {
        const base = bootConfig().config as { features: object };
        const boot = loaderBoot({
            config: { ...base, features: { ...base.features, sounds: false } },
        });
        const h = createHarness({ backend: useBackend() });

        await h.init(makeInit({ boot }));
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        h.backend.claim();
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');
        h.socket()?.emit('message.created', {
            v: 1,
            message: makeAgentMessage({
                conversation: h.state().conversation?.ulid,
                seq: 5,
                body: 'Psst',
            }),
        });

        expect(h.pings).toHaveLength(0);
    });
});

describe('unread while the panel is closed', () => {
    it('counts unseen agent messages for the launcher (with preview and agent), and opening clears it', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        h.close();

        const message = makeAgentMessage({
            conversation: h.state().conversation?.ulid,
            seq: 2,
            body: 'Are you still there?',
        });

        h.socket()?.emit('message.created', { v: 1, message });

        const unread = h.sent.filter((m) => m.type === 'unread').at(-1);

        expect(unread).toMatchObject({
            payload: {
                count: 1,
                preview: 'Are you still there?',
                agent: { name: 'Sam' },
            },
        });
        expect(h.hostStates().at(-1)?.unread).toBe(1);

        h.open();
        expect(h.hostStates().at(-1)?.unread).toBe(0);
    });
});

describe('receipts', () => {
    it('reports delivered when messages arrive and seen once the visitor is looking at the end of the list', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        backend.agentSays('Please see this');
        h.socket()?.emit('message.created', {
            v: 1,
            message: backend.state.messages.at(-1),
        });

        await until(() => backend.state.receipts.length > 0);
        expect(backend.state.receipts[0]).toEqual({ delivered_upto: 2 });

        h.controller.setViewing(true);
        await until(() => backend.state.receipts.length > 1);
        expect(backend.state.receipts[1]).toEqual({ seen_upto: 2 });
        expect(h.state().messages.at(-1)).toMatchObject({ status: 'seen' });
    });

    it('while viewing, a new agent message is delivered and seen in one receipt', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.setViewing(true);
        await settle(400);
        backend.state.receipts.length = 0;

        backend.agentSays('Live one');
        h.socket()?.emit('message.created', {
            v: 1,
            message: backend.state.messages.at(-1),
        });
        await until(() => backend.state.receipts.length > 0);

        expect(backend.state.receipts.at(-1)).toEqual({
            delivered_upto: 2,
            seen_upto: 2,
        });
    });

    it("the agent's delivery receipt ticks our messages delivered live, then seen", async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.send({ body: 'Did you get this?' });
        await until(() => h.state().messages.at(-1)?.status === 'sent');
        const seq = h.state().messages.at(-1)?.seq ?? 0;

        h.socket()?.emit('message.delivered', {
            v: 1,
            upToSeq: seq,
            by: 'agent',
            at: '2026-11-20T10:04:00.000Z',
        });

        expect(h.state().messages.at(-1)).toMatchObject({
            status: 'delivered',
            deliveredAt: '2026-11-20T10:04:00.000Z',
            seenAt: null,
        });

        h.socket()?.emit('message.seen', {
            v: 1,
            upToSeq: seq,
            by: 'agent',
            at: '2026-11-20T10:05:00.000Z',
        });
        // a delivery receipt that arrives after the read one does not undo it
        h.socket()?.emit('message.delivered', {
            v: 1,
            upToSeq: seq,
            by: 'agent',
            at: '2026-11-20T10:06:00.000Z',
        });

        expect(h.state().messages.at(-1)).toMatchObject({
            status: 'seen',
            deliveredAt: '2026-11-20T10:04:00.000Z',
            seenAt: '2026-11-20T10:05:00.000Z',
        });
    });

    it("the agent's seen receipt marks our messages seen", async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.send({ body: 'Read me' });
        await until(() => h.state().messages.at(-1)?.status === 'sent');
        const seq = h.state().messages.at(-1)?.seq ?? 0;

        h.socket()?.emit('message.seen', {
            v: 1,
            upToSeq: seq,
            by: 'agent',
            at: '2026-11-20T10:05:00.000Z',
        });

        expect(h.state().messages.at(-1)).toMatchObject({
            status: 'seen',
            seenAt: '2026-11-20T10:05:00.000Z',
        });
    });
});

describe('ending', () => {
    it('end chat -> ended -> rating -> closed, with the loader events', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        await h.controller.endChat();

        expect(h.state().phase).toBe('ended');
        expect(h.state().messages.length).toBeGreaterThan(0);
        expect(h.hostStates().at(-1)?.status).toBe('ended');
        expect(h.sockets.at(-1)?.closed).toBe(true);

        await h.controller.rate(4, '  Lovely  ');

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'rated',
            messages: [],
        });
        expect(backend.state.ratings).toEqual([
            { score: 4, comment: 'Lovely' },
        ]);
        expect(h.events()).toEqual(
            expect.arrayContaining(['chat-ended', 'rating-submitted']),
        );
    });

    it('skipping the rating closes at once and tells the server (POST .../rating/skip), without sending a rating', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        await h.controller.endChat();
        h.controller.skipRating();

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'skipped',
        });
        await until(() => backend.callsTo('POST', '/rating/skip').length === 1);
        expect(backend.callsTo('POST', '/rating')).toHaveLength(0);
        expect(backend.state.conversation?.status).toBe('closed');
    });

    it('a skip the server cannot take (409 conversation_not_ended, 500, offline) still leaves the rating screen', async () => {
        for (const [status, code] of [
            [409, 'conversation_not_ended'],
            [500, 'server_error'],
        ] as const) {
            const backend = useBackend();
            const h = createHarness({ backend });

            await activate(h);
            await h.controller.endChat();
            backend.fail('POST', '/rating/skip$', status, {
                error: { code, message: 'x' },
            });
            h.controller.skipRating();

            expect(h.state()).toMatchObject({
                phase: 'closed',
                closedReason: 'skipped',
            });
            await until(
                () => backend.callsTo('POST', '/rating/skip').length === 1,
            );
            await settle(20);
            expect(h.state().phase).toBe('closed');
        }
    });

    it('skip does nothing outside the rating screen', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        h.controller.skipRating();

        expect(h.state().phase).toBe('active');
        expect(backend.callsTo('POST', '/rating/skip')).toHaveLength(0);
    });

    it('the agent ends the chat: rating screen with the transcript, no more socket', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        h.socket()?.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: true,
        });

        expect(h.state().phase).toBe('ended');
        expect(h.state().messages).toHaveLength(1);
        expect(h.sockets.at(-1)?.closed).toBe(true);
    });

    it('no rating requested, or ratings off: straight to the thank-you screen', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        h.socket()?.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: false,
        });

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'ended',
        });
    });

    it('closed by the server (idle) shows the closed screen', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        h.socket()?.emit('conversation.closed', { v: 1, reason: 'idle' });

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'idle',
        });
    });

    it('a failed end keeps the chat and says so; a rating of an already-closed chat closes it without a thank-you', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        backend.fail('POST', '/end$', 500, undefined, 1);
        await h.controller.endChat();
        expect(h.state()).toMatchObject({
            phase: 'active',
            busy: null,
            notice: { code: 'generic' },
        });

        await h.controller.endChat();
        expect(h.state().phase).toBe('ended');

        backend.fail(
            'POST',
            '/rating$',
            409,
            { error: { code: 'conversation_not_active', message: 'x' } },
            1,
        );
        await h.controller.rate(5, '');
        // Not "rated" or "skipped" (both say thanks): the rating was refused, nothing was stored.
        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'ended',
        });
    });

    it('Start a new chat: the old session is revoked and forgotten, and the next chat is a new ticket', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await activate(h);
        const first = h.sessions.at(-1)?.token;
        const firstConversation = h.state().conversation?.ulid;

        await h.controller.endChat();
        h.controller.skipRating();
        h.controller.newChat();

        expect(h.sessions.at(-1)).toBeNull();
        await until(() => backend.callsTo('DELETE', '/sessions').length === 1);
        expect(backend.state.revoked.has(first ?? '')).toBe(true);
        // form values stay, the old chat does not: with a form + two topics the visitor lands on the form
        expect(h.state()).toMatchObject({
            phase: 'prechat',
            messages: [],
            conversation: null,
        });
        expect(h.state().form.name).toBe('Vera');

        h.controller.submitPrechat(h.state().form);
        h.controller.chooseCategory('tech');
        await until(() => h.state().phase === 'queued');

        expect(h.sessions.at(-1)?.token).not.toBe(first);
        expect(h.state().conversation?.ulid).not.toBe(firstConversation);
    });

    it('Start a new chat with nothing to ask starts the chat at once', async () => {
        const base = bootConfig().config as object;
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
        h.controller.start();
        await until(() => h.state().phase === 'queued');
        await h.controller.cancelQueued();
        h.controller.newChat();
        await until(() => h.state().phase === 'queued');

        expect(backend.callsTo('POST', '/conversations')).toHaveLength(2);
        expect(makeMessage().seq).toBeGreaterThan(0);
    });
});

describe('offline form: refusals', () => {
    it('403 feature_disabled (the offline form is off server-side) says so and keeps the form', async () => {
        const backend = useBackend({ noAgents: true });
        const h = createHarness({ backend });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'offline');

        backend.fail('POST', '/offline-tickets$', 403, {
            error: { code: 'feature_disabled', message: 'Switched off.' },
        });
        await h.controller.submitOffline({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Call me',
            category: 'billing',
        });

        expect(h.state()).toMatchObject({
            phase: 'offline',
            busy: null,
            notice: { code: 'feature_disabled' },
        });
        expect(backend.state.tickets).toHaveLength(0);
    });
});

describe('offline form', () => {
    it('submits a ticket from the offline screen and shows the closed confirmation', async () => {
        const backend = useBackend({ noAgents: true });
        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'offline');
        await h.controller.submitOffline({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Please call',
            category: 'billing',
        });

        expect(h.state()).toMatchObject({
            phase: 'closed',
            closedReason: 'ticket',
        });
        expect(backend.callsTo('POST', '/offline-tickets')[0].body).toEqual({
            name: 'Vera',
            email: 'vera@x.test',
            message: 'Please call',
            category: 'billing',
        });
        expect(h.hostStates().at(-1)?.status).toBe('closed');
    });

    it('server validation errors stay on the form', async () => {
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
        await h.controller.submitOffline({
            name: '',
            email: '',
            message: '',
            category: '',
        });

        expect(h.state().phase).toBe('offline');
        expect(h.state().fieldErrors).toMatchObject({
            name: expect.any(String),
            email: expect.any(String),
        });
    });

    it('a category that is offline goes straight to the form with that topic', async () => {
        const backend = useBackend({
            availability: {
                online: true,
                openNow: true,
                nextOpenAt: null,
                categories: [
                    { slug: 'billing', online: false },
                    { slug: 'tech', online: true },
                ],
                whatsapp: { enabled: false },
            },
        });
        const h = createHarness({ backend });

        await h.init();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');

        expect(h.state()).toMatchObject({
            phase: 'offline',
            category: 'billing',
        });
        expect(backend.callsTo('POST', '/conversations')).toHaveLength(0);
    });
});

describe('shutdown, viewport and config updates', () => {
    it('shutdown closes the socket and resets to the first step without touching the stored session message', async () => {
        const h = createHarness({ backend: useBackend() });

        await activate(h);
        const sessionsBefore = h.sessions.length;

        h.controller.handleHostMessage({ type: 'shutdown' });

        expect(h.sockets.at(-1)?.closed).toBe(true);
        expect(h.state()).toMatchObject({
            phase: 'prechat',
            conversation: null,
            messages: [],
        });
        expect(h.sessions).toHaveLength(sessionsBefore);
    });

    it('stores the latest viewport for the keyboard inset', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init();
        h.controller.handleHostMessage({
            type: 'viewport',
            payload: { width: 375, height: 400, keyboardInset: 280 },
        });

        expect(h.snapshot().viewport).toEqual({
            width: 375,
            height: 400,
            keyboardInset: 280,
        });
    });

    it('update re-applies restricted overrides: texts and theme change, a closed feature stays closed', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init();
        h.controller.handleHostMessage({
            type: 'update',
            payload: {
                overrides: {
                    texts: { en: { title: 'Acme help' } },
                    theme: { primary: '#ff0000' },
                    features: { attachments: false },
                },
            },
        });

        const { config, t } = h.snapshot();

        expect(t('title')).toBe('Acme help');
        expect(config?.theme.primary).toBe('#ff0000');
        expect(config?.features.attachments).toBe(false);
    });
});
