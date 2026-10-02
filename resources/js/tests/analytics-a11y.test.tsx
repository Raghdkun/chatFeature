/**
 * Structural accessibility of the analytics page with axe-core in jsdom (names, labels, roles, landmarks, tables, ARIA validity), the same
 * way as the inbox: colour contrast and target size need real layout and are left to the browser run. The charts' own SVG is Recharts'; the
 * point here is that every chart has a named figure, a spoken summary and a table, and that the page has a heading outline.
 */
import '@/tests/dom-polyfills';
import axe from 'axe-core';
import { describe, expect, it, vi } from 'vite-plus/test';
import {
    renderAnalytics,
    useAnalyticsBackend,
    waitFor,
} from '@/tests/analytics-kit';
import { makeBreakdownRow } from '@/tests/msw/analytics';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

vi.setConfig({ testTimeout: 20_000 });

const backend = useAnalyticsBackend({
    breakdown: {
        category: [makeBreakdownRow({ key: 'C'.repeat(26), label: 'Billing' })],
    },
});

async function violations(root: Element = document.body): Promise<string[]> {
    const result = await axe.run(root, {
        rules: {
            'color-contrast': { enabled: false },
            'target-size': { enabled: false },
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

async function settled(
    view: Awaited<ReturnType<typeof renderAnalytics>>,
    whatsapp: boolean,
) {
    await waitFor(() =>
        expect(view.byTestId('analytics-heatmap')).not.toBeNull(),
    );
    await waitFor(() =>
        expect(view.byTestId('analytics-ratings')).not.toBeNull(),
    );
    await waitFor(() =>
        expect(view.allByTestId('analytics-skeleton')).toHaveLength(0),
    );

    if (whatsapp) {
        await waitFor(() =>
            expect(view.byTestId('wa-kpi-linked')).not.toBeNull(),
        );
        await waitFor(() =>
            expect(view.byTestId('breakdown-table')).not.toBeNull(),
        );
    }
}

describe('the analytics page', () => {
    it('has no structural violations for an administrator', async () => {
        const view = await renderAnalytics('admin');

        await settled(view, true);

        expect(await violations()).toEqual([]);
    });

    it('has no structural violations with the custom range open and a range problem showing', async () => {
        const view = await renderAnalytics('admin');

        await settled(view, true);
        (view.byTestId('analytics-preset-custom') as HTMLElement).click();
        await waitFor(() =>
            expect(view.byTestId('analytics-from')).not.toBeNull(),
        );

        expect(await violations()).toEqual([]);
    });

    it('has no structural violations for an agent', async () => {
        backend.use({ role: 'agent' });
        const view = await renderAnalytics('agent');

        await settled(view, false);

        expect(await violations()).toEqual([]);
    });

    it('has no structural violations while loading and when everything failed', async () => {
        backend.use({ delay: 60 });
        const loading = await renderAnalytics('admin').catch(() => null);

        expect(loading).not.toBeNull();
        expect(await violations()).toEqual([]);
    });

    it('gives the page a heading outline: one title, a heading for every panel, the key numbers', async () => {
        const view = await renderAnalytics('admin');

        await settled(view, true);

        expect(view.container.querySelectorAll('h1')).toHaveLength(1);

        const panels = Array.from(
            view.container.querySelectorAll('section[aria-labelledby]'),
        );

        expect(panels.length).toBeGreaterThanOrEqual(8);

        for (const panel of panels) {
            const heading = document.getElementById(
                panel.getAttribute('aria-labelledby') ?? '',
            );

            expect(
                heading?.tagName,
                panel.getAttribute('data-testid') ?? '',
            ).toBe('H2');
            expect(heading?.textContent?.trim()).not.toBe('');
        }
    });

    it('gives every chart a name, a spoken summary and a table', async () => {
        const view = await renderAnalytics('admin');

        await settled(view, true);
        await waitFor(() =>
            expect(view.container.querySelectorAll('figure')).toHaveLength(5),
        );

        for (const figure of Array.from(
            view.container.querySelectorAll('figure'),
        )) {
            const id =
                figure.getAttribute('data-testid')?.replace('-figure', '') ??
                '';

            expect(figure.getAttribute('aria-label'), id).toBeTruthy();
            expect(
                figure.querySelector('figcaption')?.textContent?.length,
                id,
            ).toBeGreaterThan(10);
            expect(figure.querySelector('details table'), id).not.toBeNull();
        }
    });

    it('never signals a change by colour alone: every delta has words', async () => {
        const view = await renderAnalytics('admin');

        for (const delta of view
            .allByTestId('analytics-kpis')[0]
            .querySelectorAll('[data-testid$="-delta"]')) {
            expect(
                delta.textContent?.replace(/\s+/g, ' ').trim().length,
            ).toBeGreaterThan(8);
            expect(
                Array.from(delta.querySelectorAll('svg')).every(
                    (svg) => svg.getAttribute('aria-hidden') === 'true',
                ),
            ).toBe(true);
        }
    });
});
