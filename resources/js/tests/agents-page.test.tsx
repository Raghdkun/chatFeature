import '@/tests/dom-polyfills';
import { toast } from 'sonner';
import {
    afterEach,
    beforeEach,
    describe,
    expect,
    it,
    vi,
} from 'vite-plus/test';
import AgentsIndex from '@/pages/agents/index';
import { blur, body, byTestId, choose, fill, keyDown } from '@/tests/dom';
import { fakeApi } from '@/tests/fake-api';
import { AGENTS, CATEGORIES, makeAgent } from '@/tests/fixtures';
import {
    StaffRealtimeContext,
    type StaffRealtimeContextValue,
} from '@/lib/realtime/staff/context';
import { createInboxStore } from '@/lib/realtime/staff/store';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { act } from 'react';
import { click, flush, render } from '@/tests/render';
import type { AgentsPageProps } from '@/types/widgets';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const props = (overrides: Partial<AgentsPageProps> = {}): AgentsPageProps => ({
    agents: AGENTS,
    categories: CATEGORIES,
    authMode: 'fortify',
    canManageStaff: true,
    ...overrides,
});

beforeEach(() =>
    resetInertiaMock({
        auth: {
            user: {
                id: 9,
                name: 'Admin',
                email: 'a@example.com',
                avatar: null,
                is_admin: true,
                is_agent: false,
                auth_source: 'local',
            },
            mode: 'fortify',
            capabilities: { portalUrl: null },
        },
    }),
);

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const rowIds = (container: HTMLElement) =>
    Array.from(container.querySelectorAll('[data-testid^="agent-row-"]')).map(
        (row) => row.getAttribute('data-testid')?.replace('agent-row-', ''),
    );

describe('agents table', () => {
    it('shows name, email, role badges, auth source, categories, status, limits and last seen', async () => {
        const view = await render(<AgentsIndex {...props()} />);
        const sara = view.byTestId('agent-row-1');
        const omar = view.byTestId('agent-row-2');

        expect(sara?.textContent).toContain('Sara Ahmed');
        expect(sara?.textContent).toContain('sara@example.com');
        expect(sara?.textContent).toContain('Local account');
        expect(sara?.textContent).toContain('Sales');
        expect(sara?.textContent).toContain('Never');
        expect(byTestId(view.container, 'agent-badge-agent-1')).not.toBeNull();
        expect(byTestId(view.container, 'agent-badge-admin-1')).toBeNull();
        expect(byTestId(view.container, 'agent-badge-admin-2')).not.toBeNull();
        expect(omar?.textContent).toContain('No categories');
        expect(omar?.textContent).not.toContain('Never');
        expect(
            (byTestId(view.container, 'agent-max-3') as HTMLInputElement).value,
        ).toBe('5');
        expect(
            byTestId(view.container, 'agent-active-3')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('false');
        expect(view.byTestId('agents-count')?.textContent).toBe('3 agents');
    });

    it('collapses long category lists into chips plus a count', async () => {
        const many = makeAgent({
            id: 5,
            name: 'Many',
            email: 'many@example.com',
            category_ulids: ['c1', 'c2', 'c3', 'c4', 'c5'],
        });
        const categories = ['c1', 'c2', 'c3', 'c4', 'c5'].map(
            (ulid, index) => ({
                ...CATEGORIES[0],
                ulid,
                name: `Cat ${index + 1}`,
            }),
        );
        const view = await render(
            <AgentsIndex {...props({ agents: [many], categories })} />,
        );

        expect(view.byTestId('agent-row-5')?.textContent).toContain('Cat 1');
        expect(view.byTestId('agent-row-5')?.textContent).toContain('Cat 3');
        expect(view.byTestId('agent-row-5')?.textContent).not.toContain(
            'Cat 4',
        );
        expect(view.byTestId('agent-row-5')?.textContent).toContain('+2 more');
    });

    it('searches, and filters by category and role', async () => {
        const view = await render(<AgentsIndex {...props()} />);

        await fill(view.byTestId('agent-search') as HTMLInputElement, 'lina');
        expect(rowIds(view.container)).toEqual(['3']);
        expect(view.byTestId('agents-count')?.textContent).toBe(
            'Showing 1 of 3 agents',
        );

        await fill(view.byTestId('agent-search') as HTMLInputElement, '');
        await choose(
            view.byTestId('agent-filter-category') as HTMLSelectElement,
            'cat2',
        );
        expect(rowIds(view.container)).toEqual(['3']);

        await choose(
            view.byTestId('agent-filter-category') as HTMLSelectElement,
            'none',
        );
        expect(rowIds(view.container)).toEqual(['2']);

        await choose(
            view.byTestId('agent-filter-category') as HTMLSelectElement,
            'all',
        );
        await choose(
            view.byTestId('agent-filter-role') as HTMLSelectElement,
            'admin',
        );
        expect(rowIds(view.container)).toEqual(['2']);

        await choose(
            view.byTestId('agent-filter-role') as HTMLSelectElement,
            'agent',
        );
        await fill(view.byTestId('agent-search') as HTMLInputElement, 'omar');
        expect(view.byTestId('agents-no-match')).not.toBeNull();
    });

    it('shows an empty state without agents', async () => {
        const view = await render(<AgentsIndex {...props({ agents: [] })} />);

        expect(view.byTestId('agents-empty')?.textContent).toContain(
            'No agents yet',
        );
        expect(view.byTestId('agent-search')).toBeNull();
    });
});

describe('category assignment (optimistic)', () => {
    async function openMenu(
        view: Awaited<ReturnType<typeof render>>,
        id: number,
    ) {
        await click(byTestId(view.container, `agent-categories-${id}`));
    }

    it('ticks a category at once and saves the full set', async () => {
        const api = fakeApi({
            'PATCH /api/v1/agents/1/categories': (call) => ({
                json: {
                    data: {
                        ...AGENTS[0],
                        category_ulids: (
                            call.body as { category_ulids: string[] }
                        ).category_ulids,
                    },
                },
            }),
        });
        const view = await render(<AgentsIndex {...props()} />);

        await openMenu(view, 1);
        await click(body.byTestId('agent-category-option-1-cat2'));

        expect(view.byTestId('agent-row-1')?.textContent).toContain('Billing');

        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/agents/1/categories')).toEqual({
            category_ulids: ['cat1', 'cat2'],
        });
        expect(toast.error).not.toHaveBeenCalled();
    });

    it('unticks a category and sends the smaller set', async () => {
        const api = fakeApi({
            'PATCH /api/v1/agents/3/categories': {
                json: { data: { ...AGENTS[2], category_ulids: ['cat2'] } },
            },
        });
        const view = await render(<AgentsIndex {...props()} />);

        await openMenu(view, 3);
        await click(body.byTestId('agent-category-option-3-cat1'));
        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/agents/3/categories')).toEqual({
            category_ulids: ['cat2'],
        });
        expect(view.byTestId('agent-row-3')?.textContent).not.toContain(
            'Sales',
        );
    });

    it('rolls back to the server state and toasts when the change is refused', async () => {
        fakeApi({
            'PATCH /api/v1/agents/1/categories': async () => {
                // Slow enough to observe the optimistic state first.
                await new Promise((resolve) => setTimeout(resolve, 20));

                return {
                    status: 422,
                    json: {
                        error: {
                            code: 'validation_failed',
                            message: 'Invalid',
                            details: {
                                'category_ulids.0': [
                                    'That category is inactive.',
                                ],
                            },
                        },
                    },
                };
            },
        });
        const view = await render(<AgentsIndex {...props()} />);

        await openMenu(view, 1);
        await click(body.byTestId('agent-category-option-1-cat3'));

        expect(view.byTestId('agent-row-1')?.textContent).toContain(
            'Technical support',
        );

        await new Promise((resolve) => setTimeout(resolve, 40));
        await flush();

        expect(view.byTestId('agent-row-1')?.textContent).not.toContain(
            'Technical support',
        );
        expect(view.byTestId('agent-row-1')?.textContent).toContain('Sales');
        expect(toast.error).toHaveBeenCalledWith('That category is inactive.');
    });

    it('queues quick consecutive edits of one agent so they cannot overtake each other', async () => {
        const order: string[] = [];
        fakeApi({
            'PATCH /api/v1/agents/1/categories': async (call) => {
                const set = (call.body as { category_ulids: string[] })
                    .category_ulids;

                if (set.length === 2) {
                    await new Promise((resolve) => setTimeout(resolve, 20));
                }

                order.push(set.join(','));

                return {
                    json: { data: { ...AGENTS[0], category_ulids: set } },
                };
            },
        });
        const view = await render(<AgentsIndex {...props()} />);

        await openMenu(view, 1);
        await click(body.byTestId('agent-category-option-1-cat2'));
        await click(body.byTestId('agent-category-option-1-cat3'));
        await new Promise((resolve) => setTimeout(resolve, 60));
        await flush();

        expect(order).toEqual(['cat1,cat2', 'cat1,cat2,cat3']);
        expect(view.byTestId('agent-row-1')?.textContent).toContain(
            'Technical support',
        );
    });
});

describe('mode 1 (local staff)', () => {
    it('lets admins create staff with categories', async () => {
        const created = makeAgent({
            id: 11,
            name: 'New Person',
            email: 'new@example.com',
            category_ulids: ['cat2'],
        });
        const api = fakeApi({
            'POST /api/v1/agents': { status: 201, json: { data: created } },
        });
        const view = await render(<AgentsIndex {...props()} />);

        expect(view.byTestId('agents-portal-notice')).toBeNull();

        await click(view.byTestId('agent-create'));

        const dialog = body.byTestId('agent-create-dialog');

        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-name"]') ??
                null,
            ' New Person ',
        );
        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-email"]') ??
                null,
            'new@example.com',
        );
        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-password"]') ??
                null,
            'correct horse battery',
        );
        await click(body.byTestId('agent-create-category-cat2'));
        await click(body.byTestId('agent-create-submit'));
        await flush();

        expect(api.bodyOf('POST', '/api/v1/agents')).toEqual({
            name: 'New Person',
            email: 'new@example.com',
            password: 'correct horse battery',
            is_agent: true,
            category_ulids: ['cat2'],
        });
        expect(rowIds(view.container)).toEqual(['1', '2', '3', '11']);
        expect(body.byTestId('agent-create-dialog')).toBeNull();
        expect(toast.success).toHaveBeenCalledWith('New Person was added');
    });

    it('validates the staff form and maps server errors per field', async () => {
        const api = fakeApi({
            'POST /api/v1/agents': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'Invalid',
                        details: {
                            email: ['The email has already been taken.'],
                        },
                    },
                },
            },
        });
        const view = await render(<AgentsIndex {...props()} />);

        await click(view.byTestId('agent-create'));
        await click(body.byTestId('agent-create-submit'));

        const dialog = body.byTestId('agent-create-dialog');

        expect(dialog?.textContent).toContain('Enter a name.');
        expect(dialog?.textContent).toContain('Enter a valid email address.');
        expect(dialog?.textContent).toContain('Use at least 8 characters.');
        expect(api.calls).toHaveLength(0);

        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-name"]') ??
                null,
            'X',
        );
        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-email"]') ??
                null,
            'x@example.com',
        );
        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-password"]') ??
                null,
            '12345678',
        );
        await click(body.byTestId('agent-create-submit'));
        await flush();

        expect(dialog?.textContent).toContain(
            'The email has already been taken.',
        );
        expect(rowIds(view.container)).toHaveLength(3);
    });

    it('activates / deactivates through PATCH and lets an admin stop or start taking chats', async () => {
        // A tiny stateful server: every PATCH merges into what it already stores.
        const stored = new Map([
            [1, { ...AGENTS[0] }],
            [2, { ...AGENTS[1] }],
            [3, { ...AGENTS[2] }],
        ]);
        const patch = (id: number) => (call: { body: unknown }) => {
            const next = { ...stored.get(id)!, ...(call.body as object) };

            stored.set(id, next);

            return { json: { data: next } };
        };
        const api = fakeApi({
            'PATCH /api/v1/agents/1': patch(1),
            'PATCH /api/v1/agents/2': patch(2),
            'PATCH /api/v1/agents/3': patch(3),
        });
        const view = await render(<AgentsIndex {...props()} />);

        await click(byTestId(view.container, 'agent-active-1'));
        await flush();
        // Omar is an admin who does not take chats yet: switch it on, then off again.
        await click(byTestId(view.container, 'agent-role-2'));
        await flush();
        await click(byTestId(view.container, 'agent-role-2'));
        await flush();
        await click(byTestId(view.container, 'agent-active-3'));
        await flush();

        expect(
            api.to('PATCH', '/api/v1/agents/1').map((call) => call.body),
        ).toEqual([{ is_active: false }]);
        expect(
            api.to('PATCH', '/api/v1/agents/2').map((call) => call.body),
        ).toEqual([{ is_agent: true }, { is_agent: false }]);
        expect(api.bodyOf('PATCH', '/api/v1/agents/3')).toEqual({
            is_active: true,
        });
        expect(
            byTestId(view.container, 'agent-active-1')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('false');
    });

    it('offers "Takes chats" on admin rows only: the server refuses is_agent=false for agents ("Agents always take chats")', async () => {
        const view = await render(<AgentsIndex {...props()} />);

        // Sara (agent) always takes chats: nothing to switch.
        expect(byTestId(view.container, 'agent-role-1')).toBeNull();
        // Omar (admin) may or may not take chats.
        const omar = byTestId(view.container, 'agent-role-2');

        expect(omar).not.toBeNull();
        expect(omar?.getAttribute('aria-checked')).toBe('false');
        expect(view.byTestId('agent-row-2')?.textContent).toContain(
            'Takes chats',
        );
        expect(view.byTestId('agent-row-1')?.textContent).not.toContain(
            'Takes chats',
        );
    });

    it('reflects an admin who already takes chats and rolls the switch back when the server says no', async () => {
        const admin = { ...AGENTS[1], is_agent: true };
        const api = fakeApi({
            'PATCH /api/v1/agents/2': {
                status: 409,
                json: {
                    error: {
                        code: 'managed_by_auth_portal',
                        message: 'This is managed by the Auth Portal.',
                    },
                },
            },
        });
        const view = await render(
            <AgentsIndex {...props({ agents: [AGENTS[0], admin] })} />,
        );

        expect(
            byTestId(view.container, 'agent-role-2')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('true');

        await click(byTestId(view.container, 'agent-role-2'));
        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/agents/2')).toEqual({
            is_agent: false,
        });
        expect(
            byTestId(view.container, 'agent-role-2')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('true');
        expect(toast.error).toHaveBeenCalledWith(
            'This is managed by the Auth Portal.',
        );
    });

    it('rolls the active switch back when the server says it is managed elsewhere', async () => {
        fakeApi({
            'PATCH /api/v1/agents/1': {
                status: 409,
                json: {
                    error: {
                        code: 'managed_by_auth_portal',
                        message: 'Managed in the Auth Portal.',
                    },
                },
            },
        });
        const view = await render(<AgentsIndex {...props()} />);

        await click(byTestId(view.container, 'agent-active-1'));
        await flush();

        expect(
            byTestId(view.container, 'agent-active-1')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('true');
        expect(toast.error).toHaveBeenCalledWith('Managed in the Auth Portal.');
    });
});

describe('max concurrent chats', () => {
    it('saves a valid number on blur and on Enter', async () => {
        let stored = { ...AGENTS[0] };
        const api = fakeApi({
            'PATCH /api/v1/agents/1': (call) => {
                stored = { ...stored, ...(call.body as object) };

                return { json: { data: stored } };
            },
        });
        const view = await render(<AgentsIndex {...props()} />);
        const input = byTestId(
            view.container,
            'agent-max-1',
        ) as HTMLInputElement;

        await fill(input, '8');
        await blur(input);
        await flush();
        await fill(input, '9');
        await keyDown(input, 'Enter');
        await flush();

        expect(
            api.to('PATCH', '/api/v1/agents/1').map((call) => call.body),
        ).toEqual([{ max_concurrent_chats: 8 }, { max_concurrent_chats: 9 }]);
        expect(input.value).toBe('9');
    });

    it('snaps back without calling the server for anything that is not a valid number', async () => {
        const api = fakeApi();
        const view = await render(<AgentsIndex {...props()} />);
        const input = byTestId(
            view.container,
            'agent-max-1',
        ) as HTMLInputElement;

        await fill(input, '0');
        expect(input.getAttribute('aria-invalid')).toBe('true');
        await blur(input);

        expect(input.value).toBe('3');

        await fill(input, '99');
        await blur(input);
        await fill(input, '');
        await blur(input);
        await fill(input, '3');
        await blur(input);

        expect(api.calls).toHaveLength(0);
        expect(input.value).toBe('3');
    });

    it('goes back to the saved value if saving fails', async () => {
        fakeApi({
            'PATCH /api/v1/agents/1': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });
        const view = await render(<AgentsIndex {...props()} />);
        const input = byTestId(
            view.container,
            'agent-max-1',
        ) as HTMLInputElement;

        await fill(input, '7');
        await blur(input);
        await flush();

        expect(input.value).toBe('3');
        expect(toast.error).toHaveBeenCalled();
    });
});

describe('mode 2 (Auth Portal)', () => {
    const portal = () => props({ authMode: 'pizzasys', canManageStaff: false });

    it('says that roles are managed in the Auth Portal and hides staff creation', async () => {
        const view = await render(<AgentsIndex {...portal()} />);
        const notice = view.byTestId('agents-portal-notice');

        expect(notice?.textContent).toContain(
            'Roles are managed in the Auth Portal',
        );
        expect(view.byTestId('agent-create')).toBeNull();
        expect(notice?.querySelector('a')).toBeNull();
    });

    it('disables the active switch, drops the agent-role switch and keeps categories + limits editable', async () => {
        const api = fakeApi({
            'PATCH /api/v1/agents/1/categories': {
                json: {
                    data: { ...AGENTS[0], category_ulids: ['cat1', 'cat2'] },
                },
            },
        });
        const view = await render(<AgentsIndex {...portal()} />);

        expect(
            (byTestId(view.container, 'agent-active-1') as HTMLButtonElement)
                .disabled,
        ).toBe(true);
        expect(byTestId(view.container, 'agent-role-1')).toBeNull();
        // Roles come from the portal: not even an admin row has the switch.
        expect(byTestId(view.container, 'agent-role-2')).toBeNull();
        expect(byTestId(view.container, 'agent-source-1')?.textContent).toBe(
            'Local account',
        );
        expect(
            (byTestId(view.container, 'agent-max-1') as HTMLInputElement)
                .disabled,
        ).toBe(false);

        await click(byTestId(view.container, 'agent-categories-1'));
        await click(body.byTestId('agent-category-option-1-cat2'));
        await flush();

        expect(api.to('PATCH', '/api/v1/agents/1/categories')).toHaveLength(1);
    });

    it('labels portal accounts and links to the portal when the capability has a web url', async () => {
        resetInertiaMock({
            auth: {
                user: { id: 9, is_admin: true },
                mode: 'pizzasys',
                capabilities: { portalUrl: 'https://auth.example.test' },
            },
        });

        const view = await render(
            <AgentsIndex
                {...portal()}
                agents={[makeAgent({ auth_source: 'pizzasys' })]}
            />,
        );
        const link = view.byTestId('agents-portal-notice')?.querySelector('a');

        expect(byTestId(view.container, 'agent-source-1')?.textContent).toBe(
            'Auth Portal',
        );
        expect(link?.getAttribute('href')).toBe('https://auth.example.test/');
        expect(link?.getAttribute('rel')).toContain('noopener');
    });

    it('never links a non-web portal url', async () => {
        resetInertiaMock({
            auth: {
                user: { id: 9, is_admin: true },
                mode: 'pizzasys',
                capabilities: { portalUrl: 'javascript:alert(1)' },
            },
        });

        const view = await render(<AgentsIndex {...portal()} />);

        expect(
            view.byTestId('agents-portal-notice')?.querySelector('a'),
        ).toBeNull();
    });
});

describe('presence dots', () => {
    const presence = { 1: 'online', 2: 'away', 3: 'online' } as const;

    it("shows each person's status as a dot and a label, and counts who is online among the active", async () => {
        const view = await render(
            <AgentsIndex {...props({ presence: { ...presence } })} />,
        );

        expect(
            view.byTestId('agent-presence-1')?.getAttribute('data-status'),
        ).toBe('online');
        expect(view.byTestId('agent-presence-1')?.textContent).toBe('Online');
        expect(
            view.byTestId('agent-presence-2')?.getAttribute('data-status'),
        ).toBe('away');
        expect(view.byTestId('agent-presence-2')?.textContent).toBe('Away');
        // Lina (3) is inactive: she never counts, whatever the store says.
        expect(view.byTestId('agents-online-count')?.textContent).toBe(
            '1 online',
        );
    });

    it('shows everybody offline when the page carries no presence', async () => {
        const view = await render(<AgentsIndex {...props()} />);

        for (const id of [1, 2, 3]) {
            expect(
                view
                    .byTestId(`agent-presence-${id}`)
                    ?.getAttribute('data-status'),
            ).toBe('offline');
        }

        expect(view.byTestId('agents-online-count')?.textContent).toBe(
            '0 online',
        );
    });

    it('follows presence.changed events heard after the page loaded, for people who are not on the roster too', async () => {
        const store = createInboxStore();
        const session = { store } as unknown as StaffRealtimeContextValue;
        const view = await render(
            <StaffRealtimeContext.Provider value={session}>
                <AgentsIndex {...props({ presence: { ...presence } })} />
            </StaffRealtimeContext.Provider>,
        );

        // An older event (from before this page was loaded) changes nothing.
        await act(async () =>
            store.dispatch({
                type: 'presenceSeen',
                id: 1,
                status: 'offline',
                at: 1,
            }),
        );
        expect(
            view.byTestId('agent-presence-1')?.getAttribute('data-status'),
        ).toBe('online');

        await act(async () => {
            store.dispatch({
                type: 'presenceSeen',
                id: 1,
                status: 'offline',
                at: Date.now() + 1_000,
            });
            store.dispatch({
                type: 'presenceSeen',
                id: 2,
                status: 'online',
                at: Date.now() + 1_000,
            });
        });

        expect(
            view.byTestId('agent-presence-1')?.getAttribute('data-status'),
        ).toBe('offline');
        expect(
            view.byTestId('agent-presence-2')?.getAttribute('data-status'),
        ).toBe('online');
        expect(view.byTestId('agents-online-count')?.textContent).toBe(
            '1 online',
        );
    });
});
