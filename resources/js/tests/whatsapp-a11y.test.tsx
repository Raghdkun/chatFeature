/**
 * Accessibility of the WhatsApp screens with axe-core, run in jsdom against the rendered pages and with their dialogs open. jsdom has no
 * layout, so the rules that need one (colour contrast, target size) are left to the browser run; everything structural is checked:
 * names, labels, roles, landmarks, list structure, duplicate ids, ARIA validity.
 */
import '@/tests/dom-polyfills';
import axe from 'axe-core';
import { useReducer } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    builderReducer,
    createBuilderState,
} from '@/components/widgets/builder-state';
import { WhatsAppTab } from '@/components/widgets/builder/whatsapp-tab';
import { fakeTime, fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import { WA_SETTINGS_DEFAULTS } from '@/lib/whatsapp-api/client';
import {
    makeLinkedWaChat,
    makeWaChat,
    makeWaChatDetail,
    makeWaDocument,
    makeWaImage,
    makeWaMessage,
    makeWaReply,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import type { WaChat } from '@/lib/whatsapp/types';
import WhatsAppInbox from '@/pages/whatsapp/inbox';
import WhatsAppSettings from '@/pages/settings/whatsapp';
import { body, fill } from '@/tests/dom';
import { makeBuilderData, makeWidget } from '@/tests/fixtures';
import { click } from '@/tests/render';
import {
    renderWa,
    useWaBackend,
    waitFor,
    type WaRender,
} from '@/tests/whatsapp-kit';
import type { WidgetBuilderData } from '@/types/widgets';

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

async function violations(root: Element = document.body): Promise<string[]> {
    const result = await axe.run(root, {
        rules: {
            // Need real layout (jsdom has none): the browser run covers them.
            'color-contrast': { enabled: false },
            'target-size': { enabled: false },
            // The page-level landmark rules apply to a whole document, not to a fragment mounted in a test.
            region: { enabled: false },
            'landmark-one-main': { enabled: false },
            'page-has-heading-one': { enabled: false },
        },
    });

    return result.violations.map(
        (violation) =>
            `${violation.id}: ${violation.help} (${violation.nodes
                .slice(0, 3)
                .map((node) => node.target.join(' '))
                .join(' | ')})`,
    );
}

const SESSION = makeWaSession({
    ulid: fakeUlid(5000),
    name: 'support-main',
    status: 'ready',
    phone: '+491701234567',
    maskedPhone: '+49•••••••4567',
    linkedWidgetsCount: 2,
});
const CHAT_ULID = fakeUlid(6001);
const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

const ref = { ulid: SESSION.ulid, name: SESSION.name };

function chats(): WaChat[] {
    return [
        makeWaChat({
            ulid: CHAT_ULID,
            pushName: 'Vera Visitor',
            phone: '+4915112345678',
            session: ref,
            unreadByAdmin: 2,
            lastMessagePreview: 'Where is my order?',
        }),
        makeLinkedWaChat({
            ulid: fakeUlid(6002),
            pushName: 'Omar',
            session: ref,
            unreadByAdmin: 0,
        }),
        makeWaChat({
            ulid: fakeUlid(6003),
            pushName: 'Archived Ann',
            session: ref,
            status: 'archived',
        }),
    ];
}

async function inbox(selected: boolean): Promise<WaRender> {
    const list = chats();
    const open = list[0];
    const messages = [
        makeWaMessage({
            chat: open.ulid,
            body: 'Where is my order?',
            createdAt: fakeTime(10),
        }),
        makeWaReply({
            chat: open.ulid,
            body: 'Let me check.',
            status: 'read',
            createdAt: fakeTime(20),
        }),
        makeWaImage({ chat: open.ulid, createdAt: fakeTime(30) }),
        makeWaDocument({ chat: open.ulid, createdAt: fakeTime(40) }),
        makeWaReply({
            chat: open.ulid,
            body: 'It did not go out',
            status: 'failed',
            error: 'The session is not connected.',
            createdAt: fakeTime(50),
        }),
    ];

    list.forEach((c) => backend.current.state.chats.set(c.ulid, c));
    backend.current.state.messages.set(open.ulid, messages);
    backend.current.state.settings = {
        ...backend.current.state.settings,
        replyOnlyToInbound: false,
    };

    return renderWa(
        <WhatsAppInbox
            sessions={[SESSION]}
            chats={list}
            meta={{ next_cursor: null, unread_chats: 1 }}
            widgets={[{ ulid: fakeUlid(9000), name: 'Main site' }]}
            categories={[{ slug: 'billing', label: 'Billing' }] as never}
            whatsappEnabled
            selected={
                selected
                    ? {
                          detail: makeWaChatDetail({ chat: open }),
                          messages,
                          meta: { next_cursor: null, prev_cursor: null },
                      }
                    : null
            }
        />,
    );
}

describe('the inbox', () => {
    it('the list with its search and filters has no violations', async () => {
        await inbox(false);
        await waitFor(() =>
            expect(byTestId(`wa-chat-row-${CHAT_ULID}`)).not.toBeNull(),
        );

        expect(await violations()).toEqual([]);
    });

    it('the list while searching with nothing found has no violations', async () => {
        await inbox(false);
        await fill(byTestId('wa-search') as HTMLInputElement, 'zzzz');
        await waitFor(() =>
            expect(byTestId('wa-list-no-match')).not.toBeNull(),
        );

        expect(await violations()).toEqual([]);
    });

    it('an open chat (every kind of bubble, a failed reply, the composer) has no violations', async () => {
        await inbox(true);

        expect(byTestId('wa-chat-view')).not.toBeNull();
        expect(await violations()).toEqual([]);
    });

    it('the chat details sheet has no violations', async () => {
        await inbox(true);
        await click(byTestId('wa-chat-info'));
        await waitFor(() => expect(byTestId('wa-details')).not.toBeNull());

        expect(await violations()).toEqual([]);
    });

    it('a chat the customer did not start (composer blocked) has no violations', async () => {
        backend.current.state.settings = {
            ...backend.current.state.settings,
            replyOnlyToInbound: true,
        };

        const list = [
            makeWaChat({
                ulid: CHAT_ULID,
                session: ref,
                inboundInitiated: false,
            }),
        ];

        list.forEach((c) => backend.current.state.chats.set(c.ulid, c));
        backend.current.state.messages.set(CHAT_ULID, []);
        await renderWa(
            <WhatsAppInbox
                sessions={[SESSION]}
                chats={list}
                meta={{ next_cursor: null, unread_chats: 0 }}
                widgets={[]}
                categories={[]}
                whatsappEnabled
                selected={{
                    detail: makeWaChatDetail({ chat: list[0] }),
                    messages: [],
                    meta: { next_cursor: null, prev_cursor: null },
                }}
            />,
        );
        await waitFor(() =>
            expect(byTestId('wa-composer-disabled')).not.toBeNull(),
        );

        expect(await violations()).toEqual([]);
    });
});

describe('Settings > WhatsApp', () => {
    const sessions = () => [
        SESSION,
        makeWaSession({
            ulid: fakeUlid(5001),
            name: 'sales-line',
            status: 'qr',
            phone: null,
            maskedPhone: null,
        }),
        makeWaSession({
            ulid: fakeUlid(5002),
            name: 'broken-line',
            status: 'failed',
            phone: null,
            maskedPhone: null,
            lastError: 'OpenWA refused the webhook address.',
        }),
    ];

    async function settings(): Promise<WaRender> {
        const list = sessions();

        list.forEach((s) => backend.current.state.sessions.set(s.ulid, s));
        backend.current.state.qr.set(fakeUlid(5001), PNG);
        backend.current.state.settings = {
            ...WA_SETTINGS_DEFAULTS,
            enabled: true,
            baseUrl: 'http://127.0.0.1:2785',
            hasApiKey: true,
        };

        return renderWa(
            <WhatsAppSettings
                sessions={list}
                settings={backend.current.state.settings}
                widgets={[]}
                privateHostsAllowed={false}
            />,
        );
    }

    it('the whole page, with sessions in every state, has no violations', async () => {
        await settings();

        expect(await violations()).toEqual([]);
    });

    it('the QR dialog has no violations', async () => {
        await settings();
        await click(byTestId(`wa-session-qr-${fakeUlid(5001)}`));
        await waitFor(() => expect(byTestId('wa-qr-image')).not.toBeNull());

        expect(await violations()).toEqual([]);
    });

    /** The dialog's own Cancel button (`AlertDialogCancel`, no test id): found by its text inside the dialog. */
    async function cancel(dialog: string): Promise<void> {
        const button = Array.from(
            byTestId(dialog)?.querySelectorAll('button') ?? [],
        ).find((candidate) => candidate.textContent?.trim() === 'Cancel');

        await click((button as HTMLElement | undefined) ?? null);
        await waitFor(() => expect(byTestId(dialog)).toBeNull());
    }

    it('the stop, delete and webhook confirmations have no violations', async () => {
        await settings();

        await click(byTestId(`wa-session-stop-${SESSION.ulid}`));
        expect(byTestId('wa-stop-dialog')).not.toBeNull();
        expect(await violations()).toEqual([]);
        await cancel('wa-stop-dialog');

        await click(byTestId(`wa-session-webhook-reregister-${SESSION.ulid}`));
        expect(byTestId('wa-webhook-dialog')).not.toBeNull();
        expect(await violations()).toEqual([]);
        await cancel('wa-webhook-dialog');

        await click(byTestId(`wa-session-delete-${SESSION.ulid}`));
        expect(byTestId('wa-delete-dialog')).not.toBeNull();
        expect(await violations()).toEqual([]);
    });

    it('the sending limits dialog (global and own limits) has no violations', async () => {
        await settings();
        await click(byTestId(`wa-session-pacing-${SESSION.ulid}`));
        await waitFor(() =>
            expect(byTestId('wa-pacing-dialog')).not.toBeNull(),
        );
        expect(await violations()).toEqual([]);

        await click(byTestId('wa-pacing-global'));
        expect(await violations()).toEqual([]);
    });

    it('the connection card with a test result and a field error has no violations', async () => {
        await settings();
        await click(byTestId('wa-connection-test'));
        await waitFor(() => expect(byTestId('wa-test-result')).not.toBeNull());
        expect(await violations()).toEqual([]);

        backend.current.state.connection = {
            ok: false,
            reason: 'unreachable',
            message: 'Could not connect.',
        };
        await click(byTestId('wa-connection-test'));
        await waitFor(() =>
            expect(byTestId('wa-test-result')?.dataset.status).toBe('failed'),
        );

        expect(await violations()).toEqual([]);
    });
});

describe('the widget builder tab', () => {
    function Harness({ data }: { data: WidgetBuilderData }) {
        const [state, dispatch] = useReducer(
            builderReducer,
            data,
            createBuilderState,
        );

        return <WhatsAppTab state={state} dispatch={dispatch} />;
    }

    it('has no violations with a connected number, and without any session', async () => {
        const data = makeBuilderData({ widget: makeWidget({ ulid: 'w1' }) });

        data.draft_config.features.whatsapp = true;
        backend.current.state.sessions.set(SESSION.ulid, SESSION);
        backend.current.state.widgetLinks.set('w1', SESSION.ulid);
        backend.current.state.settings = {
            ...WA_SETTINGS_DEFAULTS,
            enabled: true,
        };

        await renderWa(<Harness data={data} />);
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
        expect(await violations()).toEqual([]);
    });

    it('has no violations when no session exists yet', async () => {
        const data = makeBuilderData({ widget: makeWidget({ ulid: 'w1' }) });

        data.draft_config.features.whatsapp = true;
        backend.current.state.settings = {
            ...WA_SETTINGS_DEFAULTS,
            enabled: true,
        };

        await renderWa(<Harness data={data} />);
        await waitFor(() =>
            expect(byTestId('builder-whatsapp-session')).not.toBeNull(),
        );
        expect(await violations()).toEqual([]);
    });
});
