import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    openConversationRealtime,
    type RealtimeHandlers,
    type RealtimeStatus,
    type SyncReason,
} from '@/lib/realtime/visitor/connection';
import { FakeSocket } from '@/tests/embed-harness';
import { makeAgentMessage } from '@/lib/chat/fixtures';
import type { SocketFactory, SocketInput } from '@/lib/realtime/visitor/types';

const INPUT: SocketInput = {
    ws: { key: 'k', host: 'ws.test', port: 443, scheme: 'https' },
    token: 'vt_token',
    conversation: '01CONV',
    authEndpoint: 'https://chat.test/api/v1/public/broadcasting/auth',
};

function handlers() {
    const calls = {
        messages: [] as unknown[],
        delivered: [] as unknown[],
        seen: [] as unknown[],
        claimed: [] as unknown[],
        ended: [] as unknown[],
        closed: [] as unknown[],
        transferred: 0,
        missed: 0,
        typing: [] as unknown[],
        statuses: [] as RealtimeStatus[],
        syncs: [] as SyncReason[],
        authFailures: 0,
    };
    const value: RealtimeHandlers = {
        onMessage: (m) => calls.messages.push(m),
        onDelivered: (r) => calls.delivered.push(r),
        onSeen: (r) => calls.seen.push(r),
        onClaimed: (c) => calls.claimed.push(c),
        onEnded: (e) => calls.ended.push(e),
        onClosed: (c) => calls.closed.push(c),
        onMissed: () => void calls.missed++,
        onTransferred: () => void calls.transferred++,
        onTyping: (t) => calls.typing.push(t),
        onStatus: (s) => calls.statuses.push(s),
        sync: (r) => calls.syncs.push(r),
        onAuthFailure: () => void calls.authFailures++,
    };

    return { calls, value };
}

async function open(pollMs = 50) {
    const sockets: FakeSocket[] = [];
    const factory: SocketFactory = async (input) => {
        const socket = new FakeSocket(input);

        sockets.push(socket);

        return socket;
    };
    const { calls, value } = handlers();
    const realtime = await openConversationRealtime({
        factory,
        input: INPUT,
        handlers: value,
        pollMs,
        retryMs: 20,
    });

    return { realtime, socket: sockets[0], sockets, calls };
}

describe('events', () => {
    it('decodes server events into typed handler calls', async () => {
        const { socket, calls, realtime } = await open();
        const message = makeAgentMessage({ conversation: '01CONV', seq: 4 });

        socket.setStatus('connected');
        socket.emit('message.created', { v: 1, message });
        socket.emit('message.delivered', {
            v: 1,
            upToSeq: 4,
            by: 'agent',
            at: '2026-11-20T09:59:00.000Z',
        });
        socket.emit('message.seen', {
            v: 1,
            upToSeq: 3,
            by: 'agent',
            at: '2026-11-20T10:00:00.000Z',
        });
        socket.emit('chat.claimed', {
            v: 1,
            agent: { name: 'Sam', avatarUrl: null },
            claimedAt: 'x',
        });
        socket.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: true,
        });
        socket.emit('conversation.closed', { v: 1, reason: 'idle' });
        socket.emit('conversation.transferred', { v: 1 });
        socket.emit('client-typing', { actor: 'agent', typing: true });

        expect(calls.messages).toEqual([message]);
        expect(calls.delivered).toEqual([
            { upToSeq: 4, by: 'agent', at: '2026-11-20T09:59:00.000Z' },
        ]);
        expect(calls.seen).toEqual([
            { upToSeq: 3, by: 'agent', at: '2026-11-20T10:00:00.000Z' },
        ]);
        expect(calls.claimed).toEqual([
            { agent: { name: 'Sam', avatarUrl: null }, claimedAt: 'x' },
        ]);
        expect(calls.ended).toEqual([
            { endedBy: 'agent', ratingRequested: true },
        ]);
        expect(calls.closed).toEqual([{ reason: 'idle' }]);
        expect(calls.transferred).toBe(1);
        expect(calls.typing).toEqual([{ actor: 'agent', typing: true }]);

        realtime.close();
    });

    it("ignores malformed payloads, other versions and the visitor's own typing echo", async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.emit('message.created', { v: 2, message: makeAgentMessage() });
        socket.emit('message.created', { v: 1, message: { ulid: 1 } });
        socket.emit('message.created', null);
        socket.emit('message.seen', {
            v: 1,
            upToSeq: 'x',
            by: 'agent',
            at: 'y',
        });
        socket.emit('message.seen', { v: 1, upToSeq: 1, by: 'robot', at: 'y' });
        socket.emit('message.delivered', {
            v: 1,
            upToSeq: 'x',
            by: 'agent',
            at: 'y',
        });
        socket.emit('message.delivered', {
            v: 1,
            upToSeq: 1,
            by: 'robot',
            at: 'y',
        });
        socket.emit('message.delivered', {
            v: 2,
            upToSeq: 1,
            by: 'agent',
            at: 'y',
        });
        socket.emit('chat.claimed', { v: 1, agent: {} });
        socket.emit('conversation.ended', { v: 1, endedBy: 'nobody' });
        socket.emit('conversation.closed', { v: 1, reason: 'weird' });
        socket.emit('conversation.transferred', { v: 9 });
        socket.emit('client-typing', { actor: 'visitor', typing: true });
        socket.emit('client-typing', { actor: 'agent', typing: 'yes' });

        expect(calls.messages).toEqual([]);
        expect(calls.seen).toEqual([]);
        expect(calls.delivered).toEqual([]);
        expect(calls.claimed).toEqual([]);
        expect(calls.ended).toEqual([]);
        expect(calls.closed).toEqual([]);
        expect(calls.transferred).toBe(0);
        expect(calls.typing).toEqual([]);

        realtime.close();
    });

    it('opens the channel with the visitor token and the conversation', async () => {
        const { socket, realtime } = await open();

        expect(socket.input).toEqual(INPUT);

        realtime.close();
    });

    it('reports a refused session (401 / 403 on the channel auth)', async () => {
        const { socket, calls, realtime } = await open();

        socket.failSubscription(403);
        socket.failSubscription(401);
        expect(calls.authFailures).toBe(2);

        realtime.close();
    });

    it("binds the server's REST typing fallback (`typing`) next to the whisper (`client-typing`)", async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.emit('typing', { v: 1, actor: 'agent', typing: true });
        socket.emit('typing', { v: 1, actor: 'visitor', typing: true });
        socket.emit('client-typing', { actor: 'agent', typing: false });

        expect(calls.typing).toEqual([
            { actor: 'agent', typing: true },
            { actor: 'agent', typing: false },
        ]);

        realtime.close();
    });

    it('binds the whisper and the typing fallback the way Echo wants them (a leading dot), not under the App\\Events namespace', async () => {
        const { socket, realtime } = await open();

        expect(socket.listenersOn('client-typing')).toBe(1);
        expect(socket.listenersOn('typing')).toBe(1);
        expect(socket.listenersOn('conversation.missed')).toBe(1);
        expect(socket.listenersOn('message.created')).toBe(1);
        expect(
            [...socket.handlers.keys()].filter((name) =>
                name.startsWith('App\\Events'),
            ),
        ).toEqual([]);

        realtime.close();
    });

    it('conversation.missed tells the owner the queue ran out; other versions are ignored', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.emit('conversation.missed', { v: 9 });
        socket.emit('conversation.missed', null);
        expect(calls.missed).toBe(0);

        socket.emit('conversation.missed', { v: 1 });
        expect(calls.missed).toBe(1);

        realtime.close();
    });
});

describe('status and catch-up', () => {
    it('reports connecting -> online and asks for a first sync on connect', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');

        expect(calls.statuses).toEqual(['connecting', 'online']);
        expect(calls.syncs).toEqual(['connect']);
        expect(realtime.isUp()).toBe(true);

        realtime.close();
    });

    it('shows reconnecting after a drop and syncs again as a reconnect', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.setStatus('disconnected');
        expect(calls.statuses.at(-1)).toBe('reconnecting');
        expect(realtime.isUp()).toBe(false);

        socket.setStatus('connecting');
        expect(calls.statuses.at(-1)).toBe('reconnecting');

        socket.setStatus('connected');
        expect(calls.statuses.at(-1)).toBe('online');
        expect(calls.syncs).toEqual(['connect', 'reconnect']);

        realtime.close();
    });

    it('does not sync twice for a repeated connected status', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.setStatus('connected');
        expect(calls.syncs).toEqual(['connect']);

        realtime.close();
    });

    it('syncs when the tab becomes visible and when the browser comes back online', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        calls.syncs.length = 0;

        Object.defineProperty(document, 'visibilityState', {
            value: 'hidden',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        expect(calls.syncs).toEqual([]);

        Object.defineProperty(document, 'visibilityState', {
            value: 'visible',
            configurable: true,
        });
        document.dispatchEvent(new Event('visibilitychange'));
        window.dispatchEvent(new Event('online'));
        expect(calls.syncs).toEqual(['visible', 'visible']);

        realtime.close();
    });
});

describe('channel subscription', () => {
    it('is only up once the channel subscription went through, and syncs then (not before)', async () => {
        const { socket, calls, realtime } = await open();

        socket.holdSubscription = true;
        socket.setStatus('connected');
        expect(realtime.isUp()).toBe(false);
        expect(calls.syncs).toEqual([]);
        expect(calls.statuses.at(-1)).toBe('connecting');

        socket.confirmSubscription();
        expect(realtime.isUp()).toBe(true);
        expect(calls.statuses.at(-1)).toBe('online');
        expect(calls.syncs).toEqual(['connect']);

        realtime.close();
    });

    it('a subscription the server refuses (503 realtime_unavailable) counts as down: quiet polling, no "Reconnecting…" line', async () => {
        vi.useFakeTimers();

        try {
            const { socket, calls, realtime } = await open(1000);

            socket.holdSubscription = true;
            socket.setStatus('connected');
            socket.failSubscription(503);

            expect(realtime.isUp()).toBe(false);
            expect(calls.statuses.at(-1)).toBe('polling');
            expect(calls.authFailures).toBe(0);
            expect(realtime.whisperTyping(true)).toBe(false);

            await vi.advanceTimersByTimeAsync(1000);
            expect(calls.syncs).toEqual(['poll']);

            // a later reconnect that subscribes fine recovers
            socket.setStatus('disconnected');
            socket.setStatus('connected');
            socket.confirmSubscription();
            expect(calls.statuses.at(-1)).toBe('online');
            expect(calls.syncs.at(-1)).toBe('connect');

            realtime.close();
        } finally {
            vi.useRealTimers();
        }
    });

    it('re-subscribing after a reconnect syncs as a reconnect', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        socket.setStatus('disconnected');
        socket.setStatus('connected');

        expect(calls.syncs).toEqual(['connect', 'reconnect']);

        realtime.close();
    });
});

describe('REST polling fallback', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('polls every interval while the socket is down, and stops when it is up', async () => {
        const { socket, calls, realtime } = await open(10_000);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls.syncs).toEqual(['poll']);

        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls.syncs).toEqual(['poll', 'poll']);

        socket.setStatus('connected');
        calls.syncs.length = 0;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls.syncs).toEqual([]);

        socket.setStatus('disconnected');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(calls.syncs).toEqual(['poll']);

        realtime.close();
        calls.syncs.length = 0;
        await vi.advanceTimersByTimeAsync(30_000);
        expect(calls.syncs).toEqual([]);
    });

    it('keeps polling and retries when the socket cannot be created at all', async () => {
        const attempts: number[] = [];
        const factory: SocketFactory = async () => {
            attempts.push(1);
            throw new Error('chunk blocked');
        };
        const { calls, value } = handlers();
        const realtime = await openConversationRealtime({
            factory,
            input: INPUT,
            handlers: value,
            pollMs: 1000,
            retryMs: 3000,
        });

        expect(calls.statuses).toEqual(['connecting', 'reconnecting']);
        await vi.advanceTimersByTimeAsync(3000);
        expect(attempts.length).toBe(2);
        expect(calls.syncs).toContain('poll');
        expect(realtime.whisperTyping(true)).toBe(false);

        realtime.close();
    });
});

describe('typing whispers', () => {
    it('whispers client-typing only while connected', async () => {
        const { socket, realtime } = await open();

        expect(realtime.whisperTyping(true)).toBe(false);

        socket.setStatus('connected');
        expect(realtime.whisperTyping(true)).toBe(true);
        expect(socket.whispers).toEqual([
            {
                event: 'client-typing',
                payload: { actor: 'visitor', typing: true },
            },
        ]);

        socket.setStatus('disconnected');
        expect(realtime.whisperTyping(false)).toBe(false);

        realtime.close();
    });

    it('close() closes the socket and detaches listeners', async () => {
        const { socket, calls, realtime } = await open();

        socket.setStatus('connected');
        realtime.close();
        expect(socket.closed).toBe(true);

        calls.syncs.length = 0;
        document.dispatchEvent(new Event('visibilitychange'));
        expect(calls.syncs).toEqual([]);
    });
});

describe('bindings', () => {
    it('close() unbinds every listener, status, subscription and error callback, then closes the socket', async () => {
        const { socket, realtime } = await open();

        socket.setStatus('connected');
        expect(socket.bindings).toBeGreaterThan(8);

        realtime.close();
        expect(socket.bindings).toBe(0);
        expect(socket.closed).toBe(true);

        // nothing reacts to a late event or status change
        socket.emit('message.created', { v: 1, message: makeAgentMessage() });
        socket.setStatus('disconnected');
    });

    it('a reconnect re-subscribes the channel without adding a single handler', async () => {
        const { socket, realtime } = await open();

        socket.setStatus('connected');

        const bound = socket.bindings;

        for (let round = 0; round < 3; round++) {
            socket.setStatus('disconnected');
            socket.setStatus('connecting');
            socket.setStatus('connected');
        }

        expect(socket.bindings).toBe(bound);
        expect(socket.listenersOn('message.created')).toBe(1);
        expect(socket.listenersOn('client-typing')).toBe(1);

        realtime.close();
    });

    it('a socket that finishes opening after close() is closed at once and never bound', async () => {
        let release: (socket: FakeSocket) => void = () => undefined;
        const late = new Promise<FakeSocket>((resolve) => {
            release = resolve;
        });
        const factory: SocketFactory = () => late;
        const { value } = handlers();
        const opening = openConversationRealtime({
            factory,
            input: INPUT,
            handlers: value,
        });
        const socket = new FakeSocket(INPUT);

        // close() cannot be called before the promise resolves, so resolve first, then check nothing stays bound after close
        release(socket);

        const realtime = await opening;

        realtime.close();
        expect(socket.bindings).toBe(0);
        expect(socket.closed).toBe(true);
    });
});

describe('polling only', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());

    it('without a ws config there is no socket: status polling, REST sync every interval, no retries', async () => {
        const created: number[] = [];
        const factory: SocketFactory = async (input) => {
            created.push(1);

            return new FakeSocket(input);
        };
        const { calls, value } = handlers();
        const realtime = await openConversationRealtime({
            factory,
            input: null,
            handlers: value,
            pollMs: 1000,
        });

        expect(created).toEqual([]);
        expect(calls.statuses).toEqual(['polling']);
        expect(realtime.isUp()).toBe(false);
        expect(realtime.whisperTyping(true)).toBe(false);

        await vi.advanceTimersByTimeAsync(3000);
        expect(calls.syncs).toEqual(['poll', 'poll', 'poll']);

        realtime.close();
        calls.syncs.length = 0;
        await vi.advanceTimersByTimeAsync(3000);
        expect(calls.syncs).toEqual([]);
    });

    it('gives up on a socket that can never be created after five tries and polls quietly', async () => {
        const factory: SocketFactory = async () => {
            throw new Error('chunk blocked');
        };
        const { calls, value } = handlers();
        const realtime = await openConversationRealtime({
            factory,
            input: INPUT,
            handlers: value,
            pollMs: 100_000,
            retryMs: 1000,
        });

        await vi.advanceTimersByTimeAsync(10_000);

        expect(calls.statuses).toEqual([
            'connecting',
            'reconnecting',
            'polling',
        ]);

        realtime.close();
    });
});
