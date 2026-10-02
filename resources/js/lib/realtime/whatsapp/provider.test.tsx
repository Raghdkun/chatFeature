import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { resetFixtures } from '@/lib/chat/fixtures';
import {
    useWaRetain,
    useWaState,
    useWaStateOptional,
} from '@/lib/realtime/whatsapp/context';
import { WhatsAppRealtimeProvider } from '@/lib/realtime/whatsapp/provider';
import { selectUnreadTotal } from '@/lib/realtime/whatsapp/store';
import type { WaApi } from '@/lib/whatsapp-api/client';
import {
    makeWaChat,
    makeWaMessage,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import { fakeEcho } from '@/tests/fake-echo';
import { render } from '@/tests/render';

vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);

const CHANNEL = 'private:whatsapp-admin';

function fakeApi(unread = [] as ReturnType<typeof makeWaChat>[]) {
    const chats = vi.fn(async () => ({ chats: unread, nextCursor: null }));

    return { api: { chats } as unknown as WaApi, chats };
}

/** A consumer, like the sidebar badge: it asks for the live data and shows the unread count. */
function Badge() {
    useWaRetain();

    const count = useWaStateOptional(selectUnreadTotal);

    return <span data-testid="count">{count === null ? 'none' : count}</span>;
}

function Connection() {
    return (
        <span data-testid="connection">{useWaState((s) => s.connection)}</span>
    );
}

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
    fakeEcho.reset();
});

describe('the provider', () => {
    it('gives an agent (and everybody who is not an administrator) nothing: no context, no request, no subscription', async () => {
        const { api, chats } = fakeApi();
        const view = await render(
            <WhatsAppRealtimeProvider admin={false} sockets api={api}>
                <Badge />
            </WhatsAppRealtimeProvider>,
        );

        expect(view.byTestId('count')?.textContent).toBe('none');
        expect(chats).not.toHaveBeenCalled();
        expect(fakeEcho.channels()).toEqual([]);
    });

    it('does nothing for an administrator until something needs the live data', async () => {
        const { api, chats } = fakeApi();

        await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <p>page</p>
            </WhatsAppRealtimeProvider>,
        );

        expect(chats).not.toHaveBeenCalled();
        expect(fakeEcho.channels()).toEqual([]);
    });

    it('starts when the first consumer mounts: reads the unread chats and joins the admin channel', async () => {
        const { api, chats } = fakeApi([makeWaChat({ unreadByAdmin: 4 })]);
        const view = await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <Badge />
            </WhatsAppRealtimeProvider>,
        );

        expect(chats).toHaveBeenCalledTimes(1);
        expect(view.byTestId('count')?.textContent).toBe('4');
        expect(fakeEcho.channels()).toContain(CHANNEL);
    });

    it('applies the broadcast events through the leading-dot names and counts the unread messages', async () => {
        const { api } = fakeApi();
        const view = await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <Badge />
            </WhatsAppRealtimeProvider>,
        );
        const chat = makeWaChat({ unreadByAdmin: 2 });

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.created', {
                v: 1,
                message: makeWaMessage({ chat: chat.ulid }),
                chat,
            }),
        );

        expect(view.byTestId('count')?.textContent).toBe('2');

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: { ...chat, unreadByAdmin: 0 },
            }),
        );

        expect(view.byTestId('count')?.textContent).toBe('0');
    });

    it('mirrors the websocket status into the store (the "reconnecting" indicator reads it)', async () => {
        const { api } = fakeApi();
        const view = await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <Badge />
                <Connection />
            </WhatsAppRealtimeProvider>,
        );

        expect(view.byTestId('connection')?.textContent).toBe('connected');

        await act(async () => fakeEcho.setConnection('reconnecting'));

        expect(view.byTestId('connection')?.textContent).toBe('reconnecting');
    });

    it('without a websocket it says so, subscribes to nothing and keeps the badge by REST', async () => {
        const { api, chats } = fakeApi([makeWaChat({ unreadByAdmin: 1 })]);
        const view = await render(
            <WhatsAppRealtimeProvider admin sockets={false} api={api}>
                <Badge />
                <Connection />
            </WhatsAppRealtimeProvider>,
        );

        expect(view.byTestId('connection')?.textContent).toBe('unavailable');
        expect(view.byTestId('count')?.textContent).toBe('1');
        expect(chats).toHaveBeenCalled();
        expect(fakeEcho.channels()).toEqual([]);
    });

    it('stops with the last consumer: the subscriptions are released', async () => {
        const { api } = fakeApi();
        const view = await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <Badge />
            </WhatsAppRealtimeProvider>,
        );

        expect(fakeEcho.channels()).toContain(CHANNEL);

        await view.unmount();

        expect(fakeEcho.channels()).toEqual([]);
    });

    it('looks again when the tab comes back to the foreground', async () => {
        const { api, chats } = fakeApi();

        await render(
            <WhatsAppRealtimeProvider admin sockets api={api}>
                <Badge />
            </WhatsAppRealtimeProvider>,
        );
        chats.mockClear();

        await act(async () => {
            document.dispatchEvent(new Event('visibilitychange'));
        });

        expect(chats).toHaveBeenCalledTimes(1);
    });
});
