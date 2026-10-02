/**
 * The inbox PAGE with the Inertia props track 6A's controller sends (`docs/rest-api.md`, "Inertia pages"): `whatsapp/inbox` for the list
 * and for a selected chat. The pieces (list, transcript, composer) have their own files; this one pins the page's own decisions.
 */
import '@/tests/dom-polyfills';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fakeTime, fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import {
    makeWaChat,
    makeWaChatDetail,
    makeWaMessage,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import type { WaChat } from '@/lib/whatsapp/types';
import WhatsAppInbox from '@/pages/whatsapp/inbox';
import type { WaInboxPageProps } from '@/types/whatsapp';
import { body } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import {
    AGENT,
    renderWa,
    useWaBackend,
    waitFor,
    type WaViewer,
} from '@/tests/whatsapp-kit';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('@laravel/echo-react', async () =>
    (await import('@/tests/fake-echo')).fakeEchoModule(),
);
vi.mock('sonner', () => ({
    toast: Object.assign(vi.fn(), {
        success: vi.fn(),
        error: vi.fn(),
        dismiss: vi.fn(),
    }),
}));

vi.setConfig({ testTimeout: 20_000 });

const backend = useWaBackend();
const byTestId = body.byTestId;

const SESSION = makeWaSession({ ulid: fakeUlid(5000), name: 'support-main' });
const CHAT_ULID = fakeUlid(6000);

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

const chat = (overrides: Partial<WaChat> = {}) =>
    makeWaChat({
        ulid: CHAT_ULID,
        pushName: 'Vera Visitor',
        session: { ulid: SESSION.ulid, name: SESSION.name },
        ...overrides,
    });

/** The props exactly as `WhatsAppPageController` builds them (snake_case `meta`, camelCase everything else). */
function props(overrides: Partial<WaInboxPageProps> = {}): WaInboxPageProps {
    return {
        sessions: [SESSION],
        chats: [],
        meta: { next_cursor: null, unread_chats: 0 },
        widgets: [],
        categories: [],
        whatsappEnabled: true,
        selected: null,
        ...overrides,
    };
}

function selectedChat(current: WaChat) {
    return {
        detail: makeWaChatDetail({ chat: current }),
        messages: [
            makeWaMessage({
                ulid: fakeUlid(7001),
                chat: current.ulid,
                body: 'Hello, is the order shipped?',
                createdAt: fakeTime(10),
                waTimestamp: fakeTime(10),
            }),
        ],
        meta: { next_cursor: null, prev_cursor: null },
    };
}

async function open(
    pageProps: WaInboxPageProps,
    viewer?: WaViewer,
    seed: WaChat[] = pageProps.chats,
) {
    seed.forEach((c) => backend.current.state.chats.set(c.ulid, c));
    backend.current.state.messages.set(
        CHAT_ULID,
        pageProps.selected?.messages ?? [],
    );

    return renderWa(<WhatsAppInbox {...pageProps} />, { viewer });
}

const settingsReads = () =>
    backend.current.state.calls.filter(
        (call) =>
            call.method === 'GET' && call.path === '/api/v1/whatsapp/settings',
    );

describe('the inbox page', () => {
    it('shows the list and an empty conversation pane when no chat is selected, without asking for the settings', async () => {
        await open(props({ chats: [chat()] }));

        expect(byTestId('wa-inbox')).not.toBeNull();
        expect(byTestId(`wa-chat-row-${CHAT_ULID}`)).not.toBeNull();
        expect(byTestId('wa-empty-conversation')).not.toBeNull();
        expect(byTestId('wa-chat-view')).toBeNull();

        await waitFor(() => expect(fakeEcho.channels().length).toBe(1));
        expect(settingsReads()).toHaveLength(0);
    });

    it('offers "load more" exactly when the server gave a cursor for the second page', async () => {
        const first = await open(props({ chats: [chat()] }));

        expect(byTestId('wa-list-more')).toBeNull();
        await first.view.unmount();

        await open(
            props({
                chats: [chat()],
                meta: { next_cursor: 'opaque-cursor', unread_chats: 0 },
            }),
        );
        expect(byTestId('wa-list-more')).not.toBeNull();
    });

    it('shows the selected chat with its transcript (props.selected) next to the list', async () => {
        const current = chat();

        await open(
            props({ chats: [current], selected: selectedChat(current) }),
        );

        expect(byTestId('wa-chat-view')).not.toBeNull();
        expect(byTestId('wa-chat-view')?.textContent).toContain(
            'Hello, is the order shipped?',
        );
        expect(byTestId('wa-empty-conversation')).toBeNull();
        expect(byTestId(`wa-chat-row-${CHAT_ULID}`)).not.toBeNull();
    });

    it('asks once for whatsapp.reply_only_to_inbound when a chat is open, and the composer says the customer has to write first', async () => {
        const current = chat({ inboundInitiated: false });

        backend.current.state.settings = {
            ...backend.current.state.settings,
            replyOnlyToInbound: true,
        };
        await open(
            props({ chats: [current], selected: selectedChat(current) }),
        );

        await waitFor(() =>
            expect(byTestId('wa-composer-disabled')?.dataset.reason).toBe(
                'not_inbound',
            ),
        );
        expect(settingsReads()).toHaveLength(1);
    });

    it('lets the administrator write when the setting is off', async () => {
        const current = chat({ inboundInitiated: false });

        backend.current.state.settings = {
            ...backend.current.state.settings,
            replyOnlyToInbound: false,
        };
        await open(
            props({ chats: [current], selected: selectedChat(current) }),
        );

        await waitFor(() => expect(settingsReads()).toHaveLength(1));
        expect(byTestId('wa-composer-input')).not.toBeNull();
        expect(byTestId('wa-composer-disabled')).toBeNull();
    });

    it('leaves the decision to the API when the settings cannot be read', async () => {
        const current = chat({ inboundInitiated: false });

        backend.server.use(
            http.get('/api/v1/whatsapp/settings', () => HttpResponse.error()),
        );
        await open(
            props({ chats: [current], selected: selectedChat(current) }),
        );

        await waitFor(() => expect(byTestId('wa-chat-view')).not.toBeNull());
        expect(byTestId('wa-composer-input')).not.toBeNull();
    });

    it('draws nothing for an agent (a stale tab), sends no request and joins no channel', async () => {
        const current = chat();

        await open(
            props({ chats: [current], selected: selectedChat(current) }),
            AGENT,
        );

        expect(byTestId('whatsapp-forbidden')).not.toBeNull();
        expect(byTestId('wa-inbox')).toBeNull();
        expect(byTestId('wa-chat-view')).toBeNull();
        expect(document.body.textContent).not.toContain('Vera Visitor');
        expect(document.body.textContent).not.toContain(
            'Hello, is the order shipped?',
        );
        expect(backend.current.state.calls).toHaveLength(0);
        expect(fakeEcho.channels()).toEqual([]);
    });
});
