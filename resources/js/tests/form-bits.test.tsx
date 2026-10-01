import '@/tests/dom-polyfills';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
    ErrorLines,
    Notice,
    SectionCard,
} from '@/components/widgets/form-bits';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

describe('Notice', () => {
    it('announces a danger notice as an alert, and only that one', async () => {
        resetInertiaMock();

        const view = await render(
            <>
                <Notice tone="danger" data-testid="danger">
                    Boom
                </Notice>
                <Notice tone="warning" data-testid="warning">
                    Careful
                </Notice>
                <Notice data-testid="info">FYI</Notice>
                <Notice tone="success" data-testid="success">
                    Done
                </Notice>
            </>,
        );

        expect(view.byTestId('danger')?.getAttribute('role')).toBe('alert');
        expect(view.byTestId('warning')?.hasAttribute('role')).toBe(false);
        expect(view.byTestId('info')?.hasAttribute('role')).toBe(false);
        expect(view.byTestId('success')?.hasAttribute('role')).toBe(false);
    });

    it('lets a caller override the role', async () => {
        resetInertiaMock();

        const view = await render(
            <Notice tone="danger" role="status" data-testid="n">
                Quiet
            </Notice>,
        );

        expect(view.byTestId('n')?.getAttribute('role')).toBe('status');
    });
});

describe('ErrorLines', () => {
    it('renders one line per message and nothing when there are none', async () => {
        resetInertiaMock();

        const view = await render(
            <>
                <ErrorLines messages={['One.', 'Two.']} data-testid="some" />
                <ErrorLines messages={[]} data-testid="none" />
            </>,
        );

        expect(view.byTestId('some')?.querySelectorAll('p')).toHaveLength(2);
        expect(view.byTestId('none')).toBeNull();
    });
});

describe('SectionCard', () => {
    it('shows the "applies immediately" badge only for live sections', async () => {
        resetInertiaMock();

        const view = await render(
            <>
                <SectionCard live title="Live one" testId="live">
                    x
                </SectionCard>
                <SectionCard title="Draft one" testId="draft">
                    y
                </SectionCard>
            </>,
        );

        expect(view.byTestId('live')?.getAttribute('data-live')).toBe('true');
        expect(view.byTestId('live')?.textContent).toContain(
            'Changes here apply immediately',
        );
        expect(view.byTestId('draft')?.hasAttribute('data-live')).toBe(false);
        expect(view.byTestId('draft')?.textContent).not.toContain(
            'apply immediately',
        );
    });
});
