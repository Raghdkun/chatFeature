import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { ApiError } from '@/lib/api-client';
import { resetFixtures } from '@/lib/chat/fixtures';
import {
    BACKGROUND_POLL_INTERVAL_MS,
    createWaController,
    POLL_INTERVAL_MS,
    UNREAD_PAGE_LIMIT,
} from '@/lib/realtime/whatsapp/controller';
import { createWaLiveStore } from '@/lib/realtime/whatsapp/store';
import type { WaApi } from '@/lib/whatsapp-api/client';
import {
    makeWaChat,
    makeWaMessage,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import type { WaChat } from '@/lib/whatsapp/types';

function setup(chats: WaChat[] = []) {
    const store = createWaLiveStore();
    const chatsCall = vi.fn(async () => ({ chats, nextCursor: null }));
    const api = { chats: chatsCall } as unknown as WaApi;
    const controller = createWaController({ store, api });

    return { store, controller, chatsCall };
}

beforeEach(() => {
    vi.useFakeTimers();
    resetFixtures();
    resetWaFixtures();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('events', () => {
    it('routes a created message to the chat list and the open transcript', () => {
        const { store, controller } = setup();
        const chat = makeWaChat({ unreadByAdmin: 1 });
        const message = makeWaMessage({ chat: chat.ulid });

        store.dispatch({
            type: 'messagesLoaded',
            chat: chat.ulid,
            messages: [],
        });
        controller.handle('wa.message.created', { v: 1, message, chat });

        expect(store.getState().chats[chat.ulid].unreadByAdmin).toBe(1);
        expect(store.getState().messages[chat.ulid]).toEqual([message]);
    });

    it('routes an ack, a chat change and a session change', () => {
        const { store, controller } = setup();
        const chat = makeWaChat();
        const session = makeWaSession({ status: 'qr' });

        controller.handle('wa.chat.updated', { v: 1, chat });
        controller.handle('wa.session.status', { v: 1, session });

        expect(store.getState().chats[chat.ulid]).toEqual(chat);
        expect(store.getState().sessions[session.ulid]).toEqual(session);

        const reply = makeWaMessage({
            chat: chat.ulid,
            direction: 'out',
            status: 'sent',
        });

        store.dispatch({
            type: 'messagesLoaded',
            chat: chat.ulid,
            messages: [reply],
        });
        controller.handle('wa.message.updated', {
            v: 1,
            message: { ...reply, status: 'delivered' },
        });

        expect(store.getState().messages[chat.ulid][0].status).toBe(
            'delivered',
        );
    });

    it('ignores a payload version it does not understand', () => {
        const { store, controller } = setup();

        controller.handle('wa.chat.updated', { v: 2, chat: makeWaChat() });

        expect(store.getState().chats).toEqual({});
    });
});

describe('the unread summary', () => {
    it('reads the unread open chats when started and applies them', async () => {
        const unread = makeWaChat({ unreadByAdmin: 3 });
        const { store, controller, chatsCall } = setup([unread]);

        controller.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(chatsCall).toHaveBeenCalledWith({
            status: 'open',
            unread: true,
            limit: UNREAD_PAGE_LIMIT,
        });
        expect(store.getState().chats[unread.ulid].unreadByAdmin).toBe(3);
        controller.stop();
    });

    it('runs one request at a time and once more when asked meanwhile', async () => {
        const { controller, chatsCall } = setup();
        let release: () => void = () => undefined;

        chatsCall.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    release = () => resolve({ chats: [], nextCursor: null });
                }),
        );

        void controller.sync();
        void controller.sync();
        void controller.sync();
        expect(chatsCall).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(0);

        expect(chatsCall).toHaveBeenCalledTimes(2);
    });

    it('swallows a failed read: the next trigger tries again', async () => {
        const { controller, chatsCall } = setup();

        chatsCall.mockRejectedValueOnce(
            new ApiError({ status: 0, code: 'network', message: 'down' }),
        );
        await controller.sync();
        await controller.sync();

        expect(chatsCall).toHaveBeenCalledTimes(2);
    });
});

describe('the polling fallback', () => {
    it('polls every 15 s while a WhatsApp page is open and the websocket is not connected', async () => {
        const { controller, chatsCall } = setup();

        controller.setConnection('reconnecting');
        controller.start();
        const unwatch = controller.watch();
        await vi.advanceTimersByTimeAsync(0);
        chatsCall.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(chatsCall).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS);
        expect(chatsCall).toHaveBeenCalledTimes(2);

        unwatch();
        controller.stop();
    });

    it('polls only once a minute for the badge alone', async () => {
        const { controller, chatsCall } = setup();

        controller.setConnection('unavailable');
        controller.start();
        await vi.advanceTimersByTimeAsync(0);
        chatsCall.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 2);
        expect(chatsCall).not.toHaveBeenCalled();

        await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS);
        expect(chatsCall).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('does not poll while the websocket is connected, and reads once when it comes back', async () => {
        const { controller, chatsCall } = setup();

        controller.setConnection('connected');
        controller.start();
        controller.watch();
        await vi.advanceTimersByTimeAsync(0);
        chatsCall.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 3);
        expect(chatsCall).not.toHaveBeenCalled();

        controller.setConnection('reconnecting');
        controller.setConnection('connected');
        await vi.advanceTimersByTimeAsync(0);
        expect(chatsCall).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('stops polling for good after a 403 / 404 and tries again when the tab returns', async () => {
        const { controller, chatsCall } = setup();

        chatsCall.mockRejectedValueOnce(
            new ApiError({ status: 403, code: 'forbidden', message: 'No.' }),
        );
        controller.setConnection('unavailable');
        controller.start();
        controller.watch();
        await vi.advanceTimersByTimeAsync(0);
        chatsCall.mockClear();

        await vi.advanceTimersByTimeAsync(POLL_INTERVAL_MS * 4);
        expect(chatsCall).not.toHaveBeenCalled();

        controller.wake();
        await vi.advanceTimersByTimeAsync(0);
        expect(chatsCall).toHaveBeenCalledTimes(1);
        controller.stop();
    });

    it('does nothing after stop', async () => {
        const { controller, chatsCall } = setup();

        controller.setConnection('unavailable');
        controller.start();
        controller.stop();
        chatsCall.mockClear();

        await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_INTERVAL_MS * 2);
        controller.wake();

        expect(chatsCall).not.toHaveBeenCalled();
    });
});
