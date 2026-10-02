import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vite-plus/test';
import { fakeTime, fakeUlid, resetFixtures } from '@/lib/chat/fixtures';
import {
    makeLinkedWaChat,
    makeWaChat,
    makeWaSession,
    resetWaFixtures,
} from '@/lib/whatsapp/fixtures';
import type { WaChat } from '@/lib/whatsapp/types';
import { WaInboxShell } from '@/components/whatsapp/inbox-shell';
import { body, fill } from '@/tests/dom';
import { fakeEcho } from '@/tests/fake-echo';
import { click } from '@/tests/render';
import {
    renderWa,
    useWaBackend,
    waitFor,
    type WaRender,
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

// The network and the clock are real here: a loaded machine must not turn a slow tick into a failure.
vi.setConfig({ testTimeout: 20_000 });

const backend = useWaBackend();
const byTestId = body.byTestId;

const SESSION = makeWaSession({ ulid: fakeUlid(5000), name: 'support-main' });
const OTHER = makeWaSession({ ulid: fakeUlid(5001), name: 'sales-line' });

beforeEach(() => {
    resetFixtures();
    resetWaFixtures();
});

const ref = (session = SESSION) => ({ ulid: session.ulid, name: session.name });

function seed(...chats: WaChat[]): WaChat[] {
    chats.forEach((chat) => backend.current.state.chats.set(chat.ulid, chat));

    return chats;
}

/** The props of the inbox shell that every test needs and few care about. */
const SHELL = {
    cursor: null,
    widgets: [] as { ulid: string; name: string }[],
    categories: [] as { slug: string; label: string }[],
    whatsappEnabled: true,
};

async function mount(
    chats: WaChat[],
    options: {
        sessions?: (typeof SESSION)[];
        hasMore?: boolean;
        selected?: string | null;
        sockets?: boolean;
    } = {},
): Promise<WaRender> {
    seed(...chats);

    return renderWa(
        <WaInboxShell
            {...SHELL}
            chats={chats}
            hasMore={options.hasMore ?? false}
            sessions={options.sessions ?? [SESSION]}
            selectedUlid={options.selected ?? null}
        >
            <p data-testid="pane">the conversation pane</p>
        </WaInboxShell>,
        { sockets: options.sockets },
    );
}

const rows = () =>
    Array.from(
        document.body.querySelectorAll<HTMLElement>(
            '[data-testid^="wa-chat-row-"]',
        ),
    ).map((row) => row.dataset.testid?.replace('wa-chat-row-', '') ?? '');

/** The list's own reads (page size 50). The unread summary of the live store reads the same path with `limit=100`: not these. */
const listCalls = () =>
    backend.current.state.calls.filter(
        (call) =>
            call.method === 'GET' &&
            call.path === '/api/v1/whatsapp/chats' &&
            call.query.limit === '50',
    );

describe('the chat list', () => {
    it('shows each chat with its name, last message, age and unread badge, newest first', async () => {
        const [old, fresh] = [
            makeWaChat({
                pushName: 'Old Olga',
                lastMessagePreview: 'See you',
                lastMessageAt: fakeTime(10),
                session: ref(),
            }),
            makeWaChat({
                pushName: 'Fresh Fred',
                lastMessagePreview: 'Where is my order?',
                lastMessageAt: fakeTime(500),
                unreadByAdmin: 3,
                session: ref(),
            }),
        ];

        await mount([old, fresh]);

        expect(rows()).toEqual([fresh.ulid, old.ulid]);

        const first = byTestId(`wa-chat-row-${fresh.ulid}`);

        expect(first?.textContent).toContain('Fresh Fred');
        expect(first?.textContent).toContain('Where is my order?');
        expect(first?.getAttribute('data-unseen')).toBe('true');
        expect(byTestId(`wa-chat-unread-${fresh.ulid}`)?.textContent).toContain(
            '3',
        );
        expect(byTestId(`wa-chat-unread-${fresh.ulid}`)?.textContent).toContain(
            '3 unread messages',
        );
        expect(byTestId(`wa-chat-unread-${old.ulid}`)).toBeNull();
        expect(
            byTestId(`wa-chat-row-${fresh.ulid}`)?.getAttribute('href'),
        ).toBe(`/whatsapp/chats/${fresh.ulid}`);
    });

    it('names the number when WhatsApp gave no name, and says so when it has neither', async () => {
        const numbered = makeWaChat({ pushName: null, phone: '+491701112222' });
        const unknown = makeWaChat({ pushName: null, phone: null });

        await mount([numbered, unknown]);

        expect(byTestId(`wa-chat-row-${numbered.ulid}`)?.textContent).toContain(
            '+491701112222',
        );
        expect(byTestId(`wa-chat-row-${unknown.ulid}`)?.textContent).toContain(
            'Unknown contact',
        );
    });

    it('marks what links a chat to the website, and the ones that are not linked', async () => {
        const linked = makeLinkedWaChat({ session: ref() });
        const loose = makeWaChat({ session: ref() });

        await mount([linked, loose]);

        expect(byTestId(`wa-chat-link-${linked.ulid}`)?.textContent).toBe(
            'Main site · Sales',
        );
        expect(byTestId(`wa-chat-link-${loose.ulid}`)).toBeNull();
        expect(byTestId(`wa-chat-row-${loose.ulid}`)?.textContent).toContain(
            'Not linked to a website visit',
        );
    });

    it('names the session of a chat only when there is more than one', async () => {
        const chat = makeWaChat({ session: ref(OTHER) });
        const one = await mount([chat], { sessions: [SESSION] });

        expect(
            one.view.byTestId(`wa-chat-row-${chat.ulid}`)?.textContent,
        ).not.toContain('sales-line');
        await one.view.unmount();

        await mount([chat], { sessions: [SESSION, OTHER] });

        expect(byTestId(`wa-chat-row-${chat.ulid}`)?.textContent).toContain(
            'sales-line',
        );
    });

    it('says what an empty inbox is for', async () => {
        await mount([]);

        expect(byTestId('wa-list-empty')?.textContent).toContain(
            'No WhatsApp chats yet',
        );
    });

    it('highlights the open chat for assistive technology', async () => {
        const chat = makeWaChat({ session: ref() });

        await mount([chat], { selected: chat.ulid });

        expect(
            byTestId(`wa-chat-row-${chat.ulid}`)?.getAttribute('aria-current'),
        ).toBe('page');
        expect(byTestId('pane')).not.toBeNull();
    });
});

describe('live updates', () => {
    it('adds a new chat with its unread badge when a message arrives', async () => {
        const known = makeWaChat({
            session: ref(),
            lastMessageAt: fakeTime(10),
        });
        const incoming = makeWaChat({
            session: ref(),
            pushName: 'Newcomer',
            unreadByAdmin: 1,
            lastMessageAt: fakeTime(900),
            lastMessagePreview: 'Hello?',
        });

        await mount([known]);
        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.message.created', {
                v: 1,
                chat: incoming,
                message: {
                    ulid: fakeUlid(1),
                    chat: incoming.ulid,
                    direction: 'in',
                    type: 'text',
                    body: 'Hello?',
                    media: null,
                    status: 'received',
                    error: null,
                    sentBy: null,
                    waTimestamp: fakeTime(900),
                    createdAt: fakeTime(900),
                },
            }),
        );

        expect(rows()).toEqual([incoming.ulid, known.ulid]);
        expect(byTestId(`wa-chat-unread-${incoming.ulid}`)).not.toBeNull();
    });

    it('moves a chat to the top when it gets a message, and drops the unread badge when it is read elsewhere', async () => {
        const a = makeWaChat({
            session: ref(),
            lastMessageAt: fakeTime(10),
            unreadByAdmin: 2,
        });
        const b = makeWaChat({ session: ref(), lastMessageAt: fakeTime(20) });

        await mount([a, b]);
        expect(rows()).toEqual([b.ulid, a.ulid]);

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: { ...a, lastMessageAt: fakeTime(99), unreadByAdmin: 0 },
            }),
        );

        expect(rows()).toEqual([a.ulid, b.ulid]);
        expect(byTestId(`wa-chat-unread-${a.ulid}`)).toBeNull();
    });

    it('takes an archived chat out of the open list', async () => {
        const chat = makeWaChat({ session: ref() });

        await mount([chat]);
        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: { ...chat, status: 'archived' },
            }),
        );

        expect(rows()).toEqual([]);
    });
});

describe('search and filters', () => {
    it('reads the list again with the search text after a short pause', async () => {
        const vera = makeWaChat({ session: ref(), pushName: 'Vera' });
        const omar = makeWaChat({ session: ref(), pushName: 'Omar' });

        await mount([vera, omar]);

        const before = listCalls().length;

        await fill(byTestId('wa-search') as HTMLInputElement, 'vera');
        // Not on every keystroke.
        expect(listCalls().length).toBe(before);

        await waitFor(() => expect(listCalls().at(-1)?.query.q).toBe('vera'));
        await waitFor(() => expect(rows()).toEqual([vera.ulid]));
    });

    it('applies the status, link, unread and session filters through the API', async () => {
        const open = makeWaChat({ session: ref(), pushName: 'Open one' });
        const archived = makeWaChat({
            session: ref(),
            status: 'archived',
            pushName: 'Archived one',
        });
        const linked = makeLinkedWaChat({
            session: ref(OTHER),
            unreadByAdmin: 4,
            pushName: 'Linked one',
        });

        await mount([open, archived, linked], {
            sessions: [SESSION, OTHER],
        });

        await click(byTestId('wa-filter-archived'));
        await waitFor(() =>
            expect(listCalls().at(-1)?.query.status).toBe('archived'),
        );
        await waitFor(() => expect(rows()).toEqual([archived.ulid]));

        await click(byTestId('wa-filter-open'));
        await waitFor(() =>
            expect(listCalls().at(-1)?.query.status).toBe('open'),
        );

        await click(byTestId('wa-filter-linked'));
        await waitFor(() => expect(listCalls().at(-1)?.query.linked).toBe('1'));
        await waitFor(() => expect(rows()).toEqual([linked.ulid]));

        await click(byTestId('wa-filter-unlinked'));
        await waitFor(() => expect(listCalls().at(-1)?.query.linked).toBe('0'));
        await waitFor(() => expect(rows()).toEqual([open.ulid]));

        await click(byTestId('wa-filter-unlinked'));
        await click(byTestId('wa-filter-unread'));
        await waitFor(() => expect(listCalls().at(-1)?.query.unread).toBe('1'));
        await waitFor(() => expect(rows()).toEqual([linked.ulid]));

        await click(byTestId('wa-filter-unread'));

        const select = byTestId('wa-filter-session') as HTMLSelectElement;

        await act(async () => {
            select.value = OTHER.ulid;
            select.dispatchEvent(new Event('change', { bubbles: true }));
        });
        await waitFor(() =>
            expect(listCalls().at(-1)?.query.session).toBe(OTHER.ulid),
        );
        await waitFor(() => expect(rows()).toEqual([linked.ulid]));
    });

    it('lists the unread chats first when asked, each group by recency', async () => {
        const old = makeWaChat({
            session: ref(),
            lastMessageAt: fakeTime(10),
            unreadByAdmin: 1,
        });
        const recent = makeWaChat({
            session: ref(),
            lastMessageAt: fakeTime(90),
        });

        await mount([old, recent]);
        expect(rows()).toEqual([recent.ulid, old.ulid]);

        await click(byTestId('wa-filter-unread-first'));

        await waitFor(() => expect(rows()).toEqual([old.ulid, recent.ulid]));
        expect(
            byTestId('wa-filter-unread-first')?.getAttribute('aria-pressed'),
        ).toBe('true');
    });

    it('says when nothing matches the filters, not that the inbox is empty', async () => {
        const chat = makeWaChat({ session: ref() });

        await mount([chat]);
        await click(byTestId('wa-filter-archived'));
        await waitFor(() =>
            expect(byTestId('wa-list-no-match')).not.toBeNull(),
        );

        expect(byTestId('wa-list-empty')).toBeNull();
    });

    it('offers the session filter only when there are several sessions', async () => {
        await mount([], { sessions: [SESSION] });

        expect(byTestId('wa-filter-session')).toBeNull();
    });

    it('does not add a chat the browser cannot judge while a search is active', async () => {
        const vera = makeWaChat({ session: ref(), pushName: 'Vera' });
        const stranger = makeWaChat({
            session: ref(),
            pushName: 'Stranger',
            lastMessageAt: fakeTime(999),
        });

        await mount([vera]);
        await fill(byTestId('wa-search') as HTMLInputElement, 'vera');
        await waitFor(() => expect(listCalls().at(-1)?.query.q).toBe('vera'));

        await act(async () =>
            fakeEcho.emitServer('whatsapp-admin', 'wa.chat.updated', {
                v: 1,
                chat: stranger,
            }),
        );

        expect(rows()).toEqual([vera.ulid]);
    });
});

describe('export', () => {
    const href = (id: string) => byTestId(id)?.getAttribute('href') ?? '';

    it('offers the three downloads as plain links that carry the filters in use', async () => {
        await mount([makeWaChat({ session: ref() })], {
            sessions: [SESSION, OTHER],
        });

        expect(href('wa-export-messages-csv')).toBe(
            '/api/v1/whatsapp/export?format=csv&resource=messages&status=open',
        );
        expect(href('wa-export-messages-json')).toBe(
            '/api/v1/whatsapp/export?format=json&resource=messages&status=open',
        );
        expect(href('wa-export-chats-csv')).toBe(
            '/api/v1/whatsapp/export?format=csv&resource=chats&status=open',
        );

        await click(byTestId('wa-filter-linked'));
        await fill(byTestId('wa-search') as HTMLInputElement, 'vera');

        const url = new URL(href('wa-export-messages-csv'), 'https://app.test');

        expect(Object.fromEntries(url.searchParams)).toEqual({
            format: 'csv',
            resource: 'messages',
            status: 'open',
            linked: '1',
            q: 'vera',
        });
        // A link (the browser downloads it with the session cookie), not a request the page makes.
        expect(byTestId('wa-export-messages-csv')?.tagName).toBe('A');
    });
});

describe('more than one page', () => {
    it('reads the first page once to learn the cursor, then loads more', async () => {
        const all = Array.from({ length: 5 }, (_, n) =>
            makeWaChat({
                session: ref(),
                pushName: `Chat ${n}`,
                lastMessageAt: fakeTime(1000 - n),
            }),
        );

        seed(...all);
        // The page props carried two of them; the API pages by two as well.
        await renderWa(
            <WaInboxShell
                {...SHELL}
                chats={all.slice(0, 2)}
                hasMore
                sessions={[SESSION]}
                selectedUlid={null}
            />,
        );
        await waitFor(() => expect(listCalls().length).toBeGreaterThan(0));

        // The fake API serves 50 per page: everything arrives, and with it the answer "no more".
        await waitFor(() => expect(rows().length).toBe(5));
        expect(byTestId('wa-list-more')).toBeNull();
    });

    it('offers "Load more chats" while the API has another page', async () => {
        const all = Array.from({ length: 52 }, (_, n) =>
            makeWaChat({
                session: ref(),
                pushName: `Chat ${n}`,
                lastMessageAt: fakeTime(5000 - n),
            }),
        );

        seed(...all);
        await renderWa(
            <WaInboxShell
                {...SHELL}
                chats={all.slice(0, 50)}
                hasMore
                sessions={[SESSION]}
                selectedUlid={null}
            />,
        );
        await waitFor(() => expect(byTestId('wa-list-more')).not.toBeNull());
        expect(rows().length).toBe(50);

        await click(byTestId('wa-list-more'));
        await waitFor(() => expect(rows().length).toBe(52));
        expect(byTestId('wa-list-more')).toBeNull();
        expect(listCalls().at(-1)?.query.cursor).toBe('50');
    });

    it('does not read the list on the first render when the props hold all of it', async () => {
        await mount([makeWaChat({ session: ref() })]);

        expect(listCalls()).toHaveLength(0);
    });
});

describe('without a websocket', () => {
    it('reads the list again every 15 seconds and says so', async () => {
        vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

        try {
            await mount([makeWaChat({ session: ref() })], { sockets: false });
            expect(byTestId('connection-banner')?.dataset.status).toBe(
                'unavailable',
            );

            const before = listCalls().length;

            await act(async () => {
                vi.advanceTimersByTime(15_000);
            });
            await waitFor(() =>
                expect(listCalls().length).toBeGreaterThan(before),
            );
        } finally {
            vi.useRealTimers();
        }
    });
});
