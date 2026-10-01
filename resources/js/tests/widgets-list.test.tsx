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
import WidgetsIndex from '@/pages/widgets/index';
import { body, byTestId, fill, submit } from '@/tests/dom';
import { fakeApi } from '@/tests/fake-api';
import { makeListItem, makeWidget } from '@/tests/fixtures';
import { resetInertiaMock, routerMock } from '@/tests/inertia-mock';
import { click, flush, render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

const WIDGETS = [
    makeListItem(),
    makeListItem({
        ulid: 'w2',
        name: 'Help center',
        public_key: 'wk_def456',
        is_enabled: false,
        has_unpublished_changes: true,
        whatsapp_connected: true,
        config_version: 1,
        domains_count: 1,
        categories_count: 3,
        updated_at: '2026-09-29T10:00:00.000Z',
    }),
];

beforeEach(() => resetInertiaMock());

afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Reflect.deleteProperty(navigator, 'clipboard');
});

describe('widget cards', () => {
    it('shows status badges, counts and the open-builder link', async () => {
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);
        const first = view.byTestId('widget-card-w1');
        const second = view.byTestId('widget-card-w2');

        expect(first?.textContent).toContain('Marketing site');
        expect(first?.textContent).toContain('wk_abc123');
        expect(first?.textContent).toContain('v3');
        expect(first?.textContent).toContain('2 domains');
        expect(first?.textContent).toContain('1 category');
        expect(byTestId(view.container, 'widget-unpublished-w1')).toBeNull();
        expect(byTestId(view.container, 'widget-whatsapp-w1')).toBeNull();
        expect(first?.getAttribute('data-enabled')).toBe('true');

        expect(second?.textContent).toContain('3 categories');
        expect(second?.textContent).toContain('1 domain');
        expect(
            byTestId(view.container, 'widget-unpublished-w2')?.textContent,
        ).toBe('Unpublished changes');
        expect(
            byTestId(view.container, 'widget-whatsapp-w2')?.textContent,
        ).toBe('WhatsApp connected');
        expect(second?.getAttribute('data-enabled')).toBe('false');

        expect(
            byTestId(view.container, 'widget-edit-w1')
                ?.querySelector('a')
                ?.getAttribute('href') ??
                byTestId(view.container, 'widget-edit-w1')?.getAttribute(
                    'href',
                ),
        ).toBe('/widgets/w1');
        expect(
            byTestId(view.container, 'widget-link-w2')?.getAttribute('href'),
        ).toBe('/widgets/w2');
    });

    it('copies the public key', async () => {
        const writeText = vi.fn().mockResolvedValue(undefined);

        Object.defineProperty(navigator, 'clipboard', {
            value: { writeText },
            configurable: true,
        });

        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-copy-key-w2'));
        await flush();

        expect(writeText).toHaveBeenCalledWith('wk_def456');
        expect(
            byTestId(view.container, 'widget-copy-key-w2')?.textContent,
        ).toContain('Copied');
    });

    it('says when copying is not possible instead of failing silently', async () => {
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-copy-key-w1'));
        await flush();

        expect(
            byTestId(view.container, 'widget-copy-key-w1')?.textContent,
        ).toContain('Copy failed');
    });
});

describe('enable / disable', () => {
    it('flips at once and keeps the answer of the server', async () => {
        const api = fakeApi({
            'PATCH /api/v1/widgets/w2': {
                json: {
                    data: makeWidget({
                        ulid: 'w2',
                        is_enabled: true,
                        updated_at: '2026-09-30T12:00:00.000Z',
                    }),
                },
            },
        });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-enabled-w2'));

        expect(
            view.byTestId('widget-card-w2')?.getAttribute('data-enabled'),
        ).toBe('true');

        await flush();

        expect(api.bodyOf('PATCH', '/api/v1/widgets/w2')).toEqual({
            is_enabled: true,
        });
        expect(view.byTestId('widget-card-w2')?.textContent).toContain(
            'Enabled',
        );
    });

    it('rolls back and explains when the server refuses', async () => {
        fakeApi({
            'PATCH /api/v1/widgets/w1': {
                status: 403,
                json: { error: { code: 'forbidden', message: 'No.' } },
            },
        });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-enabled-w1'));
        await flush();

        expect(
            view.byTestId('widget-card-w1')?.getAttribute('data-enabled'),
        ).toBe('true');
        expect(toast.error).toHaveBeenCalledWith(
            'You do not have permission to do that.',
        );
    });
});

describe('create widget', () => {
    it('asks for a name only and opens the builder for the new widget', async () => {
        const api = fakeApi({
            'POST /api/v1/widgets': {
                status: 201,
                json: { data: makeWidget({ ulid: '01HNEW', name: 'Docs' }) },
            },
        });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(view.byTestId('widget-create'));

        const dialog = body.byTestId('widget-create-dialog');

        expect(dialog?.querySelectorAll('input')).toHaveLength(1);

        await fill(dialog?.querySelector('input') ?? null, '  Docs  ');
        await click(body.byTestId('widget-create-submit'));
        await flush();

        expect(api.bodyOf('POST', '/api/v1/widgets')).toEqual({ name: 'Docs' });
        expect(routerMock.visit).toHaveBeenCalledWith('/widgets/01HNEW');
    });

    it('requires a name', async () => {
        const api = fakeApi();
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(view.byTestId('widget-create'));
        await submit(body.byTestId('widget-create-submit'));

        expect(body.byTestId('widget-create-dialog')?.textContent).toContain(
            'Enter a name for the widget.',
        );
        expect(api.calls).toHaveLength(0);
        expect(routerMock.visit).not.toHaveBeenCalled();
    });

    it('shows a server validation message under the field and stays on the page', async () => {
        fakeApi({
            'POST /api/v1/widgets': {
                status: 422,
                json: {
                    error: {
                        code: 'validation_failed',
                        message: 'Invalid',
                        details: { name: ['That name is taken.'] },
                    },
                },
            },
        });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(view.byTestId('widget-create'));
        await fill(
            body.byTestId('widget-create-dialog')?.querySelector('input') ??
                null,
            'Docs',
        );
        await click(body.byTestId('widget-create-submit'));
        await flush();

        expect(body.byTestId('widget-create-dialog')?.textContent).toContain(
            'That name is taken.',
        );
        expect(routerMock.visit).not.toHaveBeenCalled();
    });
});

describe('delete widget', () => {
    it('confirms, deletes and removes the card', async () => {
        const api = fakeApi({ 'DELETE /api/v1/widgets/w1': { status: 204 } });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-delete-w1'));

        expect(body.byTestId('widget-delete-dialog')?.textContent).toContain(
            'Delete Marketing site?',
        );
        expect(api.calls).toHaveLength(0);

        await click(body.byTestId('widget-delete-confirm'));
        await flush();

        expect(api.to('DELETE', '/api/v1/widgets/w1')).toHaveLength(1);
        expect(view.byTestId('widget-card-w1')).toBeNull();
        expect(view.byTestId('widget-card-w2')).not.toBeNull();
        expect(toast.success).toHaveBeenCalled();
    });

    it('keeps the card and shows the reason when deleting fails', async () => {
        fakeApi({
            'DELETE /api/v1/widgets/w1': {
                status: 500,
                json: { error: { code: 'server_error', message: 'x' } },
            },
        });
        const view = await render(<WidgetsIndex widgets={WIDGETS} />);

        await click(byTestId(view.container, 'widget-delete-w1'));
        await click(body.byTestId('widget-delete-confirm'));
        await flush();

        expect(body.byTestId('widget-delete-dialog')?.textContent).toContain(
            'server hit an error',
        );
        expect(view.byTestId('widget-card-w1')).not.toBeNull();
    });
});

describe('empty state', () => {
    it('invites the first widget and has no duplicate header action', async () => {
        const view = await render(<WidgetsIndex widgets={[]} />);

        expect(view.byTestId('widgets-empty')?.textContent).toContain(
            'No widgets yet',
        );
        expect(view.byTestId('widget-create')).toBeNull();

        await click(view.byTestId('widget-create-empty'));

        expect(body.byTestId('widget-create-dialog')).not.toBeNull();
    });
});
