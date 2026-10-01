/**
 * The staff bindings against the REAL `@laravel/echo-react` and `laravel-echo` (nothing mocked but the Pusher client underneath):
 * what the other tests assume about Echo (custom event names need the leading dot, whispers go out as `client-*`, presence callbacks,
 * the connection status mapping, leaving channels on unmount) is checked here against the library itself.
 */
import '@/tests/dom-polyfills';
import { configureEcho } from '@laravel/echo-react';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    fakeTime,
    fakeUlid,
    makeActiveConversationStaff,
    makeMessage,
    makeOffer,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { createStaffController } from '@/lib/realtime/staff/controller';
import { createInboxStore } from '@/lib/realtime/staff/store';
import { StaffRealtimeBindings } from '@/lib/realtime/staff/use-staff-realtime';
import {
    ConversationChannelBindings,
    type ConversationBridge,
} from '@/lib/realtime/staff/use-conversation';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

type Handler = (data: unknown) => void;

class FakeChannel {
    handlers = new Map<string, Set<Handler>>();
    trigger = vi.fn();

    constructor(public name: string) {}

    bind(event: string, callback: Handler) {
        this.handlers.set(
            event,
            (this.handlers.get(event) ?? new Set()).add(callback),
        );

        return this;
    }

    unbind(event: string, callback?: Handler) {
        if (callback) {
            this.handlers.get(event)?.delete(callback);
        } else {
            this.handlers.delete(event);
        }

        return this;
    }

    bind_global() {
        return this;
    }

    unbind_global() {
        return this;
    }

    /** What the Pusher client does when the server sends `event` on this channel. */
    receive(event: string, data: unknown) {
        this.handlers.get(event)?.forEach((callback) => callback(data));
    }
}

class FakePusher {
    channels = { channels: {} as Record<string, FakeChannel> };
    unsubscribed: string[] = [];
    private connectionHandlers = new Map<string, Set<() => void>>();
    connection = {
        state: 'connected',
        socket_id: '1.1',
        bind: (event: string, callback: () => void) => {
            this.connectionHandlers.set(
                event,
                (this.connectionHandlers.get(event) ?? new Set()).add(callback),
            );
        },
        unbind: (event: string, callback: () => void) => {
            this.connectionHandlers.get(event)?.delete(callback);
        },
    };

    subscribe(name: string) {
        return (this.channels.channels[name] ??= new FakeChannel(name));
    }

    unsubscribe(name: string) {
        this.unsubscribed.push(name);
        delete this.channels.channels[name];
    }

    disconnect() {}

    /** Pusher's own state machine: `connected`, `connecting`, `unavailable`, `disconnected`, ... */
    setState(state: string) {
        this.connection.state = state;
        this.connectionHandlers
            .get('state_change')
            ?.forEach((callback) => callback());
    }

    channel(name: string): FakeChannel {
        const channel = this.channels.channels[name];

        if (!channel) {
            throw new Error(
                `Not subscribed to ${name}: ${Object.keys(this.channels.channels).join(', ')}`,
            );
        }

        return channel;
    }
}

let pusher: FakePusher;

beforeEach(() => {
    resetFixtures();
    resetInertiaMock();
    pusher = new FakePusher();
    configureEcho({
        broadcaster: 'reverb',
        key: 'test-key',
        client: pusher,
        withoutInterceptors: true,
    } as Parameters<typeof configureEcho>[0]);
});

function controllerFor(isAdmin = false) {
    const store = createInboxStore();
    const effects = {
        playSound: vi.fn(),
        toast: vi.fn(),
        dismissToast: vi.fn(),
        notify: vi.fn(),
        closeNotification: vi.fn(),
        signOut: vi.fn(),
        openConversation: vi.fn(),
    };
    const controller = createStaffController({
        store,
        api: {
            queue: vi.fn().mockResolvedValue([]),
            conversations: vi.fn().mockResolvedValue([]),
            presence: vi.fn(),
            heartbeat: vi.fn(),
        } as never,
        viewer: { id: 7, isAdmin, isAgent: true },
        t: (key) => key,
        effects,
        isViewing: () => false,
    });

    return { store, controller, effects };
}

describe('the staff channels', () => {
    it('subscribes to the private staff channel and the presence channel, and to admin only for admins', async () => {
        const agent = controllerFor();

        await render(
            <StaffRealtimeBindings
                controller={agent.controller}
                store={agent.store}
                userId={7}
                isAdmin={false}
            />,
        );

        expect(Object.keys(pusher.channels.channels).sort()).toEqual([
            'presence-staff',
            'private-staff.7',
        ]);

        const admin = controllerFor(true);

        await render(
            <StaffRealtimeBindings
                controller={admin.controller}
                store={admin.store}
                userId={1}
                isAdmin
            />,
        );

        expect(Object.keys(pusher.channels.channels)).toContain(
            'private-admin',
        );
    });

    it('delivers server events under their broadcastAs() names (the leading dot is what makes Echo keep them)', async () => {
        const { store, controller, effects } = controllerFor();

        await render(
            <StaffRealtimeBindings
                controller={controller}
                store={store}
                userId={7}
                isAdmin={false}
            />,
        );
        const offer = makeOffer({
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });

        await act(async () =>
            pusher.channel('private-staff.7').receive('chat.offered', offer),
        );

        expect(store.getState().queue.map((item) => item.conversation)).toEqual(
            [offer.conversation],
        );
        expect(effects.playSound).toHaveBeenCalledWith('offer');

        await act(async () =>
            pusher.channel('private-staff.7').receive('chat.taken', {
                v: 1,
                conversation: offer.conversation,
                by: { id: 9, name: 'Omar' },
            }),
        );
        expect(store.getState().queue[0]).toMatchObject({
            state: 'taken',
            takenBy: 'Omar',
        });

        const chat = makeActiveConversationStaff({
            assignedAgent: { id: 7, name: 'Sam' },
        });

        await act(async () =>
            pusher
                .channel('private-staff.7')
                .receive('conversation.updated', { v: 1, conversation: chat }),
        );
        await act(async () =>
            pusher.channel('private-staff.7').receive('unread.updated', {
                v: 1,
                conversation: chat.ulid,
                unseen: 2,
            }),
        );
        expect(store.getState().mine[0]).toMatchObject({
            ulid: chat.ulid,
            unseenByAgent: 2,
        });
    });

    it('does not hear a server event under a namespaced name (what a missing dot would produce)', async () => {
        const { store, controller } = controllerFor();

        await render(
            <StaffRealtimeBindings
                controller={controller}
                store={store}
                userId={7}
                isAdmin={false}
            />,
        );
        await act(async () =>
            pusher
                .channel('private-staff.7')
                .receive('App\\Events\\chat.offered', makeOffer()),
        );

        expect(store.getState().queue).toEqual([]);
    });

    it("reads the presence roster from the channel's member callbacks", async () => {
        const { store, controller } = controllerFor();
        const info = (id: number, status: 'online' | 'away' = 'online') => ({
            id,
            name: `Agent ${id}`,
            avatarUrl: null,
            status,
        });

        await render(
            <StaffRealtimeBindings
                controller={controller}
                store={store}
                userId={7}
                isAdmin={false}
            />,
        );
        const channel = pusher.channel('presence-staff');

        await act(async () =>
            channel.receive('pusher:subscription_succeeded', {
                members: { 7: info(7), 9: info(9) },
            }),
        );
        expect(store.getState().roster.map((m) => m.id)).toEqual([7, 9]);

        await act(async () =>
            channel.receive('pusher:member_added', { id: 11, info: info(11) }),
        );
        await act(async () =>
            channel.receive('pusher:member_removed', { id: 9, info: info(9) }),
        );
        expect(store.getState().roster.map((m) => m.id)).toEqual([7, 11]);

        await act(async () =>
            channel.receive('presence.changed', {
                v: 1,
                userId: 11,
                status: 'away',
            }),
        );
        expect(store.getState().roster.find((m) => m.id === 11)?.status).toBe(
            'away',
        );
    });

    it("follows the connection, as Echo reports Pusher's states", async () => {
        const { store, controller } = controllerFor();

        await render(
            <StaffRealtimeBindings
                controller={controller}
                store={store}
                userId={7}
                isAdmin={false}
            />,
        );
        expect(store.getState().connection).toBe('connected');

        await act(async () => pusher.setState('connecting'));
        expect(store.getState().connection).toBe('connecting');

        await act(async () => pusher.setState('unavailable'));
        expect(store.getState().connection).toBe('failed');

        await act(async () => pusher.setState('connected'));
        expect(store.getState().connection).toBe('connected');
    });

    it('leaves its channels when the page goes away', async () => {
        const { store, controller } = controllerFor();
        const view = await render(
            <StaffRealtimeBindings
                controller={controller}
                store={store}
                userId={7}
                isAdmin={false}
            />,
        );

        await view.unmount();

        expect(pusher.unsubscribed.sort()).toEqual([
            'presence-staff',
            'private-staff.7',
        ]);
    });
});

describe('the conversation channel', () => {
    const CONVERSATION = fakeUlid(7000);

    function bridge(): ConversationBridge & {
        calls: Record<string, unknown[]>;
    } {
        const calls: Record<string, unknown[]> = {};
        const record =
            (name: string) =>
            (...args: unknown[]) => {
                (calls[name] ??= []).push(args.length === 1 ? args[0] : args);
            };

        return {
            calls,
            messageCreated: record('messageCreated'),
            delivered: record('delivered'),
            seen: record('seen'),
            ended: record('ended'),
            closed: record('closed'),
            typing: record('typing'),
            connected: record('connected'),
            setWhisper: record('setWhisper'),
        };
    }

    it('hears messages, delivery and read receipts, end / close and both typing signals', async () => {
        const b = bridge();

        await render(
            <ConversationChannelBindings ulid={CONVERSATION} bridge={b} />,
        );
        const channel = pusher.channel(`private-conversation.${CONVERSATION}`);
        const message = makeMessage({
            seq: 1,
            conversation: CONVERSATION,
            createdAt: fakeTime(1),
        });

        await act(async () =>
            channel.receive('message.created', { v: 1, message }),
        );
        await act(async () =>
            channel.receive('message.delivered', {
                v: 1,
                upToSeq: 1,
                by: 'visitor',
                at: fakeTime(2),
            }),
        );
        await act(async () =>
            channel.receive('message.seen', {
                v: 1,
                upToSeq: 1,
                by: 'visitor',
                at: fakeTime(3),
            }),
        );
        await act(async () =>
            channel.receive('conversation.ended', {
                v: 1,
                endedBy: 'visitor',
                ratingRequested: true,
            }),
        );
        await act(async () =>
            channel.receive('conversation.closed', { v: 1, reason: 'rated' }),
        );
        await act(async () =>
            channel.receive('client-typing', {
                actor: 'visitor',
                typing: true,
            }),
        );
        await act(async () =>
            channel.receive('typing', {
                v: 1,
                actor: 'visitor',
                typing: false,
            }),
        );

        expect(b.calls.messageCreated).toEqual([message]);
        expect(b.calls.delivered).toEqual([
            { upToSeq: 1, by: 'visitor', at: fakeTime(2) },
        ]);
        expect(b.calls.seen).toEqual([
            { upToSeq: 1, by: 'visitor', at: fakeTime(3) },
        ]);
        expect(b.calls.ended).toEqual([{ ratingRequested: true }]);
        expect(b.calls.closed).toHaveLength(1);
        expect(b.calls.typing).toEqual([
            { actor: 'visitor', typing: true },
            { actor: 'visitor', typing: false },
        ]);
    });

    it('whispers typing as the client event `client-typing`', async () => {
        const b = bridge();

        await render(
            <ConversationChannelBindings ulid={CONVERSATION} bridge={b} />,
        );

        const send = (b.calls.setWhisper as unknown[]).find(
            (fn) => typeof fn === 'function',
        ) as (w: { actor: 'agent'; typing: boolean }) => void;

        send({ actor: 'agent', typing: true });

        expect(
            pusher.channel(`private-conversation.${CONVERSATION}`).trigger,
        ).toHaveBeenCalledWith('client-typing', {
            actor: 'agent',
            typing: true,
        });
    });

    it('asks the bridge to catch up when the websocket comes back, not on the first connection', async () => {
        const b = bridge();

        await render(
            <ConversationChannelBindings ulid={CONVERSATION} bridge={b} />,
        );
        expect(b.calls.connected).toBeUndefined();

        await act(async () => pusher.setState('connecting'));
        await act(async () => pusher.setState('connected'));

        expect(b.calls.connected).toHaveLength(1);
    });
});
