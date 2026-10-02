import '@/tests/dom-polyfills';
import { act, useState } from 'react';
import { describe, expect, it, vi } from 'vite-plus/test';
import { Heatmap } from '@/components/analytics/heatmap';
import { judgement } from '@/components/analytics/kpi-card';
import { RatingsPanel } from '@/components/analytics/ratings-panel';
import { Sparkline } from '@/components/analytics/sparkline';
import { TimeSeriesChart } from '@/components/analytics/time-series-chart';
import { deltaOf } from '@/lib/analytics/format';
import type { SeriesData } from '@/lib/analytics/types';
import { useReport } from '@/lib/analytics/use-report';
import { resetInertiaMock } from '@/tests/inertia-mock';
import { keyDown } from '@/tests/dom';
import { click, render } from '@/tests/render';
import '@/tests/analytics-kit';

vi.mock('@inertiajs/react', async () =>
    (await import('@/tests/inertia-mock')).inertiaMock(),
);

resetInertiaMock({ locale: 'en' });

const points = (values: (number | null)[]) =>
    values.map((value, index) => ({
        date: `2026-03-${String(20 + index).padStart(2, '0')}`,
        value,
        days: 1,
    }));

const SERIES: SeriesData[] = [
    { metric: 'started', unit: 'count', points: points([4, 8, 6]) },
    { metric: 'handled', unit: 'count', points: points([3, 7, 5]) },
    { metric: 'missed', unit: 'count', points: points([1, 1, 0]) },
];
const LABELS = { started: 'Started', handled: 'Handled', missed: 'Missed' };

describe('the line chart', () => {
    const chart = (series = SERIES) => (
        <TimeSeriesChart
            id="c"
            label="Chats over time"
            series={series}
            unit="count"
            interval="day"
            labels={LABELS}
        />
    );

    it('has a name, a spoken summary and a table of exactly the values drawn', async () => {
        const view = await render(chart());

        expect(view.byTestId('c-figure')?.getAttribute('aria-label')).toBe(
            'Chats over time',
        );
        expect(
            view.container.querySelector('#c-summary')?.textContent,
        ).toContain('Started: lowest 4, highest 8, latest 6.');
        expect(
            view.byTestId('c-figure')?.getAttribute('aria-describedby'),
        ).toBe('c-summary');

        const table = view
            .byTestId('c-table')
            ?.querySelector('table') as HTMLTableElement;
        const header = Array.from(table.querySelectorAll('thead th')).map(
            (cell) => cell.textContent,
        );
        const rows = Array.from(table.querySelectorAll('tbody tr')).map((row) =>
            Array.from(row.querySelectorAll('th, td')).map(
                (cell) => cell.textContent,
            ),
        );

        expect(header).toEqual(['Period', 'Started', 'Handled', 'Missed']);
        expect(rows).toEqual([
            ['Mar 20', '4', '3', '1'],
            ['Mar 21', '8', '7', '1'],
            ['Mar 22', '6', '5', '0'],
        ]);
        expect(table.querySelector('caption')?.textContent).toContain(
            'Started, Handled, Missed',
        );
        expect(
            view.byTestId('c-table')?.querySelector('summary')?.textContent,
        ).toBe('View as table');
    });

    it('formats durations in the table', async () => {
        const view = await render(
            <TimeSeriesChart
                id="d"
                label="Wait"
                series={[
                    {
                        metric: 'wait_avg',
                        unit: 'seconds',
                        points: points([42.5, 252, null]),
                    },
                ]}
                unit="seconds"
                interval="day"
                labels={{ wait_avg: 'Average wait' }}
            />,
        );

        const cells = Array.from(
            view.container.querySelectorAll('tbody td'),
        ).map((cell) => cell.textContent);

        expect(cells).toEqual(['43s', '4m 12s', '–']);
    });

    it('names the series in a legend of toggle buttons and keeps at least one visible', async () => {
        const view = await render(chart());
        const toggle = (metric: string) =>
            view.byTestId(`c-toggle-${metric}`) as HTMLButtonElement;

        expect(view.byTestId('c-legend')?.getAttribute('aria-label')).toBe(
            'Series',
        );
        expect(
            ['started', 'handled', 'missed'].map((metric) =>
                toggle(metric).getAttribute('aria-pressed'),
            ),
        ).toEqual(['true', 'true', 'true']);
        expect(toggle('missed').getAttribute('title')).toBe(
            'Show or hide Missed',
        );

        await click(toggle('missed'));
        await click(toggle('handled'));

        expect(toggle('missed').getAttribute('aria-pressed')).toBe('false');
        expect(toggle('started').disabled).toBe(true); // the last visible series cannot be hidden
        expect(view.container.querySelector('#c-summary')?.textContent).toBe(
            'Started: lowest 4, highest 8, latest 6.',
        );
        // The table keeps every series: hiding a line does not hide its numbers.
        expect(
            view.byTestId('c-table')?.querySelectorAll('thead th'),
        ).toHaveLength(4);

        await click(toggle('handled'));
        expect(toggle('handled').getAttribute('aria-pressed')).toBe('true');
        expect(toggle('started').disabled).toBe(false);
    });

    it('needs no legend for a single series (the title names it)', async () => {
        const view = await render(chart([SERIES[0]]));

        expect(view.byTestId('c-legend')).toBeNull();
        expect(view.byTestId('c-figure')).not.toBeNull();
    });

    it('says so instead of drawing an empty chart', async () => {
        const view = await render(
            chart([
                {
                    metric: 'started',
                    unit: 'count',
                    points: points([0, 0, null]),
                },
            ]),
        );

        expect(view.byTestId('analytics-empty')?.textContent).toContain(
            'No data in this period',
        );
        expect(view.byTestId('c-figure')).toBeNull();
    });
});

describe('the heatmap', () => {
    const matrix = () => {
        const grid = Array.from({ length: 7 }, () =>
            Array.from({ length: 24 }, () => 0),
        );

        grid[1][14] = 8;
        grid[1][15] = 4;
        grid[4][9] = 2;

        return grid;
    };
    const heat = (grid = matrix()) => (
        <Heatmap
            matrix={grid}
            max={Math.max(...grid.flat())}
            total={grid.flat().reduce((a, b) => a + b, 0)}
            label="Chats started by weekday and hour"
            unitKey="analytics.heatmap.cell_started"
        />
    );

    it('is a grid of weekdays and hours with a sentence for every cell', async () => {
        const view = await render(heat());
        const grid = view.container.querySelector(
            '[role="grid"]',
        ) as HTMLElement;

        expect(grid.getAttribute('aria-label')).toBe(
            'Chats started by weekday and hour',
        );
        expect(grid.querySelectorAll('[role="row"]')).toHaveLength(8);
        expect(grid.querySelectorAll('[role="gridcell"]')).toHaveLength(7 * 24);
        expect(view.byTestId('heat-1-14')?.getAttribute('aria-label')).toBe(
            'Tuesday, 2:00 PM: 8 chats started',
        );
        expect(view.byTestId('heat-4-9')?.getAttribute('aria-label')).toBe(
            'Friday, 9:00 AM: 2 chats started',
        );
        expect(view.byTestId('heat-0-0')?.getAttribute('aria-label')).toBe(
            'Monday, 12:00 AM: 0 chats started',
        );
    });

    it('uses the muted surface for nothing and one hue, darker for more, for something', async () => {
        const view = await render(heat());
        const style = (id: string) =>
            (view.byTestId(id) as HTMLElement).style.background;

        expect(style('heat-0-0')).toContain('var(--muted)');
        expect(style('heat-1-14')).toContain('var(--heat-high)');
        // the busiest cell mixes more of the dark end than a quieter one
        const share = (id: string) => Number(/(\d+)%/.exec(style(id))?.[1]);

        expect(share('heat-1-14')).toBeGreaterThan(share('heat-4-9'));
        expect(share('heat-1-14')).toBe(100);
    });

    it('is walked with the arrow keys with one tab stop, and the cell in focus is read out', async () => {
        const view = await render(heat());
        const cell = (day: number, hour: number) =>
            view.byTestId(`heat-${day}-${hour}`) as HTMLElement;

        expect(
            view.container.querySelectorAll('[role="gridcell"][tabindex="0"]'),
        ).toHaveLength(1);
        expect(
            view.byTestId('analytics-heatmap-readout')?.textContent,
        ).toContain('Busiest: Tuesday, 2:00 PM: 8 chats started');

        await act(async () => cell(0, 0).focus());
        await keyDown(cell(0, 0), 'ArrowRight');
        expect(document.activeElement?.id).toBe('heat-0-1');
        await keyDown(cell(0, 1), 'ArrowDown');
        expect(document.activeElement?.id).toBe('heat-1-1');
        await keyDown(cell(1, 1), 'End');
        expect(document.activeElement?.id).toBe('heat-1-23');
        await keyDown(cell(1, 23), 'Home');
        expect(document.activeElement?.id).toBe('heat-1-0');
        await keyDown(cell(1, 0), 'ArrowLeft'); // the edge stays
        expect(document.activeElement?.id).toBe('heat-1-0');
        await keyDown(cell(1, 0), 'ArrowUp');
        await keyDown(cell(0, 0), 'ArrowUp');
        expect(document.activeElement?.id).toBe('heat-0-0');
        await keyDown(cell(0, 0), 'End');
        expect(document.activeElement?.id).toBe('heat-0-23');

        const ctrlEnd = new KeyboardEvent('keydown', {
            key: 'End',
            ctrlKey: true,
            bubbles: true,
            cancelable: true,
        });

        await act(async () => cell(0, 23).dispatchEvent(ctrlEnd));
        expect(document.activeElement?.id).toBe('heat-6-23');

        expect(
            view.container.querySelectorAll('[role="gridcell"][tabindex="0"]'),
        ).toHaveLength(1);
        expect(view.byTestId('heat-6-23')?.getAttribute('tabindex')).toBe('0');
        expect(
            view.byTestId('analytics-heatmap-readout')?.textContent,
        ).toContain('Sunday, 11:00 PM: 0 chats');
    });

    it('has the same numbers as a table, weekday by hour', async () => {
        const view = await render(heat());
        const rows =
            view
                .byTestId('analytics-heatmap-table')
                ?.querySelectorAll('tbody tr') ?? [];

        expect(rows).toHaveLength(7);
        expect(rows[1].querySelector('th')?.textContent).toBe('Tuesday');
        expect(Array.from(rows[1].querySelectorAll('td'))[14].textContent).toBe(
            '8',
        );
    });

    it('says so when there is nothing to show', async () => {
        const view = await render(
            heat(
                Array.from({ length: 7 }, () =>
                    Array.from({ length: 24 }, () => 0),
                ),
            ),
        );

        expect(view.byTestId('analytics-empty')?.textContent).toContain(
            'No chats in this period',
        );
        expect(view.container.querySelector('[role="grid"]')).toBeNull();
    });

    it('reads out a hovered cell', async () => {
        const view = await render(heat());

        await act(async () => {
            view.byTestId('heat-4-9')?.dispatchEvent(
                new MouseEvent('mouseover', { bubbles: true }),
            );
            view.byTestId('heat-4-9')?.dispatchEvent(
                new MouseEvent('mouseenter'),
            );
        });
        await act(async () => {
            (view.byTestId('heat-4-9') as HTMLElement).focus();
        });

        expect(
            view.byTestId('analytics-heatmap-readout')?.textContent,
        ).toContain('Friday, 9:00 AM: 2 chats started');
        expect(
            view
                .byTestId('analytics-heatmap-readout')
                ?.getAttribute('aria-live'),
        ).toBe('polite');
    });
});

describe('the sparkline', () => {
    it('is an image with its numbers in words', async () => {
        const view = await render(<Sparkline values={[1, 5, 12, 4]} />);
        const svg = view.container.querySelector('svg') as SVGElement;

        expect(svg.getAttribute('role')).toBe('img');
        expect(svg.getAttribute('aria-label')).toBe(
            'Trend: from 1 to 4, peak 12',
        );
        expect(
            svg.querySelector('polyline')?.getAttribute('points')?.split(' '),
        ).toHaveLength(4);
    });

    it('copes with one point, a flat line and nothing', async () => {
        const one = await render(<Sparkline values={[3]} />);
        const flat = await render(<Sparkline values={[2, 2, 2]} />);
        const none = await render(<Sparkline values={[]} />);

        expect(
            one.container.querySelector('polyline')?.getAttribute('points'),
        ).not.toContain('NaN');
        expect(
            flat.container.querySelector('polyline')?.getAttribute('points'),
        ).not.toContain('NaN');
        expect(none.container.querySelector('svg')).toBeNull();
    });
});

describe('judging a change', () => {
    it('is better or worse only where a metric has a direction', () => {
        expect(judgement(deltaOf(10, 20), 'down')).toBe('better');
        expect(judgement(deltaOf(30, 20), 'down')).toBe('worse');
        expect(judgement(deltaOf(30, 20), 'up')).toBe('better');
        expect(judgement(deltaOf(10, 20), 'up')).toBe('worse');
        expect(judgement(deltaOf(30, 20), 'neutral')).toBeNull();
        expect(judgement(deltaOf(20, 20), 'up')).toBeNull();
        expect(judgement(deltaOf(null, 20), 'up')).toBeNull();
    });
});

describe('the ratings panel', () => {
    const ratings = { count: 10, average: 4.2, distribution: [0, 1, 1, 3, 5] };
    const entry = {
        conversation: 'C'.repeat(26),
        score: 4,
        comment: '<img src=x onerror=alert(1)>',
        createdAt: '2026-03-20T10:00:00.000Z',
        widget: 'Main',
        category: null,
        agent: 'Sam',
    };

    it('lists the stars with counts and shares, thin bars only repeating the numbers', async () => {
        const view = await render(
            <RatingsPanel ratings={ratings} recent={[]} admin />,
        );

        expect(view.byTestId('rating-row-5')?.textContent).toContain('5 stars');
        expect(view.byTestId('rating-row-5')?.textContent).toContain('5 (50%)');
        expect(view.byTestId('rating-row-1')?.textContent).toContain('1 star');
        expect(
            view
                .byTestId('rating-row-5')
                ?.querySelector('[aria-hidden="true"]'),
        ).not.toBeNull();
        expect(view.container.textContent).toContain('4.20');
        expect(view.container.textContent).toContain('average from 10 ratings');
    });

    it('shows an administrator the comments as text, and an agent only a note', async () => {
        const admin = await render(
            <RatingsPanel ratings={ratings} recent={[entry]} admin />,
        );

        expect(
            admin.byTestId('analytics-recent-ratings')?.textContent,
        ).toContain('<img src=x onerror=alert(1)>');
        expect(
            admin.byTestId('analytics-recent-ratings')?.querySelector('img'),
        ).toBeNull();
        expect(
            admin
                .byTestId('analytics-recent-ratings')
                ?.querySelector('a')
                ?.getAttribute('href'),
        ).toBe(`/inbox/${entry.conversation}`);

        const agent = await render(
            <RatingsPanel ratings={ratings} recent={[entry]} admin={false} />,
        );

        expect(agent.byTestId('analytics-recent-ratings')).toBeNull();
        expect(agent.container.textContent).toContain(
            'visible to administrators only',
        );
        expect(agent.container.textContent).not.toContain('onerror');
    });

    it('says so when nobody rated', async () => {
        const view = await render(
            <RatingsPanel
                ratings={{
                    count: 0,
                    average: null,
                    distribution: [0, 0, 0, 0, 0],
                }}
                recent={[]}
                admin
            />,
        );

        expect(view.byTestId('analytics-empty')?.textContent).toContain(
            'No ratings in this period',
        );
    });
});

describe('useReport', () => {
    type Deferred = {
        resolve: (value: string) => void;
        reject: (error: unknown) => void;
        signal: AbortSignal;
    };

    function Probe({ keyName, calls }: { keyName: string; calls: Deferred[] }) {
        const report = useReport(
            keyName,
            (signal) =>
                new Promise<string>((resolve, reject) => {
                    calls.push({ resolve, reject, signal });
                }),
        );

        return (
            <div>
                <output data-testid="data">{report.data ?? 'none'}</output>
                <output data-testid="loading">{String(report.loading)}</output>
                <output data-testid="error">
                    {report.error === null ? 'no' : 'yes'}
                </output>
                <button data-testid="retry" onClick={report.retry} />
            </div>
        );
    }

    function Harness({ calls }: { calls: Deferred[] }) {
        const [key, setKey] = useState('a');

        return (
            <>
                <button data-testid="next" onClick={() => setKey('b')} />
                <Probe keyName={key} calls={calls} />
            </>
        );
    }

    it('drops an answer that was overtaken and aborts its request', async () => {
        const calls: Deferred[] = [];
        const view = await render(<Harness calls={calls} />);

        expect(view.byTestId('loading')?.textContent).toBe('true');
        await click(view.byTestId('next'));
        expect(calls).toHaveLength(2);
        expect(calls[0].signal.aborted).toBe(true);

        await act(async () => calls[1].resolve('new'));
        await act(async () => calls[0].resolve('old'));

        expect(view.byTestId('data')?.textContent).toBe('new');
        expect(view.byTestId('loading')?.textContent).toBe('false');
    });

    it('keeps the last good data under an error and retries', async () => {
        const calls: Deferred[] = [];
        const view = await render(<Harness calls={calls} />);

        await act(async () => calls[0].resolve('first'));
        await click(view.byTestId('next'));
        expect(view.byTestId('data')?.textContent).toBe('first'); // the frame stays while the next loads
        await act(async () => calls[1].reject(new Error('down')));

        expect(view.byTestId('error')?.textContent).toBe('yes');
        expect(view.byTestId('data')?.textContent).toBe('first');
        expect(view.byTestId('loading')?.textContent).toBe('false');

        await click(view.byTestId('retry'));
        expect(view.byTestId('error')?.textContent).toBe('no');
        await act(async () => calls[2].resolve('second'));
        expect(view.byTestId('data')?.textContent).toBe('second');
    });
});
