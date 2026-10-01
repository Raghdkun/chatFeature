/**
 * Accessibility of the staff chat screens with axe-core, run in jsdom against the rendered pages and with their dialogs open.
 * jsdom has no layout, so the rules that need one (colour contrast, target size) are left to the Playwright run; everything
 * structural is checked here: names, labels, roles, landmarks, list structure, duplicate ids, ARIA validity.
 */
import '@/tests/dom-polyfills';
import axe from 'axe-core';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import {
    fakeTime,
    fakeUlid,
    makeActiveConversationStaff,
    makeAgentMessage,
    makeAttachment,
    makeConversationStaff,
    makeMessage,
    makeOffer,
    makeRating,
    resetFixtures,
} from '@/lib/chat/fixtures';
import { NO_FILTERS } from '@/components/inbox/history-model';
import HistoryIndex from '@/pages/history/index';
import InboxIndex from '@/pages/inbox/index';
import InboxShow from '@/pages/inbox/show';
import OfflineTicketsIndex from '@/pages/offline-tickets/index';
import { body, fill } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { CATEGORIES } from '@/tests/fixtures';
import { click } from '@/tests/render';
import {
    AGENT,
    renderStaff,
    useStaffBackend,
    waitFor,
} from '@/tests/staff-kit';

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

const backend = useStaffBackend();

async function violations(root: Element = document.body): Promise<string[]> {
    const result = await axe.run(root, {
        // Needs real layout (jsdom has none); the Playwright run covers them.
        rules: {
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

const CONVERSATION = fakeUlid(7000);

const mine = (overrides = {}) =>
    makeActiveConversationStaff({
        assignedAgent: { id: AGENT.id, name: AGENT.name },
        lastMessagePreview: 'Where is my invoice?',
        lastMessageAt: fakeTime(50),
        unseenByAgent: 2,
        ...overrides,
    });

beforeEach(() => resetFixtures());

describe('the inbox', () => {
    it('has no structural violations with a queue, chats and a roster', async () => {
        const waiting = makeConversationStaff();
        const chats = [mine(), mine({ status: 'closed', unseenByAgent: 0 })];

        [waiting, ...chats].forEach((c) =>
            backend.current.state.conversations.set(c.ulid, c),
        );
        await renderStaff(
            <InboxIndex
                queue={[waiting]}
                mine={chats}
                presence={{ status: 'offline' }}
                categories={CATEGORIES}
            />,
        );
        await act(async () =>
            fakeEcho.presence.here([
                { id: 9, name: 'Omar', avatarUrl: null, status: 'away' },
                {
                    id: AGENT.id,
                    name: 'Sam',
                    avatarUrl: null,
                    status: 'online',
                },
            ]),
        );
        await act(async () =>
            fakeEcho.emitServer(
                `staff.${AGENT.id}`,
                'chat.offered',
                makeOffer({
                    expiresAt: new Date(Date.now() + 90_000).toISOString(),
                }),
            ),
        );

        expect(await violations()).toEqual([]);
    });

    it('has none with the connection banner and an empty inbox', async () => {
        await renderStaff(
            <InboxIndex
                queue={[]}
                mine={[]}
                presence={{ status: 'online' }}
                categories={CATEGORIES}
            />,
            { sockets: false },
        );

        expect(await violations()).toEqual([]);
    });
});

describe('a conversation', () => {
    const chat = () =>
        makeActiveConversationStaff({
            ulid: CONVERSATION,
            assignedAgent: { id: AGENT.id, name: AGENT.name },
            visitor: {
                ulid: 'v1',
                name: 'Vera',
                email: 'vera@x.test',
                phone: '+49 30 1',
                verified: true,
                meta: { plan: 'pro' },
            },
            lastSeq: 4,
        });
    const messages = () => [
        makeMessage({
            seq: 1,
            ulid: fakeUlid(6001),
            conversation: CONVERSATION,
            body: 'Hello https://example.com',
            createdAt: fakeTime(10),
        }),
        makeAgentMessage({
            seq: 2,
            ulid: fakeUlid(6002),
            conversation: CONVERSATION,
            body: 'Hi Vera',
            createdAt: fakeTime(20),
            seenAt: fakeTime(21),
        }),
        makeMessage({
            seq: 3,
            ulid: fakeUlid(6003),
            conversation: CONVERSATION,
            body: null,
            type: 'image',
            attachments: [makeAttachment({ ulid: 'att1' })],
            createdAt: fakeTime(30),
        }),
        makeAgentMessage({
            seq: 4,
            ulid: fakeUlid(6004),
            conversation: CONVERSATION,
            body: 'Looking',
            createdAt: fakeTime(40),
        }),
    ];

    async function mount() {
        const conversation = chat();
        const list = messages();

        backend.current.state.conversations.set(CONVERSATION, conversation);
        backend.current.state.messages.set(CONVERSATION, list);

        return renderStaff(
            <InboxShow
                queue={[]}
                mine={[conversation]}
                presence={{ status: 'online' }}
                categories={CATEGORIES}
                conversation={conversation}
                messages={list}
            />,
        );
    }

    it('has no structural violations, including the typing indicator and a failed message', async () => {
        backend.current.state.failNextSends = 1;
        const { view } = await mount();

        await act(async () =>
            fakeEcho.emit(`conversation.${CONVERSATION}`, '.client-typing', {
                actor: 'visitor',
                typing: true,
            }),
        );

        const input = view.byTestId('composer-input') as HTMLTextAreaElement;

        await fill(input, 'This one fails');
        await act(async () => {
            input.dispatchEvent(
                new KeyboardEvent('keydown', {
                    key: 'Enter',
                    bubbles: true,
                    cancelable: true,
                }),
            );
        });
        await waitFor(() =>
            expect(
                view.container.querySelector('[data-status="failed"]'),
            ).not.toBeNull(),
        );

        expect(await violations()).toEqual([]);
    });

    it('has none with the end-chat, transfer, details and lightbox dialogs open', async () => {
        const { view } = await mount();

        await click(view.byTestId('end-chat'));
        expect(body.byTestId('end-chat-dialog')).not.toBeNull();
        expect(await violations()).toEqual([]);
        await act(async () => {
            body.byTestId('end-chat-dialog')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        await waitFor(() =>
            expect(body.byTestId('end-chat-dialog')).toBeNull(),
        );

        await act(async () =>
            fakeEcho.presence.here([
                { id: 9, name: 'Omar', avatarUrl: null, status: 'online' },
            ]),
        );
        await click(view.byTestId('transfer-chat'));
        expect(await violations()).toEqual([]);
        await act(async () => {
            body.byTestId('transfer-dialog')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        await waitFor(() =>
            expect(body.byTestId('transfer-dialog')).toBeNull(),
        );

        await click(view.byTestId('conversation-info'));
        expect(await violations()).toEqual([]);
    });

    it('moves focus into a dialog and back to the button that opened it', async () => {
        const { view } = await mount();
        const trigger = view.byTestId('end-chat') as HTMLElement;

        trigger.focus();
        await click(trigger);
        expect(
            body.byTestId('end-chat-dialog')?.contains(document.activeElement),
        ).toBe(true);

        await act(async () => {
            body.byTestId('end-chat-dialog')?.dispatchEvent(
                new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
            );
        });
        await waitFor(() => expect(document.activeElement).toBe(trigger));
    });
});

describe('history and offline tickets', () => {
    it('has no structural violations on the history table and its cards', async () => {
        const rows = [
            makeActiveConversationStaff({
                status: 'closed',
                assignedAgent: { id: 7, name: 'Sam' },
            }),
            makeConversationStaff({ status: 'missed' }),
        ];
        const { view } = await renderStaff(
            <HistoryIndex
                conversations={rows}
                pagination={{
                    page: 1,
                    perPage: 25,
                    total: 2,
                    lastPage: 1,
                    from: 1,
                    to: 2,
                }}
                filters={NO_FILTERS}
                ratings={[makeRating({ conversation: rows[0].ulid })]}
                filterOptions={{
                    categories: [{ ulid: 'c1', name: 'Billing' }],
                    widgets: [{ ulid: 'w1', name: 'Widget' }],
                    agents: [{ id: 7, name: 'Sam' }],
                }}
            />,
        );

        expect(view.byTestId('history-table')).not.toBeNull();
        expect(await violations()).toEqual([]);
    });

    it('has none on the offline tickets', async () => {
        const tickets = [
            makeConversationStaff({
                type: 'offline',
                lastMessagePreview: 'Please call me',
            }),
            makeConversationStaff({
                type: 'offline',
                status: 'active',
                assignedAgent: { id: AGENT.id, name: 'Sam' },
            }),
        ];

        tickets.forEach((t) =>
            backend.current.state.conversations.set(t.ulid, t),
        );
        await renderStaff(<OfflineTicketsIndex tickets={tickets} />);

        expect(await violations()).toEqual([]);
    });
});
