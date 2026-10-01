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
import CategoriesIndex from '@/pages/categories/index';
import { body, byTestId, fill, submit } from '@/tests/dom';
import { fakeApi } from '@/tests/fake-api';
import { CATEGORIES, makeCategory } from '@/tests/fixtures';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { click, flush, render, type Rendered } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

beforeEach(() => resetInertiaMock());

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const rowIds = (view: Rendered) =>
    Array.from(
        view.container.querySelectorAll('[data-testid^="category-row-"]'),
    ).map((row) =>
        row.getAttribute('data-testid')?.replace('category-row-', ''),
    );

describe('categories list', () => {
    it('lists categories in order with counts, badges and the inactive state', async () => {
        const view = await render(
            <CategoriesIndex categories={[...CATEGORIES].reverse()} />,
        );

        expect(rowIds(view)).toEqual(['cat1', 'cat2', 'cat3']);
        expect(view.byTestId('category-row-cat1')?.textContent).toContain(
            'Sales',
        );
        expect(view.byTestId('category-row-cat1')?.textContent).toContain(
            'sales',
        );
        expect(view.byTestId('category-row-cat1')?.textContent).toContain(
            '2 agents',
        );
        expect(view.byTestId('category-row-cat1')?.textContent).toContain(
            '1 widget',
        );
        expect(view.byTestId('category-row-cat2')?.textContent).toContain(
            '1 agent',
        );
        expect(view.byTestId('category-row-cat2')?.textContent).toContain(
            '0 widgets',
        );
        expect(view.byTestId('category-row-cat3')?.textContent).toContain(
            'Inactive',
        );
        expect(view.byTestId('category-row-cat1')?.textContent).not.toContain(
            'Inactive',
        );
        expect(
            byTestId(view.container, 'category-active-cat3')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('false');
    });

    it('filters by name, slug or description and explains an empty result', async () => {
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);
        const search = view.byTestId('category-search') as HTMLInputElement;

        await fill(search, 'bug');

        expect(rowIds(view)).toEqual(['cat3']);
        // Moving rows around only makes sense on the full list.
        expect(
            (view.byTestId('category-move-up-cat3') as HTMLButtonElement)
                .disabled,
        ).toBe(true);

        await fill(search, 'zzz');

        expect(view.byTestId('categories-no-match')?.textContent).toContain(
            'zzz',
        );
        expect(view.byTestId('categories-list')).toBeNull();

        await fill(search, '');

        expect(rowIds(view)).toHaveLength(3);
    });

    it('shows an inviting empty state with a create action', async () => {
        const view = await render(<CategoriesIndex categories={[]} />);

        expect(view.byTestId('categories-empty')?.textContent).toContain(
            'No categories yet',
        );
        expect(view.byTestId('category-search')).toBeNull();

        await click(
            view.byTestId('categories-empty')?.querySelector('button') ?? null,
        );

        expect(body.byTestId('category-dialog')).not.toBeNull();
    });
});

describe('create category', () => {
    it('posts the contract body (no slug unless typed) and adds the row', async () => {
        const api = fakeApi({
            'POST /api/v1/categories': (call) => ({
                status: 201,
                json: {
                    data: makeCategory({
                        ulid: 'cat9',
                        name: (call.body as { name: string }).name,
                        slug: 'returns',
                        sort_order: 3,
                        agents_count: 0,
                        widgets_count: 0,
                    }),
                },
            }),
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-create'));

        const name = body
            .byTestId('category-dialog')
            ?.querySelector<HTMLInputElement>('input[id$="-name"]');

        await fill(name ?? null, 'Returns');
        await click(body.byTestId('category-submit'));
        await flush();

        expect(api.unhandled).toEqual([]);
        expect(api.bodyOf('POST', '/api/v1/categories')).toEqual({
            name: 'Returns',
            description: null,
            icon: 'message-circle',
            color: '#0f766e',
            is_active: true,
            name_i18n: {},
            sort_order: 3,
        });
        expect(api.calls[0].headers).toMatchObject({
            Accept: 'application/json',
        });
        expect(rowIds(view)).toEqual(['cat1', 'cat2', 'cat3', 'cat9']);
        expect(body.byTestId('category-dialog')).toBeNull();
        expect(toast.success).toHaveBeenCalledTimes(1);
    });

    it('generates the slug from the name until the admin types one, and then sends it', async () => {
        const api = fakeApi({
            'POST /api/v1/categories': {
                status: 201,
                json: { data: makeCategory({ ulid: 'cat9' }) },
            },
        });
        const view = await render(<CategoriesIndex categories={[]} />);

        await click(view.byTestId('category-create'));

        const dialog = body.byTestId('category-dialog');
        const name =
            dialog?.querySelector<HTMLInputElement>('input[id$="-name"]') ??
            null;
        const slug =
            dialog?.querySelector<HTMLInputElement>('input[id$="-slug"]') ??
            null;

        await fill(name, 'Technical Support');

        expect(slug?.placeholder).toBe('technical-support');
        expect(slug?.value).toBe('technical-support');

        await fill(slug, 'tech');
        await fill(name, 'Technical Help');

        expect(slug?.value).toBe('tech');

        await click(body.byTestId('category-submit'));
        await flush();

        expect(api.bodyOf('POST', '/api/v1/categories')).toMatchObject({
            name: 'Technical Help',
            slug: 'tech',
            sort_order: 0,
        });
    });

    it('validates before calling the server', async () => {
        const api = fakeApi();
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-create'));
        await submit(body.byTestId('category-submit'));

        expect(body.byTestId('category-dialog')?.textContent).toContain(
            'Enter a name.',
        );
        expect(api.calls).toHaveLength(0);
    });

    it('maps server validation errors onto the fields and keeps the dialog open', async () => {
        fakeApi({
            'POST /api/v1/categories': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'Invalid',
                        details: { slug: ['The slug has already been taken.'] },
                    },
                },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-create'));

        const dialog = body.byTestId('category-dialog');

        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-name"]') ??
                null,
            'Sales',
        );
        await click(body.byTestId('category-submit'));
        await flush();

        expect(dialog?.textContent).toContain(
            'The slug has already been taken.',
        );
        expect(rowIds(view)).toHaveLength(3);
    });

    it('shows transport failures as a form-level alert', async () => {
        fakeApi({
            'POST /api/v1/categories': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-create'));
        await fill(
            body
                .byTestId('category-dialog')
                ?.querySelector<HTMLInputElement>('input[id$="-name"]') ?? null,
            'Sales',
        );
        await click(body.byTestId('category-submit'));
        await flush();

        expect(body.byTestId('category-form-error')?.textContent).toContain(
            'server hit an error',
        );
    });

    it('collects per-locale name overrides into name_i18n', async () => {
        const api = fakeApi({
            'POST /api/v1/categories': {
                status: 201,
                json: { data: makeCategory({ ulid: 'cat9' }) },
            },
        });
        const view = await render(<CategoriesIndex categories={[]} />);

        await click(view.byTestId('category-create'));

        const dialog = body.byTestId('category-dialog');

        await fill(
            dialog?.querySelector<HTMLInputElement>('input[id$="-name"]') ??
                null,
            'Sales',
        );
        await click(body.byTestId('category-add-translation'));
        await fill(
            dialog?.querySelector<HTMLInputElement>(
                'input[aria-label^="Language code"]',
            ) ?? null,
            'ar',
        );
        await fill(
            dialog?.querySelector<HTMLInputElement>(
                'input[aria-label^="Name in translation"]',
            ) ?? null,
            'المبيعات',
        );
        await click(body.byTestId('category-submit'));
        await flush();

        expect(api.bodyOf('POST', '/api/v1/categories')).toMatchObject({
            name_i18n: { ar: 'المبيعات' },
        });
    });
});

describe('edit, toggle and reorder', () => {
    it('edits through PATCH with the current slug', async () => {
        const api = fakeApi({
            'PATCH /api/v1/categories/cat2': (call) => ({
                json: { data: { ...CATEGORIES[1], ...(call.body as object) } },
            }),
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-edit-cat2'));

        const name =
            body
                .byTestId('category-dialog')
                ?.querySelector<HTMLInputElement>('input[id$="-name"]') ?? null;

        expect(name?.value).toBe('Billing');

        await fill(name, 'Invoices');
        await click(body.byTestId('category-submit'));
        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/categories/cat2')).toMatchObject({
            name: 'Invoices',
            slug: 'billing',
            icon: 'credit-card',
            color: '#7c3aed',
        });
        expect(
            api.bodyOf('PATCH', '/api/v1/categories/cat2'),
        ).not.toHaveProperty('sort_order');
        expect(view.byTestId('category-row-cat2')?.textContent).toContain(
            'Invoices',
        );
    });

    it('flips the active switch at once and keeps it when the server agrees', async () => {
        const api = fakeApi({
            'PATCH /api/v1/categories/cat3': {
                json: { data: { ...CATEGORIES[2], is_active: true } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(byTestId(view.container, 'category-active-cat3'));

        expect(
            byTestId(view.container, 'category-active-cat3')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('true');

        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/categories/cat3')).toEqual({
            is_active: true,
        });
        expect(view.byTestId('category-row-cat3')?.textContent).not.toContain(
            'Inactive',
        );
    });

    it('rolls the switch back and tells the user when the server refuses', async () => {
        fakeApi({
            'PATCH /api/v1/categories/cat1': {
                status: 403,
                json: { error: { code: 'forbidden', message: 'No.' } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(byTestId(view.container, 'category-active-cat1'));
        await flush();

        expect(
            byTestId(view.container, 'category-active-cat1')?.getAttribute(
                'aria-checked',
            ),
        ).toBe('true');
        expect(toast.error).toHaveBeenCalledWith(
            'You do not have permission to do that.',
        );
    });

    it('moves a category up by renumbering both neighbours', async () => {
        const api = fakeApi({
            'PATCH /api/v1/categories/cat1': { json: { data: {} } },
            'PATCH /api/v1/categories/cat2': { json: { data: {} } },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        expect(
            (view.byTestId('category-move-up-cat1') as HTMLButtonElement)
                .disabled,
        ).toBe(true);

        await click(view.byTestId('category-move-up-cat2'));

        expect(rowIds(view)).toEqual(['cat2', 'cat1', 'cat3']);

        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/categories/cat2')).toEqual({
            sort_order: 0,
        });
        expect(api.bodyOf('PATCH', '/api/v1/categories/cat1')).toEqual({
            sort_order: 1,
        });
    });

    it('puts the order back when saving the move fails (and asks the server what is really stored)', async () => {
        const api = fakeApi({
            'PATCH /api/v1/categories/cat1': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
            'PATCH /api/v1/categories/cat2': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
            'GET /api/v1/categories': {
                json: { data: CATEGORIES, meta: { next_cursor: null } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-move-down-cat1'));
        await flush();

        expect(rowIds(view)).toEqual(['cat1', 'cat2', 'cat3']);
        expect(toast.error).toHaveBeenCalled();
        expect(api.to('GET', '/api/v1/categories')).toHaveLength(1);
    });

    it('sends the renumbering one request at a time, not all at once', async () => {
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        const api = fakeApi({
            'PATCH /api/v1/categories/cat2': async () => {
                await gate;

                return { json: { data: {} } };
            },
            'PATCH /api/v1/categories/cat1': { json: { data: {} } },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-move-up-cat2'));
        await flush();

        // The first request is still in flight: the second one has not been sent.
        expect(api.to('PATCH', '/api/v1/categories/cat2')).toHaveLength(1);
        expect(api.to('PATCH', '/api/v1/categories/cat1')).toHaveLength(0);
        // And no further move can start meanwhile.
        expect(
            (view.byTestId('category-move-down-cat1') as HTMLButtonElement)
                .disabled,
        ).toBe(true);

        release();
        await flush();

        expect(api.to('PATCH', '/api/v1/categories/cat1')).toHaveLength(1);
        expect(rowIds(view)).toEqual(['cat2', 'cat1', 'cat3']);
        expect(
            (view.byTestId('category-move-down-cat1') as HTMLButtonElement)
                .disabled,
        ).toBe(false);
    });

    it('after a partial failure shows what the server has, not the old order or the optimistic one', async () => {
        // cat2 -> 0 is saved, cat1 -> 1 fails: the server now has cat2 first and cat1 tied with it.
        const stored = [
            { ...CATEGORIES[0], sort_order: 0 },
            { ...CATEGORIES[1], sort_order: 0 },
            CATEGORIES[2],
        ];
        const api = fakeApi({
            'PATCH /api/v1/categories/cat2': { json: { data: {} } },
            'PATCH /api/v1/categories/cat1': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
            'GET /api/v1/categories': {
                json: { data: stored, meta: { next_cursor: null } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-move-up-cat2'));
        await flush();

        expect(api.to('PATCH', '/api/v1/categories/cat1')).toHaveLength(1);
        // Ties are ordered by name: Billing (cat2) before Sales (cat1).
        expect(rowIds(view)).toEqual(['cat2', 'cat1', 'cat3']);
        expect(toast.error).toHaveBeenCalled();
    });

    it('falls back to the previous order when even reloading fails', async () => {
        fakeApi({
            'PATCH /api/v1/categories/cat2': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });

        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-move-up-cat2'));
        await flush();

        expect(rowIds(view)).toEqual(['cat1', 'cat2', 'cat3']);
    });
});

describe('delete category', () => {
    it('asks first, then deletes and removes the row', async () => {
        const api = fakeApi({
            'DELETE /api/v1/categories/cat2': { status: 204 },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-delete-cat2'));

        const dialog = body.byTestId('category-delete-dialog');

        expect(dialog?.textContent).toContain('Delete Billing?');
        expect(dialog?.textContent).toContain('1 agent');
        expect(api.calls).toHaveLength(0);

        await click(body.byTestId('category-delete-confirm'));
        await flush();

        expect(api.to('DELETE', '/api/v1/categories/cat2')).toHaveLength(1);
        expect(rowIds(view)).toEqual(['cat1', 'cat3']);
        expect(body.byTestId('category-delete-dialog')).toBeNull();
    });

    it('does nothing when the user cancels', async () => {
        const api = fakeApi();
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-delete-cat2'));

        const cancel = Array.from(
            body
                .byTestId('category-delete-dialog')
                ?.querySelectorAll('button') ?? [],
        ).find((button) => button.textContent === 'Keep category');

        await click(cancel ?? null);

        expect(api.calls).toHaveLength(0);
        expect(rowIds(view)).toHaveLength(3);
    });

    it('explains 409 category_in_use and offers to deactivate instead', async () => {
        const api = fakeApi({
            'DELETE /api/v1/categories/cat1': {
                status: 409,
                json: { error: { code: 'category_in_use', message: 'In use' } },
            },
            'PATCH /api/v1/categories/cat1': {
                json: { data: { ...CATEGORIES[0], is_active: false } },
            },
        });
        const view = await render(<CategoriesIndex categories={CATEGORIES} />);

        await click(view.byTestId('category-delete-cat1'));
        await click(body.byTestId('category-delete-confirm'));
        await flush();

        expect(body.byTestId('category-in-use-notice')?.textContent).toContain(
            'This category is in use',
        );
        expect(rowIds(view)).toHaveLength(3);
        expect(
            (body.byTestId('category-delete-confirm') as HTMLButtonElement)
                .disabled,
        ).toBe(true);

        await click(body.byTestId('category-deactivate-instead'));
        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/categories/cat1')).toEqual({
            is_active: false,
        });
        expect(body.byTestId('category-delete-dialog')).toBeNull();
        expect(view.byTestId('category-row-cat1')?.textContent).toContain(
            'Inactive',
        );
    });
});
