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

describe('typing', () => {
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
        h.socket()?.authErrorHandler?.(401);
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
