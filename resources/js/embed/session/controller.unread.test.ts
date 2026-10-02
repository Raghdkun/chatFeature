/**
 * What the panel tells the loader's launcher about unread messages (P5, docs/widget-embed-api.md "Unread badge and reply alert"):
 * the count follows the agent's unseen replies while the bubble is closed and the chat is live, is rebuilt from the server's
 * receipts when a page boots, never comes back after the visitor had the panel open, and is zero for a chat that is over.
 */
import { describe, expect, it } from 'vite-plus/test';
import { makeAgentMessage, makeMessage } from '@/lib/chat/fixtures';
import { useBackend } from '@/tests/msw/server';
import {
    createHarness,
    makeInit,
    until,
    type Harness,
} from '@/tests/embed-harness';

const FORM = { name: 'Vera', email: 'vera@x.test', phone: '', consent: false };

/** The chat is active with the panel open (the loader opened it for the form) and one system line ("Sam joined"). */
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

const unreadCounts = (h: Harness): number[] =>
    h.sent.flatMap((m) => (m.type === 'unread' ? [m.payload.count] : []));

const lastUnread = (h: Harness): number | undefined =>
    h.hostStates().at(-1)?.unread;

function reply(h: Harness, body: string): void {
    const message = h.backend.agentSays(body);

    h.socket()?.emit('message.created', { v: 1, message });
}

describe('unread while the bubble is closed', () => {
    it('every reply of a burst raises the count (one `unread` message each, with the newest preview)', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.close();
        reply(h, 'One moment');
        reply(h, 'I am checking');
        reply(h, 'Found it');

        expect(unreadCounts(h)).toEqual([1, 2, 3]);
        expect(lastUnread(h)).toBe(3);
        expect(h.sent.filter((m) => m.type === 'unread').at(-1)).toMatchObject({
            payload: {
                count: 3,
                preview: 'Found it',
                agent: { name: 'Sam' },
            },
        });
    });

    it("does not count the visitor's own messages (a second tab of the visitor) or system lines", async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.close();
        h.socket()?.emit('message.created', {
            v: 1,
            message: makeMessage({
                conversation: h.state().conversation?.ulid,
                seq: 2,
                body: 'Typed in my other tab',
            }),
        });
        h.socket()?.emit('message.created', {
            v: 1,
            message: h.backend.state.messages[0],
        });

        expect(unreadCounts(h)).toEqual([]);
        expect(lastUnread(h)).toBe(0);
    });

    it('opening clears it, and closing again does not bring it back; only newer replies count', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.close();
        reply(h, 'Are you there?');
        expect(lastUnread(h)).toBe(1);

        h.open();
        expect(lastUnread(h)).toBe(0);

        // arrives while the panel is open: nothing to tell the launcher
        const before = unreadCounts(h).length;

        reply(h, 'Also, one more thing');
        expect(unreadCounts(h)).toHaveLength(before);

        // no message list is mounted in this harness, so nothing was marked seen: the close alone must not resurrect them
        expect(
            h
                .state()
                .messages.filter(
                    (m) => m.sender.type === 'agent' && m.seenAt === null,
                ),
        ).toHaveLength(2);
        h.close();
        expect(lastUnread(h)).toBe(0);
        expect(unreadCounts(h)).toHaveLength(before);

        reply(h, 'Sorry, back again');
        expect(lastUnread(h)).toBe(1);
        expect(unreadCounts(h).at(-1)).toBe(1);
    });

    it('a chat that ends with unread replies shows nothing: ended, and the launcher is told zero', async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.close();
        reply(h, 'Goodbye then');
        expect(lastUnread(h)).toBe(1);

        h.socket()?.emit('conversation.ended', {
            v: 1,
            endedBy: 'agent',
            ratingRequested: true,
        });

        expect(h.state().phase).toBe('ended');
        expect(h.hostStates().at(-1)).toMatchObject({
            status: 'ended',
            unread: 0,
        });
    });

    it('a queued chat has nothing unread and is reported as queued', async () => {
        const h = createHarness({ backend: useBackend() });

        await h.init();
        h.open();
        h.controller.submitPrechat(FORM);
        h.controller.chooseCategory('billing');
        await until(() => h.state().phase === 'queued');
        h.close();

        expect(h.hostStates().at(-1)).toMatchObject({
            status: 'queued',
            unread: 0,
        });
        expect(unreadCounts(h)).toEqual([]);
    });
});

describe('unread after a page navigation (the loader boots a new panel)', () => {
    it('is rebuilt from the server: only the agent messages the visitor never saw count', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Read on the last page', {
            deliveredAt: '2026-11-20T10:00:05.000Z',
            seenAt: '2026-11-20T10:00:06.000Z',
        });
        backend.agentSays('Arrived while no page was open');
        backend.agentSays('And this one too', {
            deliveredAt: '2026-11-20T10:00:09.000Z',
        });

        const h = createHarness({ backend });

        await h.init(makeInit({ visitorSession: stored }));

        expect(h.state().phase).toBe('active');
        expect(unreadCounts(h)).toEqual([2]);
        expect(h.sent.find((m) => m.type === 'unread')).toMatchObject({
            payload: {
                count: 2,
                preview: 'And this one too',
                agent: { name: 'Sam' },
            },
        });
        expect(lastUnread(h)).toBe(2);

        // the panel confirms delivery for what it just fetched, but not "seen": the visitor has not looked
        await until(() => backend.state.receipts.length > 0);
        expect(backend.state.receipts[0]).toEqual({ delivered_upto: 3 });
        expect(
            backend.state.receipts.some((r) => r.seen_upto !== undefined),
        ).toBe(false);

        h.open();
        expect(lastUnread(h)).toBe(0);
        h.close();
        expect(lastUnread(h)).toBe(0);
    });

    it('a resumed chat whose replies were all read has no badge, and a chat that is over has none either', async () => {
        const backend = useBackend();
        const stored = backend.issueToken();

        backend.seedConversation(stored.token, 'active');
        backend.agentSays('Read', { seenAt: '2026-11-20T10:00:06.000Z' });

        const read = createHarness({ backend });

        await read.init(makeInit({ visitorSession: stored }));
        expect(unreadCounts(read)).toEqual([]);
        expect(lastUnread(read)).toBe(0);

        const over = useBackend();
        const token = over.issueToken();

        over.seedConversation(token.token, 'active');
        over.agentSays('Never seen, but the chat has ended');
        over.agentEnds(true);

        const ended = createHarness({ backend: over });

        await ended.init(makeInit({ visitorSession: token }));
        expect(ended.state().phase).toBe('ended');
        expect(unreadCounts(ended)).toEqual([]);
        expect(ended.hostStates().at(-1)).toMatchObject({
            status: 'ended',
            unread: 0,
        });
    });
});

describe('several tabs of one visitor', () => {
    it("the other tab's seen receipt, delivered live, clears this tab's count", async () => {
        const h = createHarness({ backend: useBackend() });

        await active(h);
        h.close();
        reply(h, 'First');
        reply(h, 'Second');
        expect(lastUnread(h)).toBe(2);

        h.socket()?.emit('message.seen', {
            v: 1,
            upToSeq: 3,
            by: 'visitor',
            at: '2026-11-20T10:09:00.000Z',
        });

        expect(lastUnread(h)).toBe(0);
    });

    it('a receipt this tab missed (socket down) is found when it syncs: the count drops without a new message', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        h.close();
        reply(h, 'First');
        reply(h, 'Second');
        expect(lastUnread(h)).toBe(2);

        // another tab read both: only the server knows (`seen_at`), and this socket was away
        h.socket()?.setStatus('disconnected');
        backend.state.messages = backend.state.messages.map((m) =>
            m.sender.type === 'agent'
                ? { ...m, deliveredAt: 'x', seenAt: '2026-11-20T10:09:00.000Z' }
                : m,
        );
        h.socket()?.setStatus('connected');

        await until(() => lastUnread(h) === 0);
        // the catch-up reached back to the oldest message this tab still showed as unseen (seq 2, after_seq = 1)
        expect(
            backend.callsTo('GET', '/messages').at(-1)?.query.after_seq,
        ).toBe('1');
    });

    it('a sync with nothing unseen does not reach back (the fetch starts after the newest message)', async () => {
        const backend = useBackend();
        const h = createHarness({ backend, pollMs: 100_000 });

        await active(h);
        h.open();
        reply(h, 'Seen at once');
        h.controller.setViewing(true);
        await until(() => h.state().messages.at(-1)?.seenAt !== null);

        const before = backend.callsTo('GET', '/messages').length;

        h.socket()?.setStatus('disconnected');
        h.socket()?.setStatus('connected');
        await until(() => backend.callsTo('GET', '/messages').length > before);

        expect(
            backend.callsTo('GET', '/messages').at(-1)?.query.after_seq,
        ).toBe('2');
    });
});

it('an agent message that is already known does not count twice', async () => {
    const h = createHarness({ backend: useBackend() });

    await active(h);
    h.close();

    const message = makeAgentMessage({
        conversation: h.state().conversation?.ulid,
        seq: 2,
        body: 'Only once',
    });

    h.socket()?.emit('message.created', { v: 1, message });
    h.socket()?.emit('message.created', { v: 1, message });

    expect(unreadCounts(h)).toEqual([1]);
    expect(lastUnread(h)).toBe(1);
});
