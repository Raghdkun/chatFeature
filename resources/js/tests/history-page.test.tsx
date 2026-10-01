import '@/tests/dom-polyfills';
import { act, useState } from 'react';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import { NO_FILTERS } from '@/components/inbox/history-model';
import { SEARCH_DEBOUNCE_MS } from '@/components/inbox/history-filters';
import {
    fakeTime,
    makeActiveConversationStaff,
    makeConversationStaff,
    makeRating,
    resetFixtures,
} from '@/lib/chat/fixtures';
import HistoryIndex from '@/pages/history/index';
import { byTestId, choose, fill } from '@/tests/dom';
import { resetInertiaMock, routerMock } from '@/tests/inertia-mock';
import { click, render } from '@/tests/render';
import type { HistoryPageProps } from '@/types/chat-staff';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const OPTIONS = {
    categories: [
        { ulid: 'cat-billing', name: 'Billing' },
        { ulid: 'cat-sales', name: 'Sales' },
    ],
    widgets: [{ ulid: 'wid-1', name: 'Support widget' }],
    agents: [{ id: 7, name: 'Sam' }],
};

function props(overrides: Partial<HistoryPageProps> = {}): HistoryPageProps {
    return {
        conversations: [],
        pagination: {
            page: 1,
            perPage: 25,
            total: 0,
            lastPage: 1,
            from: null,
            to: null,
        },
        filters: NO_FILTERS,
        ratings: [],
        filterOptions: OPTIONS,
        ...overrides,
    };
}

beforeEach(() => {
    resetFixtures();
    resetInertiaMock({
        auth: {
            user: {
                id: 1,
                name: 'Ada',
                email: 'a@x.test',
                avatar: null,
                is_admin: true,
                is_agent: true,
                auth_source: 'local',
            },
            mode: 'fortify',
            capabilities: {},
        },
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the results', () => {
    const rows = () => [
        makeActiveConversationStaff({
            ticketNo: 'AAA111',
            status: 'closed',
            category: { slug: 'billing', label: 'Billing' },
            assignedAgent: { id: 7, name: 'Sam' },
            createdAt: fakeTime(0),
        }),
        makeConversationStaff({
            ticketNo: 'BBB222',
            status: 'missed',
            type: 'live',
        }),
        makeConversationStaff({
            ticketNo: 'CCC333',
            status: 'queued',
            type: 'offline',
            category: null,
        }),
    ];

    it('lists every conversation with its ticket, visitor, status, agent and rating', async () => {
        const list = rows();
        const view = await render(
            <HistoryIndex
                {...props({
                    conversations: list,
                    ratings: [
                        makeRating({
                            conversation: list[0].ulid,
                            score: 4,
                            comment: 'Helpful',
                        }),
                    ],
                    pagination: {
                        page: 1,
                        perPage: 25,
                        total: 3,
                        lastPage: 1,
                        from: 1,
                        to: 3,
                    },
                })}
            />,
        );
        const row = view.byTestId(`history-row-${list[0].ulid}`) as HTMLElement;

        expect(row.textContent).toContain('Vera Visitor');
        expect(row.textContent).toContain('vera@visitor.example');
        expect(row.textContent).toContain('AAA111');
        expect(row.textContent).toContain('Billing');
        expect(row.textContent).toContain('Closed');
        expect(row.textContent).toContain('Sam');
        expect(row.textContent).toContain('Rated 4 out of 5');
        expect(
            (row.querySelector('a') as HTMLAnchorElement).getAttribute('href'),
        ).toBe(`/inbox/${list[0].ulid}`);
        expect(
            view.byTestId(`history-row-${list[1].ulid}`)?.textContent,
        ).toContain('Missed');
        expect(
            view.byTestId(`history-row-${list[2].ulid}`)?.textContent,
        ).toContain('Offline ticket');
        expect(view.byTestId(`history-card-${list[0].ulid}`)).not.toBeNull();
        expect(view.byTestId('history-count')?.textContent).toBe(
            'Showing 1 to 3 of 3',
        );
    });

    it('explains an empty history, and an empty result of filters differently', async () => {
        const plain = await render(<HistoryIndex {...props()} />);

        expect(plain.byTestId('history-empty')?.textContent).toContain(
            'No conversations yet',
        );
        expect(plain.byTestId('history-count')?.textContent).toBe('No results');
        await plain.unmount();

        const filtered = await render(
            <HistoryIndex
                {...props({ filters: { ...NO_FILTERS, status: 'closed' } })}
            />,
        );

        expect(filtered.byTestId('history-empty')?.textContent).toContain(
            'Nothing matches',
        );
    });

    it('pages with Previous and Next, keeping the filters in the links', async () => {
        const view = await render(
            <HistoryIndex
                {...props({
                    conversations: rows(),
                    filters: { ...NO_FILTERS, status: 'closed' },
                    pagination: {
                        page: 2,
                        perPage: 25,
                        total: 60,
                        lastPage: 3,
                        from: 26,
                        to: 50,
                    },
                })}
            />,
        );
        const prev = view.byTestId('history-prev') as HTMLElement;
        const next = view.byTestId('history-next') as HTMLElement;

        expect(view.byTestId('history-count')?.textContent).toBe(
            'Showing 26 to 50 of 60',
        );
        expect(view.byTestId('history-pager')?.textContent).toContain(
            'Page 2 of 3',
        );
        expect(prev.getAttribute('href')).toBe('/history?status=closed');
        expect(next.getAttribute('href')).toBe('/history?status=closed&page=3');
    });

    it('disables Previous on the first page and Next on the last', async () => {
        const first = await render(
            <HistoryIndex
                {...props({
                    conversations: rows(),
                    pagination: {
                        page: 1,
                        perPage: 25,
                        total: 60,
                        lastPage: 3,
                        from: 1,
                        to: 25,
                    },
                })}
            />,
        );

        expect(
            (first.byTestId('history-prev') as HTMLButtonElement).disabled,
        ).toBe(true);
        expect(first.byTestId('history-next')?.tagName).toBe('A');
        await first.unmount();

        const last = await render(
            <HistoryIndex
                {...props({
                    conversations: rows(),
                    pagination: {
                        page: 3,
                        perPage: 25,
                        total: 60,
                        lastPage: 3,
                        from: 51,
                        to: 60,
                    },
                })}
            />,
        );

        expect(
            (last.byTestId('history-next') as HTMLButtonElement).disabled,
        ).toBe(true);
    });
});

describe('the filters', () => {
    const filtersCall = () =>
        routerMock.get.mock.calls.at(-1) as [
            string,
            Record<string, string>,
            Record<string, unknown>,
        ];

    it('offers the categories, widgets and agents the server sent', async () => {
        const view = await render(<HistoryIndex {...props()} />);
        const optionsOf = (id: string) =>
            Array.from((view.byTestId(id) as HTMLSelectElement).options).map(
                (o) => o.textContent,
            );

        expect(optionsOf('history-filter-category')).toEqual([
            'Any',
            'Billing',
            'Sales',
        ]);
        expect(optionsOf('history-filter-widget')).toEqual([
            'Any',
            'Support widget',
        ]);
        expect(optionsOf('history-filter-agent')).toEqual(['Any', 'Sam']);
        expect(optionsOf('history-filter-status')).toEqual([
            'Any',
            'Waiting',
            'Active',
            'Ended',
            'Closed',
            'Missed',
        ]);
    });

    it('asks the server through a partial reload that keeps state and scroll', async () => {
        const view = await render(<HistoryIndex {...props()} />);

        await choose(
            view.byTestId('history-filter-status') as HTMLSelectElement,
            'closed',
        );

        const [url, query, options] = filtersCall();

        expect(url).toBe('/history');
        expect(query).toEqual({ status: 'closed' });
        expect(options).toMatchObject({
            only: ['conversations', 'pagination', 'filters', 'ratings'],
            preserveState: true,
            preserveScroll: true,
            replace: true,
        });
    });

    it('combines filters and goes back to page 1 whenever one changes', async () => {
        const view = await render(
            <HistoryIndex
                {...props({
                    filters: { ...NO_FILTERS, status: 'closed' },
                    pagination: {
                        page: 3,
                        perPage: 25,
                        total: 90,
                        lastPage: 4,
                        from: 51,
                        to: 75,
                    },
                })}
            />,
        );

        // The page re-renders with the server's echo after each reload; here the props stay put, so each change builds on them.
        await choose(
            view.byTestId('history-filter-category') as HTMLSelectElement,
            'cat-billing',
        );
        expect(filtersCall()[1]).toEqual({
            status: 'closed',
            category: 'cat-billing',
        });

        await choose(
            view.byTestId('history-filter-agent') as HTMLSelectElement,
            '7',
        );
        expect(filtersCall()[1]).toEqual({ status: 'closed', agent: '7' });

        await fill(
            view.byTestId('history-filter-from') as HTMLInputElement,
            '2026-11-01',
        );
        expect(filtersCall()[1]).toEqual({
            status: 'closed',
            from: '2026-11-01',
        });
    });

    it('waits for a pause in typing before it searches', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const view = await render(<HistoryIndex {...props()} />);
        const search = view.byTestId('history-search') as HTMLInputElement;

        await fill(search, 'ref');
        await fill(search, 'refund');
        expect(routerMock.get).not.toHaveBeenCalled();

        await act(async () => {
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        });

        expect(routerMock.get).toHaveBeenCalledTimes(1);
        expect(filtersCall()[1]).toEqual({ q: 'refund' });
    });

    it('keeps what is typed while an earlier search is still on its way back, and follows the server for a reset', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

        const page: { set: (next: HistoryPageProps) => void } = {
            set: () => undefined,
        };

        function Page() {
            const [current, set] = useState(props());

            page.set = set;

            return <HistoryIndex {...current} />;
        }

        const view = await render(<Page />);
        const search = view.byTestId('history-search') as HTMLInputElement;

        await fill(search, 'ab');
        await act(async () => {
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        });
        expect(filtersCall()[1]).toEqual({ q: 'ab' });

        // the agent keeps typing while the reload for "ab" is in flight ...
        await fill(search, 'abc');

        // ... and the page comes back echoing "ab": the box must not jump back to it
        await act(async () =>
            page.set(props({ filters: { ...NO_FILTERS, q: 'ab' } })),
        );
        expect(search.value).toBe('abc');

        // the pause that follows searches for what was typed
        await act(async () => {
            vi.advanceTimersByTime(SEARCH_DEBOUNCE_MS);
        });
        expect(filtersCall()[1]).toEqual({ q: 'abc' });

        // a change that did not come from this box (reset, back button) still wins
        await act(async () => page.set(props({ filters: NO_FILTERS })));
        expect(search.value).toBe('');
    });

    it('searches at once when the form is submitted', async () => {
        const view = await render(<HistoryIndex {...props()} />);

        await fill(
            view.byTestId('history-search') as HTMLInputElement,
            'AAA111',
        );
        await act(async () => {
            (view.byTestId('history-filters') as HTMLFormElement).dispatchEvent(
                new Event('submit', { bubbles: true, cancelable: true }),
            );
        });

        expect(filtersCall()[1]).toEqual({ q: 'AAA111' });
    });

    it('resets every filter, and the button is off when none is set', async () => {
        const idle = await render(<HistoryIndex {...props()} />);

        expect(
            (idle.byTestId('history-reset') as HTMLButtonElement).disabled,
        ).toBe(true);
        await idle.unmount();

        const view = await render(
            <HistoryIndex
                {...props({
                    filters: { ...NO_FILTERS, status: 'closed', q: 'x' },
                })}
            />,
        );

        await click(view.byTestId('history-reset'));
        expect(filtersCall()[1]).toEqual({});
    });

    it('exports exactly the filtered set', async () => {
        const view = await render(
            <HistoryIndex
                {...props({
                    filters: {
                        ...NO_FILTERS,
                        status: 'closed',
                        from: '2026-11-01',
                    },
                })}
            />,
        );
        const link = view.byTestId('history-export') as HTMLAnchorElement;

        expect(link.getAttribute('href')).toBe(
            '/api/v1/conversations/export?status=closed&from=2026-11-01',
        );
        expect(link.hasAttribute('download')).toBe(true);
        expect(
            byTestId(view.container, 'history-filters')?.getAttribute('role'),
        ).toBe('search');
    });

    it('keeps the date range coherent (to cannot precede from)', async () => {
        const view = await render(
            <HistoryIndex
                {...props({
                    filters: {
                        ...NO_FILTERS,
                        from: '2026-11-05',
                        to: '2026-11-20',
                    },
                })}
            />,
        );

        expect(
            (view.byTestId('history-filter-from') as HTMLInputElement).max,
        ).toBe('2026-11-20');
        expect(
            (view.byTestId('history-filter-to') as HTMLInputElement).min,
        ).toBe('2026-11-05');
    });
});
