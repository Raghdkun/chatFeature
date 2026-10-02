import '@/tests/dom-polyfills';
import { act } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import AnalyticsIndex from '@/pages/analytics/index';
import {
    OPTIONS,
    TOPIC_BILLING,
    WIDGET_OLD,
    pageProps,
    renderAnalytics,
    TODAY,
    useAnalyticsBackend,
    viewerFor,
    waitFor,
} from '@/tests/analytics-kit';
import { choose, fill } from '@/tests/dom';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { makeBreakdownRow, makeKpis } from '@/tests/msw/analytics';
import { click, render } from '@/tests/render';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

const backend = useAnalyticsBackend({
    breakdown: {
        category: [
            makeBreakdownRow({
                key: TOPIC_BILLING,
                label: 'Billing',
            }),
            makeBreakdownRow({
                key: '0',
                label: 'No topic',
                kpis: makeKpis({ started: 5 }),
            }),
        ],
        widget: [
            makeBreakdownRow({
                key: WIDGET_OLD,
                label: 'Old shop',
                deleted: true,
            }),
        ],
        agent: [makeBreakdownRow({ key: '7', label: 'Sam' })],
    },
});

const text = (
    view: { byTestId: (id: string) => HTMLElement | null },
    id: string,
) => view.byTestId(id)?.textContent ?? '';

describe("the administrator's dashboard", () => {
    it('shows the headline numbers of the period', async () => {
        const view = await renderAnalytics('admin');

        expect(text(view, 'kpi-started-value')).toBe('120');
        expect(text(view, 'kpi-handled-value')).toBe('100');
        expect(text(view, 'kpi-handled')).toContain('Answer rate 89%');
        expect(text(view, 'kpi-missed-value')).toBe('12');
        expect(text(view, 'kpi-wait-value')).toBe('43s');
        expect(text(view, 'kpi-firstResponse-value')).toBe('25s');
        expect(text(view, 'kpi-handling-value')).toBe('10m 12s');
        expect(text(view, 'kpi-rating-value')).toBe('4.40');
        expect(text(view, 'kpi-rating')).toContain('from 40 ratings');
        expect(text(view, 'kpi-peak-value')).toBe('6');
        expect(text(view, 'kpi-peak')).toContain('queue up to 3');
        expect(view.container.querySelector('h1')?.textContent).toBe(
            'Analytics',
        );
        expect(view.container.textContent).toContain('counted in UTC');
    });

    it('says how each number moved, in words and an arrow, and whether that is better', async () => {
        const view = await renderAnalytics('admin');
        const delta = (id: string) => text(view, `kpi-${id}-delta`);

        expect(delta('started')).toContain('Up 20%');
        expect(delta('started')).not.toContain('(better)'); // more chats is neither good nor bad
        expect(delta('missed')).toContain('Down 20%');
        expect(delta('missed')).toContain('(better)'); // fewer missed chats
        expect(delta('wait')).toContain('Down 15%');
        expect(delta('wait')).toContain('(better)');
        expect(delta('firstResponse')).toContain('Unchanged');
        expect(delta('peak')).toContain('Up from none');
        expect(delta('rating')).toContain('Unchanged');
        expect(delta('started')).toContain('vs the previous 30 days');
        expect(delta('started')).toContain('Previous period: 100.');

        // The arrow is decoration; the words carry the meaning.
        expect(
            view
                .byTestId('kpi-started-delta')
                ?.querySelector('svg')
                ?.getAttribute('aria-hidden'),
        ).toBe('true');
    });

    it('marks a move for the worse in words too', async () => {
        backend.use({ kpis: makeKpis({ missed: 30 }) });
        const view = await renderAnalytics('admin');

        expect(text(view, 'kpi-missed-delta')).toContain('Up 100%');
        expect(text(view, 'kpi-missed-delta')).toContain('(worse)');
    });

    it('asks for the comparison and drops the deltas when it is switched off', async () => {
        const view = await renderAnalytics('admin');

        expect(backend.current.callsTo('overview')[0].query.compare).toBe('1');

        await click(view.byTestId('analytics-compare'));
        await waitFor(() =>
            expect(
                backend.current.callsTo('overview').at(-1)?.query.compare,
            ).toBeUndefined(),
        );
        await waitFor(() =>
            expect(view.byTestId('kpi-started-delta')).toBeNull(),
        );
        expect(window.location.search).toContain('compare=0');
    });

    it('loads every report for the same period', async () => {
        await renderAnalytics('admin');
        await waitFor(() =>
            expect(backend.current.callsTo('whatsapp')).toHaveLength(1),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('ratings')).toHaveLength(1),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('heatmap')).toHaveLength(1),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('timeseries')).toHaveLength(4),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('breakdown')).toHaveLength(1),
        );

        for (const call of backend.current.calls) {
            expect(call.query.from).toBe('2026-02-26');
            expect(call.query.to).toBe(TODAY);
        }

        const metrics = backend.current
            .callsTo('timeseries')
            .map((call) => call.query.metric)
            .sort();

        expect(metrics).toEqual([
            'handling_avg',
            'rating_avg',
            'started,handled,missed',
            'wait_avg,frt_avg',
        ]);
        expect(backend.current.callsTo('timeseries')[0].query.interval).toBe(
            'day',
        );
    });

    it('re-queries everything when a preset is chosen, and the link follows', async () => {
        const view = await renderAnalytics('admin');

        await click(view.byTestId('analytics-preset-7d'));

        await waitFor(() =>
            expect(
                backend.current.callsTo('overview').at(-1)?.query,
            ).toMatchObject({ from: '2026-03-21', to: TODAY }),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('heatmap').at(-1)?.query.from).toBe(
                '2026-03-21',
            ),
        );
        expect(
            view.byTestId('analytics-preset-7d')?.getAttribute('aria-pressed'),
        ).toBe('true');
        expect(
            view.byTestId('analytics-preset-30d')?.getAttribute('aria-pressed'),
        ).toBe('false');
        expect(window.location.search).toBe('?from=2026-03-21&to=2026-03-27');
    });

    it('takes a custom range and refuses a bad one without asking the server', async () => {
        const view = await renderAnalytics('admin');

        await click(view.byTestId('analytics-preset-custom'));
        const before = backend.current.callsTo('overview').length;

        await fill(
            view.byTestId('analytics-from') as HTMLInputElement,
            '2026-03-20',
        );
        await waitFor(() =>
            expect(backend.current.callsTo('overview').at(-1)?.query.from).toBe(
                '2026-03-20',
            ),
        );

        await fill(
            view.byTestId('analytics-from') as HTMLInputElement,
            '2026-04-30',
        );
        expect(view.byTestId('analytics-range-problem')?.textContent).toContain(
            'must not be after the end',
        );
        expect(
            view.byTestId('analytics-from')?.getAttribute('aria-invalid'),
        ).toBe('true');
        expect(backend.current.callsTo('overview').length).toBe(before + 1);
    });

    it('narrows to ONE widget, topic or agent at a time', async () => {
        const view = await renderAnalytics('admin');
        const widget = view.byTestId(
            'analytics-filter-widget',
        ) as HTMLSelectElement;
        const category = view.byTestId(
            'analytics-filter-category',
        ) as HTMLSelectElement;

        await choose(widget, OPTIONS.widgets[0].key);
        await waitFor(() =>
            expect(
                backend.current.callsTo('overview').at(-1)?.query.widget,
            ).toBe(OPTIONS.widgets[0].key),
        );
        expect(view.container.textContent).toContain('One filter at a time');

        await choose(category, OPTIONS.categories[0].key);
        await waitFor(() =>
            expect(
                backend.current.callsTo('overview').at(-1)?.query,
            ).toMatchObject({ category: OPTIONS.categories[0].key }),
        );
        expect(
            backend.current.callsTo('overview').at(-1)?.query.widget,
        ).toBeUndefined();
        expect(
            (view.byTestId('analytics-filter-widget') as HTMLSelectElement)
                .value,
        ).toBe('');
        expect(window.location.search).toContain(
            `category=${OPTIONS.categories[0].key}`,
        );
        expect(window.location.search).not.toContain('widget=');

        // The breakdown is the whole account: a filter never reaches it.
        expect(
            backend.current
                .callsTo('breakdown')
                .every(
                    (call) =>
                        call.query.widget === undefined &&
                        call.query.category === undefined,
                ),
        ).toBe(true);
    });

    it('lists a deleted widget in the menu as deleted (its numbers stay)', async () => {
        const view = await renderAnalytics('admin');

        expect(view.byTestId('analytics-filter-widget')?.textContent).toContain(
            'Old shop (deleted)',
        );
    });

    it('offers the breakdown by topic, widget and agent and drills down from a name', async () => {
        const view = await renderAnalytics('admin');

        await waitFor(() =>
            expect(view.byTestId('breakdown-table')).not.toBeNull(),
        );
        expect(text(view, `breakdown-row-${TOPIC_BILLING}`)).toContain(
            'Billing',
        );
        // "No topic" cannot be a filter: it is a plain name, not a button.
        expect(
            view.byTestId('breakdown-row-0')?.querySelector('button'),
        ).toBeNull();

        await click(
            view
                .byTestId(`breakdown-row-${TOPIC_BILLING}`)
                ?.querySelector('button') as HTMLElement,
        );
        await waitFor(() =>
            expect(
                backend.current.callsTo('overview').at(-1)?.query.category,
            ).toBe(TOPIC_BILLING),
        );

        await click(view.byTestId('breakdown-tab-widget'));
        await waitFor(() =>
            expect(view.byTestId(`breakdown-row-${WIDGET_OLD}`)).not.toBeNull(),
        );
        expect(text(view, `breakdown-row-${WIDGET_OLD}`)).toContain('deleted');

        await click(view.byTestId('breakdown-tab-agent'));
        await waitFor(() =>
            expect(view.byTestId('breakdown-row-7')).not.toBeNull(),
        );
        expect(
            view.byTestId('breakdown-table')?.querySelector('th[scope="col"]')
                ?.textContent,
        ).toBe('Name');
    });

    it('shows the WhatsApp section to an administrator', async () => {
        const view = await renderAnalytics('admin');

        await waitFor(() =>
            expect(view.byTestId('analytics-whatsapp')).not.toBeNull(),
        );
        await waitFor(() =>
            expect(view.byTestId('wa-kpi-linked')).not.toBeNull(),
        );
        expect(text(view, 'wa-kpi-linked')).toContain('12 (40%)');
        expect(text(view, 'wa-kpi-response')).toContain('14m');
    });

    it('shows ratings with the latest comments as plain text', async () => {
        const view = await renderAnalytics('admin');

        await waitFor(() =>
            expect(view.byTestId('analytics-recent-ratings')).not.toBeNull(),
        );
        expect(text(view, 'analytics-recent-ratings')).toContain(
            'Fast and friendly <b>thanks</b>',
        );
        expect(
            view.byTestId('analytics-recent-ratings')?.querySelector('b'),
        ).toBeNull();
        expect(text(view, 'analytics-recent-ratings')).toContain('No comment');
        expect(text(view, 'rating-row-5')).toContain('23');
    });

    it('switches the heatmap between chats started and chats accepted', async () => {
        const view = await renderAnalytics('admin');

        await waitFor(() =>
            expect(view.byTestId('analytics-heatmap')).not.toBeNull(),
        );
        expect(backend.current.callsTo('heatmap')[0].query.metric).toBe(
            'started',
        );

        await click(view.byTestId('heatmap-metric-claimed'));
        await waitFor(() =>
            expect(
                backend.current.callsTo('heatmap').at(-1)?.query.metric,
            ).toBe('claimed'),
        );
        expect(
            view
                .byTestId('heatmap-metric-claimed')
                ?.getAttribute('aria-pressed'),
        ).toBe('true');
    });

    it("sends the viewer's own time zone with the heatmap", async () => {
        await renderAnalytics('admin');
        await waitFor(() =>
            expect(backend.current.callsTo('heatmap')).toHaveLength(1),
        );

        expect(backend.current.callsTo('heatmap')[0].query.tz).toBe(
            Intl.DateTimeFormat().resolvedOptions().timeZone,
        );
    });

    it('offers a CSV export of exactly the period and filter on screen', async () => {
        const view = await renderAnalytics('admin');

        await choose(
            view.byTestId('analytics-filter-agent') as HTMLSelectElement,
            '8',
        );
        await waitFor(() =>
            expect(
                (
                    view.byTestId('analytics-export') as HTMLAnchorElement
                ).getAttribute('href'),
            ).toContain('agent=8'),
        );

        const href =
            (
                view.byTestId('analytics-export') as HTMLAnchorElement
            ).getAttribute('href') ?? '';

        expect(href).toContain('/api/v1/analytics/export?');
        expect(href).toContain('from=2026-02-26');
        expect(href).toContain('format=csv');
    });

    it('swaps to the one-agent numbers when an administrator filters by an agent', async () => {
        const view = await renderAnalytics('admin');

        await choose(
            view.byTestId('analytics-filter-agent') as HTMLSelectElement,
            '8',
        );
        await waitFor(() => expect(view.byTestId('kpi-started')).toBeNull());
        expect(view.byTestId('kpi-firstResponse')).not.toBeNull();

        await waitFor(() => {
            const metrics = backend.current
                .callsTo('timeseries')
                .filter((call) => call.query.agent === '8')
                .map((call) => call.query.metric);

            expect(metrics.sort()).toEqual([
                'frt_avg',
                'handled,ended',
                'handling_avg',
                'rating_avg',
            ]);
        });
        await waitFor(() =>
            expect(
                backend.current.callsTo('heatmap').at(-1)?.query.metric,
            ).toBe('claimed'),
        );
        expect(view.byTestId('heatmap-metric-started')).toBeNull();
    });
});

describe('states', () => {
    it('shows skeletons while the first numbers load', async () => {
        backend.use({ delay: 80 });
        resetInertiaMock({
            locale: 'en',
            auth: {
                user: viewerFor('admin'),
                mode: 'fortify',
                capabilities: {},
            },
        });
        const view = await render(<AnalyticsIndex {...pageProps('admin')} />);

        expect(
            view.container.querySelectorAll(
                '[data-testid="analytics-skeleton"]',
            ).length,
        ).toBeGreaterThan(4);
        expect(
            view.container
                .querySelector('[role="status"][aria-busy="true"]')
                ?.getAttribute('aria-label'),
        ).toBe('Loading the numbers');

        await waitFor(() =>
            expect(view.byTestId('kpi-handled-value')).not.toBeNull(),
        );
        expect(view.byTestId('kpi-handled')).not.toBeNull();
    });

    it('tells a failed report from an empty one, and retries', async () => {
        backend.current.fail('overview', 500, 1);
        resetInertiaMock({
            locale: 'en',
            auth: {
                user: viewerFor('admin'),
                mode: 'fortify',
                capabilities: {},
            },
        });
        const view = await render(<AnalyticsIndex {...pageProps('admin')} />);

        await waitFor(() =>
            expect(view.byTestId('analytics-error')).not.toBeNull(),
        );
        expect(view.byTestId('analytics-error')?.getAttribute('role')).toBe(
            'alert',
        );
        expect(text(view, 'analytics-error')).toContain('could not be loaded');

        await click(
            view
                .byTestId('analytics-error')
                ?.querySelector('button') as HTMLElement,
        );
        await waitFor(() =>
            expect(view.byTestId('kpi-handled-value')).not.toBeNull(),
        );
        expect(
            view.container.querySelector(
                '[data-testid="analytics-kpis"] [data-testid="analytics-error"]',
            ),
        ).toBeNull();
    });

    it('says plainly when access is refused (no retry button)', async () => {
        backend.current.fail('overview', 403);
        resetInertiaMock({
            locale: 'en',
            auth: {
                user: viewerFor('admin'),
                mode: 'fortify',
                capabilities: {},
            },
        });
        const view = await render(<AnalyticsIndex {...pageProps('admin')} />);

        await waitFor(() =>
            expect(view.byTestId('analytics-error')).not.toBeNull(),
        );
        expect(text(view, 'analytics-error')).toContain('do not have access');
        expect(
            view.byTestId('analytics-error')?.querySelector('button'),
        ).toBeNull();
    });

    it('keeps the old chart and shows the error when only a chart fails', async () => {
        backend.current.fail('timeseries', 500);
        const view = await renderAnalytics('admin');

        await waitFor(() =>
            expect(
                view.allByTestId('analytics-error').length,
            ).toBeGreaterThanOrEqual(1),
        );
        expect(view.byTestId('kpi-handled-value')).not.toBeNull();
    });

    it('says so when nothing happened in the period', async () => {
        backend.use({
            kpis: makeKpis({
                started: 0,
                handled: 0,
                missed: 0,
                cancelled: 0,
                ended: 0,
                closed: 0,
                answerRate: null,
                wait: { averageSeconds: null, maxSeconds: 0, count: 0 },
                firstResponse: {
                    averageSeconds: null,
                    maxSeconds: 0,
                    count: 0,
                },
                handling: { averageSeconds: null, maxSeconds: 0, count: 0 },
                ratings: {
                    count: 0,
                    average: null,
                    distribution: [0, 0, 0, 0, 0],
                },
                messages: { visitor: 0, agent: 0, perChat: null },
                peakConcurrent: 0,
                queuePeak: 0,
            }),
        });
        const view = await renderAnalytics('admin');

        expect(view.byTestId('analytics-nothing')?.textContent).toContain(
            'Nothing happened in this period',
        );
        expect(text(view, 'kpi-wait-value')).toBe('–');
        expect(text(view, 'kpi-rating')).toContain('No ratings yet');
    });

    it('explains numbers that are still being prepared and a changed time zone', async () => {
        backend.use({ meta: { missingDays: 3, timezoneChanged: true } });
        const view = await renderAnalytics('admin');

        expect(text(view, 'analytics-notice')).toContain(
            'numbers of 3 days are still being prepared',
        );
        expect(text(view, 'analytics-notice')).toContain('another time zone');
        expect(view.byTestId('analytics-notice')?.getAttribute('role')).toBe(
            'status',
        );
    });

    it('uses the singular for one day', async () => {
        backend.use({ meta: { missingDays: 1 } });
        const view = await renderAnalytics('admin');

        expect(text(view, 'analytics-notice')).toContain(
            'numbers of 1 day are still',
        );
    });
});

describe("an agent's own view", () => {
    it('is "My performance" with only their own numbers', async () => {
        backend.use({ role: 'agent' });
        const view = await renderAnalytics('agent');

        expect(view.container.querySelector('h1')?.textContent).toBe(
            'My performance',
        );
        expect(view.byTestId('kpi-handled')).not.toBeNull();
        expect(view.byTestId('kpi-firstResponse')).not.toBeNull();
        expect(view.byTestId('kpi-messages')).not.toBeNull();

        for (const id of ['started', 'missed', 'wait']) {
            expect(view.byTestId(`kpi-${id}`), id).toBeNull();
        }

        expect(view.byTestId('analytics-filter-widget')).toBeNull();
        expect(view.byTestId('analytics-filter-agent')).toBeNull();
        expect(view.byTestId('analytics-export')).toBeNull();
        expect(view.byTestId('analytics-breakdown-panel')).toBeNull();
        expect(view.byTestId('analytics-whatsapp')).toBeNull();
        expect(view.byTestId('heatmap-metric-started')).toBeNull();
    });

    it('never asks for an administrator-only report or a filter', async () => {
        backend.use({ role: 'agent' });
        const view = await renderAnalytics('agent');

        await waitFor(() =>
            expect(backend.current.callsTo('timeseries')).toHaveLength(4),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('ratings')).toHaveLength(1),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('heatmap')).toHaveLength(1),
        );
        await click(view.byTestId('analytics-preset-7d'));
        await waitFor(() =>
            expect(backend.current.callsTo('overview').at(-1)?.query.from).toBe(
                '2026-03-21',
            ),
        );

        expect(backend.current.callsTo('breakdown')).toEqual([]);
        expect(backend.current.callsTo('whatsapp')).toEqual([]);

        for (const call of backend.current.calls) {
            expect(call.query.widget, call.path).toBeUndefined();
            expect(call.query.category, call.path).toBeUndefined();
            expect(call.query.agent, call.path).toBeUndefined();
        }
    });

    it('asks only for the metrics an agent has, and accepted chats for the heatmap', async () => {
        backend.use({ role: 'agent' });
        await renderAnalytics('agent');
        await waitFor(() =>
            expect(backend.current.callsTo('timeseries')).toHaveLength(4),
        );
        await waitFor(() =>
            expect(backend.current.callsTo('heatmap')).toHaveLength(1),
        );

        expect(
            backend.current
                .callsTo('timeseries')
                .map((call) => call.query.metric)
                .sort(),
        ).toEqual(['frt_avg', 'handled,ended', 'handling_avg', 'rating_avg']);
        expect(backend.current.callsTo('heatmap')[0].query.metric).toBe(
            'claimed',
        );
    });

    it("sees their rating numbers but never the visitors' comments", async () => {
        backend.use({ role: 'agent' });
        const view = await renderAnalytics('agent');

        await waitFor(() =>
            expect(view.byTestId('analytics-ratings')).not.toBeNull(),
        );
        expect(text(view, 'rating-row-5')).toContain('23');
        expect(view.byTestId('analytics-recent-ratings')).toBeNull();
        expect(text(view, 'analytics-ratings')).toContain(
            'visible to administrators only',
        );
    });

    it('survives an API that refuses what the page did not ask for', async () => {
        backend.use({ role: 'agent' });
        const view = await renderAnalytics('agent');

        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 30));
        });

        expect(view.byTestId('analytics-error')).toBeNull();
    });
});

describe('locale and direction', () => {
    it('formats durations and weekday names in the page locale', async () => {
        const view = await renderAnalytics('admin', {}, 'ar');

        // The unit of "43s" is Arabic, and so are the weekday names of the heatmap's sentences.
        expect(text(view, 'kpi-wait-value')).not.toBe('43s');
        expect(text(view, 'kpi-wait-value')).toMatch(/[\u0600-\u06FF]/);
        await waitFor(() => expect(view.byTestId('heat-1-14')).not.toBeNull());
        expect(view.byTestId('heat-1-14')?.getAttribute('aria-label')).toMatch(
            /[\u0600-\u06FF]/,
        );
        expect(view.container.querySelector('h1')?.textContent).toBe(
            'Analytics',
        );
    });
});
