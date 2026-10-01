import '@/tests/dom-polyfills';
import { act } from 'react';
import { toast } from 'sonner';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import {
    fakeTime,
    makeConversationStaff,
    resetFixtures,
} from '@/lib/chat/fixtures';
import type { ConversationStaff } from '@/lib/chat/types';
import OfflineTicketsIndex from '@/pages/offline-tickets/index';
import { body } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { routerMock } from '@/tests/inertia-mock';
import { click } from '@/tests/render';
import {
    ADMIN,
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

const backend = useStaffBackend();

const ticket = (overrides: Partial<ConversationStaff> = {}) =>
    makeConversationStaff({
        type: 'offline',
        status: 'queued',
        visitor: {
            ulid: 'v1',
            name: 'Nour',
            email: 'nour@example.com',
            phone: null,
            verified: false,
            meta: {},
        },
        category: { slug: 'billing', label: 'Billing' },
        lastMessagePreview: 'I was charged twice',
        createdAt: fakeTime(0),
        ...overrides,
    });

/** The page's props and the REST API agree (the host re-reads the tickets over REST on start). */
const mount = (
    tickets: ConversationStaff[],
    options: Parameters<typeof renderStaff>[1] = {},
) => {
    tickets.forEach((t) => backend.current.state.conversations.set(t.ulid, t));

    return renderStaff(<OfflineTicketsIndex tickets={tickets} />, options);
};

beforeEach(() => resetFixtures());
afterEach(() => vi.clearAllMocks());

describe('the ticket list', () => {
    it('shows who wrote, what they said and how many are unclaimed', async () => {
        const a = ticket();
        const b = ticket({
            status: 'active',
            assignedAgent: { id: AGENT.id, name: 'Sam' },
        });
        const { view } = await mount([a, b]);
        const card = view.byTestId(`ticket-${a.ulid}`) as HTMLElement;

        expect(card.textContent).toContain('Nour');
        expect(card.textContent).toContain('nour@example.com');
        expect(card.textContent).toContain('I was charged twice');
        expect(card.textContent).toContain('Billing');
        expect(view.byTestId('tickets-count')?.textContent).toBe(
            '1 unclaimed ticket',
        );
        expect(
            (
                card.querySelector('a[href^="mailto:"]') as HTMLAnchorElement
            ).getAttribute('href'),
        ).toBe('mailto:nour@example.com');
    });

    it('says when nothing is waiting', async () => {
        const { view } = await mount([]);

        expect(view.byTestId('tickets-empty')?.textContent).toContain(
            'No open tickets',
        );
    });

    it('offers Claim on an unclaimed ticket and Reply / Close on a claimed one', async () => {
        const open = ticket();
        const mine = ticket({
            status: 'active',
            assignedAgent: { id: AGENT.id, name: 'Sam' },
        });
        const theirs = ticket({
            status: 'active',
            assignedAgent: { id: 9, name: 'Omar' },
        });
        const { view } = await mount([open, mine, theirs], { viewer: ADMIN });

        expect(view.byTestId(`ticket-claim-${open.ulid}`)).not.toBeNull();
        expect(view.byTestId(`ticket-reply-${open.ulid}`)?.textContent).toBe(
            'Open',
        );
        expect(view.byTestId(`ticket-claim-${mine.ulid}`)).toBeNull();
        expect(view.byTestId(`ticket-reply-${mine.ulid}`)?.textContent).toBe(
            'Reply',
        );
        expect(
            view.byTestId(`ticket-reply-${mine.ulid}`)?.getAttribute('href'),
        ).toBe(`/inbox/${mine.ulid}`);
        expect(view.byTestId(`ticket-close-${mine.ulid}`)).not.toBeNull();
        expect(view.byTestId(`ticket-${theirs.ulid}`)?.textContent).toContain(
            'Claimed by Omar',
        );
    });

    it('does not offer Claim to an admin who does not take chats', async () => {
        const open = ticket();
        const { view } = await mount([open], {
            viewer: { ...ADMIN, isAgent: false },
        });

        expect(view.byTestId(`ticket-claim-${open.ulid}`)).toBeNull();
        expect(view.byTestId(`ticket-reply-${open.ulid}`)).not.toBeNull();
    });
});

describe('claiming and closing', () => {
    it('claims a ticket and opens it for the reply', async () => {
        const open = ticket();

        const { view } = await mount([open]);

        await click(view.byTestId(`ticket-claim-${open.ulid}`));
        await waitFor(() =>
            expect(routerMock.visit).toHaveBeenCalledWith(
                `/inbox/${open.ulid}`,
            ),
        );

        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${open.ulid}/claim`,
            ),
        ).toHaveLength(1);
        expect(toast.success).toHaveBeenCalledWith('Ticket claimed');
    });

    it('stays on the page and says who got there first when the claim is lost', async () => {
        const open = ticket();

        backend.current.state.lostClaims.set(open.ulid, 'Omar');
        const { view } = await mount([open]);

        await click(view.byTestId(`ticket-claim-${open.ulid}`));
        await waitFor(() =>
            expect(toast).toHaveBeenCalledWith(
                'Taken by Omar',
                expect.anything(),
            ),
        );

        expect(routerMock.visit).not.toHaveBeenCalled();
    });

    it('closes a claimed ticket after a confirmation and removes it from the list', async () => {
        const mine = ticket({
            status: 'active',
            assignedAgent: { id: AGENT.id, name: 'Sam' },
        });

        const { view } = await mount([mine]);

        await click(view.byTestId(`ticket-close-${mine.ulid}`));
        expect(body.byTestId('end-chat-dialog')?.textContent).toContain(
            'Close this ticket?',
        );
        expect(
            backend.current.calls(
                'POST',
                `/api/v1/conversations/${mine.ulid}/close`,
            ),
        ).toHaveLength(0);

        await click(body.byTestId('end-chat-confirm'));
        await waitFor(() =>
            expect(view.byTestId(`ticket-${mine.ulid}`)).toBeNull(),
        );

        expect(toast.success).toHaveBeenCalledWith('Ticket closed');
        expect(view.byTestId('tickets-empty')).not.toBeNull();
    });
});

describe('realtime', () => {
    it('shows a ticket that arrives for an administrator, and announces it', async () => {
        const { view, sound } = await mount([], { viewer: ADMIN });
        const created = ticket();

        await act(async () =>
            fakeEcho.emitServer('admin', 'offline-ticket.created', {
                v: 1,
                conversation: created,
            }),
        );

        expect(view.byTestId(`ticket-${created.ulid}`)).not.toBeNull();
        expect(sound.play).toHaveBeenCalledWith('message');
        expect(toast).toHaveBeenCalledWith(
            'New offline ticket',
            expect.anything(),
        );
    });

    it('drops a ticket a colleague claimed or closed', async () => {
        const open = ticket();
        const { view } = await mount([open]);

        await act(async () =>
            fakeEcho.emitServer(`staff.${AGENT.id}`, 'conversation.updated', {
                v: 1,
                conversation: {
                    ...open,
                    status: 'active',
                    assignedAgent: { id: 9, name: 'Omar' },
                },
            }),
        );

        expect(view.byTestId(`ticket-${open.ulid}`)).toBeNull();
    });
});
