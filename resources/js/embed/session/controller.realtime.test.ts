import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { makeAgentMessage } from '@/lib/chat/fixtures';
import { useBackend } from '@/tests/msw/server';
import { createHarness, until, type Harness } from '@/tests/embed-harness';

const FORM = { name: 'Vera', email: 'vera@x.test', phone: '', consent: false };

async function active(h: Harness): Promise<void> {
    await h.init();
    h.open();
    h.controller.submitPrechat(FORM);
    h.controller.chooseCategory('billing');
    await until(() => h.state().phase === 'queued');
    await until(() => h.socket()?.status() === 'connected');
    h.backend.claim('Sam');
    h.socket()?.emit('chat.claimed', {
        v: 1,
        agent: { name: 'Sam', avatarUrl: null },
        claimedAt: 'x',
    });
    await until(() => h.state().phase === 'active');
    await until(() => h.state().messages.length === 1);
}

describe('gap sync', () => {
    it('a message that skips a seq triggers GET messages?after_seq= and fills the hole in order', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await active(h);
        backend.agentSays('two');
        backend.agentSays('three');
        backend.agentSays('four');

        // the socket only delivered the last one
        h.socket()?.emit('message.created', {
            v: 1,
            message: backend.state.messages.at(-1),
        });
        await until(() => h.state().messages.length === 4);

        expect(h.state().messages.map((m) => m.seq)).toEqual([1, 2, 3, 4]);
        expect(h.state().messages.map((m) => m.body)).toEqual([
            'Sam joined the chat.',
            'two',
            'three',
            'four',
        ]);
        expect(
            backend.callsTo('GET', '/messages').at(-1)?.query.after_seq,
        ).toBe('1');
    });

    it('a duplicate or replayed event changes nothing and fetches nothing', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await active(h);
        backend.agentSays('two');

        const message = backend.state.messages.at(-1);

        h.socket()?.emit('message.created', { v: 1, message });
        const fetches = backend.callsTo('GET', '/messages').length;

        h.socket()?.emit('message.created', { v: 1, message });
        h.socket()?.emit('message.created', { v: 1, message });
        await new Promise((resolve) => setTimeout(resolve, 60));

        expect(h.state().messages).toHaveLength(2);
        expect(backend.callsTo('GET', '/messages')).toHaveLength(fetches);
    });

    it('a reconnect catches up on everything missed while the socket was away', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        h.socket()?.setStatus('disconnected');
        expect(h.state().connection).toBe('reconnecting');

        backend.agentSays('while you were away');
        backend.agentSays('and another');
        h.socket()?.setStatus('connected');
        await until(() => h.state().messages.length === 3);

        expect(h.state().connection).toBe('online');
        expect(h.state().messages.at(-1)?.body).toBe('and another');
    });

    it('a reconnect notices that the chat ended meanwhile', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        h.socket()?.setStatus('disconnected');
        backend.agentEnds(true);
        h.socket()?.setStatus('connected');
        await until(() => h.state().phase === 'ended');
    });
});

describe('REST polling fallback', () => {
    it('keeps the chat alive with the socket down: shows reconnecting and picks up messages by polling', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 20 });

        await active(h);
        h.socket()?.setStatus('reconnecting');
        expect(h.state().connection).toBe('reconnecting');

        backend.agentSays('delivered by polling');
        await until(() =>
            h.state().messages.some((m) => m.body === 'delivered by polling'),
        );

        expect(h.state().messages.at(-1)?.sender.type).toBe('agent');
    });

    it('works without any websocket at all (the libraries fail to load)', async () => {
        const backend = useBackend();
        const h = createHarness({
            backend,
            pollMs: 20,
            deps: {
                socketFactory: async () => {
                    throw new Error('blocked');
                },
            },
        });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        backend.claim('Sam');
        await until(() => h.state().phase === 'active');

        expect(h.state().connection).toBe('reconnecting');

        backend.agentSays('hello over REST');
        await until(() =>
            h.state().messages.some((m) => m.body === 'hello over REST'),
        );
    });
});

describe('without a realtime server', () => {
    it('a session without a ws block (Reverb not configured) runs the whole chat over REST polling', async () => {
        const backend = useBackend({ noWs: true });
        const h = createHarness({ backend, pollMs: 20 });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');

        expect(h.sockets).toHaveLength(0);
        // no Reverb is not a fault: no "Reconnecting…" line, REST polling just does the job
        expect(h.state().connection).toBe('idle');

        backend.claim('Sam');
        await until(() => h.state().phase === 'active');
        h.controller.send({ body: 'Hi over REST' });
        await until(() => h.state().messages.at(-1)?.status === 'sent');
        backend.agentSays('Hello back');
        await until(() =>
            h.state().messages.some((m) => m.body === 'Hello back'),
        );
    });

    it('a channel subscription the server refuses (503) keeps the chat on polling instead of waiting for events that never come', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 20 });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await until(() => h.socket() !== null);

        h.socket()?.failSubscription(503);
        expect(h.state().connection).toBe('idle');

        backend.claim('Sam');
        await until(() => h.state().phase === 'active');
        // a 401 / 403 is different: that ends the session
        h.socket()?.failSubscription(403);
        await until(() => h.state().phase === 'closed');
        expect(h.state().closedReason).toBe('expired');
    });
});

describe('typing', () => {
    it("shows the agent typing from the server's REST-typing fallback event as well as the whisper", async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.socket()?.emit('typing', { v: 1, actor: 'agent', typing: true });
        expect(h.state().typing).toBe(true);
        h.socket()?.emit('typing', { v: 1, actor: 'agent', typing: false });
        expect(h.state().typing).toBe(false);
        h.socket()?.emit('client-typing', { actor: 'agent', typing: true });
        expect(h.state().typing).toBe(true);
    });

    it('whispers client-typing at most every 3 s and sends false when the draft is emptied', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.controller.typingChanged(true);
        h.controller.typingChanged(true);
        h.controller.typingChanged(true);
        h.controller.typingChanged(false);

        expect(h.socket()?.whispers.map((w) => w.payload)).toEqual([
            { actor: 'visitor', typing: true },
            { actor: 'visitor', typing: false },
        ]);
    });

    it('falls back to the REST typing endpoint while the socket is down', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        h.socket()?.setStatus('disconnected');
        h.controller.typingChanged(true);
        await until(() => backend.state.typing.length === 1);

        expect(backend.state.typing).toEqual([true]);
    });

    it('sending a message stops the typing indicator', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.controller.typingChanged(true);
        h.controller.send({ body: 'done typing' });

        expect(h.socket()?.whispers.at(-1)?.payload).toEqual({
            actor: 'visitor',
            typing: false,
        });
    });

    it('shows the agent typing and expires it after 5 s even if "stopped" never arrives', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });

        try {
            h.socket()?.emit('client-typing', { actor: 'agent', typing: true });
            expect(h.state().typing).toBe(true);

            await vi.advanceTimersByTimeAsync(4000);
            expect(h.state().typing).toBe(true);

            await vi.advanceTimersByTimeAsync(1100);
            expect(h.state().typing).toBe(false);

            h.socket()?.emit('client-typing', { actor: 'agent', typing: true });
            h.socket()?.emit('client-typing', {
                actor: 'agent',
                typing: false,
            });
            expect(h.state().typing).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('session loss and refusal', () => {
    it('401 session_revoked while chatting: the host forgets the token and the visitor gets the expired screen', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await active(h);

        const token = h.sessions.at(-1)?.token ?? '';

        backend.revoke(token);
        h.controller.send({ body: 'Anyone?' });
        await until(() => h.state().phase === 'closed');

        expect(h.state().closedReason).toBe('expired');
        expect(h.sessions.at(-1)).toBeNull();
        expect(h.sockets.at(-1)?.closed).toBe(true);

        // a new chat starts a fresh session
        h.controller.newChat();
        h.controller.submitPrechat(h.state().form);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        expect(h.sessions.at(-1)?.token).not.toBe(token);
    });

    it('the websocket auth endpoint refusing the token ends the session the same way', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.socket()?.failSubscription(401);
        await until(() => h.state().phase === 'closed');

        expect(h.state().closedReason).toBe('expired');
        expect(h.sessions.at(-1)).toBeNull();
    });
});

describe('visibility and focus signals', () => {
    beforeEach(() => vi.useRealTimers());
    afterEach(() => {
        Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            configurable: true,
        });
    });

    it('the tab becoming visible re-syncs the conversation', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        backend.agentSays('missed while hidden');
        document.dispatchEvent(new Event('visibilitychange'));
        await until(() => h.state().messages.length === 2);

        expect(h.state().messages.at(-1)?.body).toBe('missed while hidden');
    });

    it('viewing receipts stop when the panel is not being looked at', async () => {
        const backend = useBackend();
        const h = createHarness({ backend });

        await active(h);
        h.controller.setViewing(false);
        backend.agentSays('unseen');
        h.socket()?.emit('message.created', {
            v: 1,
            message: backend.state.messages.at(-1),
        });
        await until(() => backend.state.receipts.length > 0);

        expect(
            backend.state.receipts.every((r) => r.seen_upto === undefined),
        ).toBe(true);
        expect(makeAgentMessage().sender.type).toBe('agent');
    });
});

async function queued(h: Harness): Promise<void> {
    await h.init();
    h.open();
    h.controller.submitPrechat(FORM);
    h.controller.chooseCategory('billing');
    await until(() => h.state().phase === 'queued');
    await until(() => h.socket()?.status() === 'connected');
}

describe('conversation.missed', () => {
    it('moves a queued chat to the offline form, remembering the missed conversation for the ticket, and closes the socket', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await queued(h);

        const ulid = h.state().conversation?.ulid;
        const socket = h.socket();

        socket?.emit('conversation.missed', { v: 1 });

        expect(h.state().phase).toBe('offline');
        expect(h.state().offline).toMatchObject({
            reason: 'missed',
            missed: ulid,
        });
        expect(socket?.closed).toBe(true);
        expect(socket?.bindings).toBe(0);
        expect(h.hostStates().at(-1)?.status).toBe('offline');
    });

    it('a missed event for a chat that is already active changes nothing', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.socket()?.emit('conversation.missed', { v: 1 });

        expect(h.state().phase).toBe('active');
    });

    it('polls GET /public/conversation while queued even with a healthy socket, so a missed queue is noticed without the event', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 20 });

        await queued(h);

        const before = backend.callsTo('GET', '/conversation').length;

        backend.miss();
        await until(() => h.state().phase === 'offline');

        expect(backend.callsTo('GET', '/conversation').length).toBeGreaterThan(
            before,
        );
        expect(h.state().offline.reason).toBe('missed');
    });

    it('a chat closed behind the visitor back while queued is noticed by polling too', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 20 });

        await queued(h);
        backend.close();
        await until(() => h.state().phase !== 'queued');

        expect(['offline', 'closed']).toContain(h.state().phase);
    });

    it('stops polling once the chat left the queue', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 20 });

        await queued(h);
        backend.claim('Sam');
        h.socket()?.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        await until(() => h.state().phase === 'active');
        await new Promise((resolve) => setTimeout(resolve, 30));

        const calls = backend.callsTo('GET', '/conversation').length;

        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(backend.callsTo('GET', '/conversation')).toHaveLength(calls);
    });
});

describe('subscriptions are unbound', () => {
    it('on every state change out of the live states and on dispose: a finished chat leaves nothing listening', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);

        const first = h.socket();

        expect(first?.bindings).toBeGreaterThan(8);

        // ended (rating screen): the live connection is not needed any more
        h.socket()?.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: true,
        });
        expect(h.state().phase).toBe('ended');
        expect(first?.bindings).toBe(0);
        expect(first?.closed).toBe(true);

        await h.controller.rate(5, '');
        expect(h.state().phase).toBe('closed');

        // a new chat gets a new socket with exactly one handler per event
        h.controller.newChat();
        h.controller.submitPrechat(h.state().form);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await until(() => h.sockets.length === 2);
        await until(() => h.socket()?.status() === 'connected');

        const second = h.socket();

        expect(second).not.toBe(first);
        expect(first?.bindings).toBe(0);
        expect(second?.listenersOn('message.created')).toBe(1);
        expect(second?.listenersOn('client-typing')).toBe(1);
        expect(second?.listenersOn('typing')).toBe(1);
        expect(second?.listenersOn('conversation.missed')).toBe(1);

        const bound = second?.bindings;

        // reconnect flaps and a resumed subscription never add handlers
        for (let round = 0; round < 3; round++) {
            second?.setStatus('disconnected');
            second?.setStatus('connected');
        }

        expect(second?.bindings).toBe(bound);

        h.controller.dispose();
        expect(second?.bindings).toBe(0);
        expect(second?.closed).toBe(true);
    });

    it('a chat that is cancelled while the socket is still opening ends up with no socket bound at all', async () => {
        const backend = useBackend();
        const sockets: import('@/tests/embed-harness').FakeSocket[] = [];
        const { FakeSocket } = await import('@/tests/embed-harness');
        const h = createHarness({
            backend,
            deps: {
                socketFactory: async (input) => {
                    await new Promise((resolve) => setTimeout(resolve, 40));

                    const socket = new FakeSocket(input);

                    sockets.push(socket);

                    return socket;
                },
            },
        });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await h.controller.cancelQueued();
        await until(() => sockets.length === 1);
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(h.state().phase).toBe('closed');
        expect(sockets[0].closed).toBe(true);
        expect(sockets[0].bindings).toBe(0);
    });

    it('a new chat started while the previous socket is still opening is not blocked by it', async () => {
        const backend = useBackend();
        const { FakeSocket } = await import('@/tests/embed-harness');
        const sockets: InstanceType<typeof FakeSocket>[] = [];
        let delay = 60;
        const h = createHarness({
            backend,
            deps: {
                socketFactory: async (input) => {
                    await new Promise((resolve) => setTimeout(resolve, delay));

                    const socket = new FakeSocket(input);

                    sockets.push(socket);
                    queueMicrotask(() => socket.setStatus('connected'));

                    return socket;
                },
            },
        });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await h.controller.cancelQueued();

        delay = 1;
        h.controller.newChat();
        h.controller.submitPrechat(h.state().form);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        await until(() => sockets.length === 2);
        await new Promise((resolve) => setTimeout(resolve, 80));

        // the stale socket was closed, the current one is live and bound
        const live = sockets.filter((socket) => !socket.closed);

        expect(live).toHaveLength(1);
        expect(live[0].input.conversation).toBe(h.state().conversation?.ulid);
        expect(live[0].listenersOn('message.created')).toBe(1);
    });
});

describe('rotation and the websocket', () => {
    it('a transient failure learning where Reverb lives (503 on the rotation) is retried, then the socket opens with the new token', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.fail('POST', '/sessions$', 503, undefined, 1);

        const { makeInit } = await import('@/tests/embed-harness');
        const h = createHarness({ backend, pollMs: 20 });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().phase).toBe('active');
        expect(h.sockets).toHaveLength(0);
        expect(h.sessions).toEqual([]);

        await until(() => h.sockets.length === 1);

        const rotated = backend.state.rotated.get(stored.token);

        expect(rotated).toBeDefined();
        expect(h.socket()?.input.token).toBe(rotated);
        expect(h.sessions.at(-1)?.token).toBe(rotated);
    });

    it('a REST call that left with the token a rotation just replaced does not end the session', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');

        const { makeInit } = await import('@/tests/embed-harness');
        const h = createHarness({ backend, pollMs: 100_000 });

        await h.init(makeInit({ visitorSession: stored }));
        await until(() => h.sockets.length === 1);

        backend.fail('GET', '/conversation$', 401, {
            error: { code: 'session_revoked', message: 'Revoked.' },
        });
        await h.controller.syncConversation();

        expect(h.state().phase).toBe('active');
        expect(h.sessions.at(-1)).not.toBeNull();

        // the same refusal later on is real
        backend.fail('GET', '/conversation$', 401, {
            error: { code: 'session_revoked', message: 'Revoked.' },
        });
        await h.controller.syncConversation();
        expect(h.state().phase).toBe('closed');
        expect(h.state().closedReason).toBe('expired');
    });
});
