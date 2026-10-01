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
        seen: [] as unknown[],
        claimed: [] as unknown[],
        ended: [] as unknown[],
        closed: [] as unknown[],
        transferred: 0,
        typing: [] as unknown[],
        statuses: [] as RealtimeStatus[],
        syncs: [] as SyncReason[],
        authFailures: 0,
    };
    const value: RealtimeHandlers = {
        onMessage: (m) => calls.messages.push(m),
        onSeen: (r) => calls.seen.push(r),
        onClaimed: (c) => calls.claimed.push(c),
        onEnded: (e) => calls.ended.push(e),
        onClosed: (c) => calls.closed.push(c),
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
        socket.emit('chat.claimed', { v: 1, agent: {} });
        socket.emit('conversation.ended', { v: 1, endedBy: 'nobody' });
        socket.emit('conversation.closed', { v: 1, reason: 'weird' });
        socket.emit('conversation.transferred', { v: 9 });
        socket.emit('client-typing', { actor: 'visitor', typing: true });
        socket.emit('client-typing', { actor: 'agent', typing: 'yes' });

        expect(calls.messages).toEqual([]);
        expect(calls.seen).toEqual([]);
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

        socket.authErrorHandler?.(403);
        socket.authErrorHandler?.(401);
        expect(calls.authFailures).toBe(2);

        realtime.close();
    });

    it('binds the server\'s REST typing fallback (`typing`) next to the whisper (`client-typing`)', async () => {
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

    it('a subscription the server refuses (503 realtime_unavailable) counts as down: reconnecting, polling covers it', async () => {
        vi.useFakeTimers();

        try {
            const { socket, calls, realtime } = await open(1000);

            socket.holdSubscription = true;
            socket.setStatus('connected');
            socket.authErrorHandler?.(503);

            expect(realtime.isUp()).toBe(false);
            expect(calls.statuses.at(-1)).toBe('reconnecting');
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
