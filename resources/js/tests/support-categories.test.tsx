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
import SupportCategories from '@/pages/settings/support-categories';
import { byTestId } from '@/tests/dom';
import { fakeApi } from '@/tests/fake-api';
import { CATEGORIES, makeCategory } from '@/tests/fixtures';
import { resetInertiaMock, routerMock } from '@/tests/inertia-mock';
import { click, flush, render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const userWith = (flags: { is_admin?: boolean; is_agent?: boolean }) => ({
    id: 1,
    name: 'Sam',
    email: 'sam@example.com',
    avatar: null,
    auth_source: 'local',
    is_admin: false,
    is_agent: false,
    ...flags,
});

const signedInAs = (flags: { is_admin?: boolean; is_agent?: boolean }) =>
    resetInertiaMock({
        auth: {
            user: userWith(flags),
            mode: 'fortify',
            capabilities: { portalUrl: null },
        },
    });

beforeEach(() => signedInAs({ is_agent: true }));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
});

const check = (view: { container: HTMLElement }, ulid: string) =>
    byTestId(view.container, `support-category-check-${ulid}`);

describe('who may choose categories', () => {
    it('lets agents choose (PUT /me/categories requires is_agent)', async () => {
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        expect(view.byTestId('support-categories-not-agent')).toBeNull();
        expect(check(view, 'cat1')).not.toBeNull();
    });

    it('lets an admin who also takes chats choose', async () => {
        signedInAs({ is_admin: true, is_agent: true });

        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        expect(view.byTestId('support-categories-not-agent')).toBeNull();
        expect(check(view, 'cat1')).not.toBeNull();
    });

    it('explains instead of offering a form an admin who does not take chats could never save', async () => {
        signedInAs({ is_admin: true });

        const api = fakeApi();
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={['cat1']} />,
        );

        expect(
            view.byTestId('support-categories-not-agent')?.textContent,
        ).toContain('Your account does not take chats');
        // No picker, no save button, nothing to send.
        expect(check(view, 'cat1')).toBeNull();
        expect(view.byTestId('support-categories-save')).toBeNull();
        expect(
            view
                .byTestId('support-categories-agents-link')
                ?.getAttribute('href'),
        ).toBe('/agents');
        expect(api.calls).toHaveLength(0);
    });

    it('shows the notice without an Agents link to someone who cannot open it, and to a signed-out render', async () => {
        signedInAs({});

        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        expect(view.byTestId('support-categories-not-agent')).not.toBeNull();
        expect(view.byTestId('support-categories-agents-link')).toBeNull();

        resetInertiaMock();

        const signedOut = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        expect(
            signedOut.byTestId('support-categories-not-agent'),
        ).not.toBeNull();
    });
});

describe('my support categories', () => {
    it('lists only active categories, with the current choice ticked', async () => {
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={['cat2']} />,
        );

        expect(check(view, 'cat1')?.getAttribute('aria-checked')).toBe('false');
        expect(check(view, 'cat2')?.getAttribute('aria-checked')).toBe('true');
        // cat3 is inactive: it cannot be served.
        expect(check(view, 'cat3')).toBeNull();
        expect(view.byTestId('support-categories-status')?.textContent).toBe(
            '1 category selected',
        );
    });

    it('drops stale selections that are no longer active', async () => {
        const view = await render(
            <SupportCategories
                categories={CATEGORIES}
                selected={['cat3', 'cat1']}
            />,
        );

        expect(view.byTestId('support-categories-status')?.textContent).toBe(
            '1 category selected',
        );
    });

    it('shows which widgets expose each category', async () => {
        const categories = [
            makeCategory({
                ulid: 'a',
                name: 'A',
                widgets_count: 2,
                widgets: [
                    { ulid: 'w1', name: 'Marketing site' },
                    { ulid: 'w2', name: 'Help center' },
                ],
            }),
            makeCategory({ ulid: 'b', name: 'B', widgets_count: 0 }),
            makeCategory({ ulid: 'c', name: 'C', widgets_count: 3 }),
        ];
        const view = await render(
            <SupportCategories categories={categories} selected={[]} />,
        );

        expect(view.byTestId('support-category-widgets-a')?.textContent).toBe(
            'Offered in: Marketing site, Help center',
        );
        expect(view.byTestId('support-category-widgets-b')?.textContent).toBe(
            'Not offered in any widget yet',
        );
        expect(view.byTestId('support-category-widgets-c')?.textContent).toBe(
            'Offered in 3 widgets',
        );
    });

    it('enables saving only after a change and saves the whole set with PUT /me/categories', async () => {
        const api = fakeApi({
            'PUT /api/v1/me/categories': {
                json: { data: { category_ulids: ['cat1', 'cat2'] } },
            },
        });
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={['cat1']} />,
        );
        const save = view.byTestId(
            'support-categories-save',
        ) as HTMLButtonElement;

        expect(save.disabled).toBe(true);

        await click(check(view, 'cat2'));

        expect(save.disabled).toBe(false);
        expect(view.byTestId('support-categories-status')?.textContent).toBe(
            'You have unsaved changes.',
        );

        await click(save);
        await flush();

        expect(api.bodyOf('PUT', '/api/v1/me/categories')).toEqual({
            category_ulids: ['cat1', 'cat2'],
        });
        expect(save.disabled).toBe(true);
        expect(
            view.byTestId('support-categories-status')?.textContent,
        ).toContain('Saved');
        expect(toast.success).toHaveBeenCalled();
    });

    it('can clear the whole selection', async () => {
        const api = fakeApi({
            'PUT /api/v1/me/categories': { json: { data: {} } },
        });
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={['cat1']} />,
        );

        await click(check(view, 'cat1'));
        await click(view.byTestId('support-categories-save'));
        await flush();

        expect(api.bodyOf('PUT', '/api/v1/me/categories')).toEqual({
            category_ulids: [],
        });
    });

    it('warns that no chat request will reach an agent who serves nothing, before and after saving', async () => {
        fakeApi({ 'PUT /api/v1/me/categories': { json: { data: {} } } });
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={['cat1']} />,
        );

        expect(view.byTestId('support-categories-none')).toBeNull();

        await click(check(view, 'cat1'));

        expect(view.byTestId('support-categories-none')?.textContent).toContain(
            'no chat request will reach you',
        );

        await click(view.byTestId('support-categories-save'));
        await flush();

        expect(view.byTestId('support-categories-none')).not.toBeNull();
    });

    it('keeps the choice and shows the error when saving fails', async () => {
        fakeApi({
            'PUT /api/v1/me/categories': {
                status: 403,
                json: { error: { code: 'forbidden', message: 'No.' } },
            },
        });
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        await click(check(view, 'cat1'));
        await click(view.byTestId('support-categories-save'));
        await flush();

        expect(
            view.byTestId('support-categories-error')?.textContent,
        ).toContain('permission');
        expect(check(view, 'cat1')?.getAttribute('aria-checked')).toBe('true');
        expect(
            (view.byTestId('support-categories-save') as HTMLButtonElement)
                .disabled,
        ).toBe(false);
    });

    it('guards against leaving with unsaved changes', async () => {
        const view = await render(
            <SupportCategories categories={CATEGORIES} selected={[]} />,
        );

        expect(routerMock.on).not.toHaveBeenCalledWith(
            'before',
            expect.anything(),
        );

        await click(check(view, 'cat1'));

        const [, handler] =
            routerMock.on.mock.calls.find(([event]) => event === 'before') ??
            [];
        const preventDefault = vi.fn();

        vi.spyOn(window, 'confirm').mockReturnValue(false);
        (handler as (event: unknown) => void)({ preventDefault, detail: {} });

        expect(preventDefault).toHaveBeenCalled();
    });

    it('explains when there is nothing to choose from', async () => {
        const view = await render(
            <SupportCategories categories={[CATEGORIES[2]]} selected={[]} />,
        );

        expect(
            view.byTestId('support-categories-empty')?.textContent,
        ).toContain('No categories to choose from');
        expect(view.byTestId('support-categories-save')).toBeNull();
    });
});
