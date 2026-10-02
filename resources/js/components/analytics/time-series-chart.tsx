import { useMemo, useState } from 'react';
import { CartesianGrid, Line, LineChart, XAxis, YAxis } from 'recharts';
import { EmptyReport } from '@/components/analytics/states';
import {
    ChartContainer,
    ChartTooltip,
    type ChartConfig,
} from '@/components/ui/chart';
import { useTrans } from '@/hooks/use-trans';
import { formatBucket, formatValue } from '@/lib/analytics/format';
import { SERIES_VARS } from '@/lib/analytics/palette';
import type { Interval, SeriesData, SeriesUnit } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

type Row = { date: string } & Record<string, number | string | null>;

type TooltipProps = {
    active?: boolean;
    label?: string | number;
    payload?: {
        dataKey?: string | number;
        value?: number | null;
        color?: string;
    }[];
};

function SeriesTooltip({
    props,
    unit,
    interval,
    labelOf,
    colorOf,
}: {
    props: TooltipProps;
    unit: SeriesUnit;
    interval: Interval;
    labelOf: (metric: string) => string;
    colorOf: (metric: string) => string;
}) {
    const { locale } = useTrans();

    if (!props.active || !props.payload?.length) {
        return null;
    }

    return (
        <div
            data-testid="chart-tooltip"
            className="grid min-w-36 gap-1.5 rounded-lg border bg-popover px-3 py-2 text-xs text-popover-foreground shadow-md"
        >
            <p className="font-medium">
                {formatBucket(String(props.label ?? ''), interval, locale)}
            </p>
            {props.payload.map((entry) => {
                const metric = String(entry.dataKey);

                return (
                    <p key={metric} className="flex items-center gap-2">
                        <span
                            aria-hidden
                            className="h-0.5 w-3 shrink-0 rounded-full"
                            style={{ background: colorOf(metric) }}
                        />
                        <span className="font-semibold tabular-nums">
                            {formatValue(entry.value ?? null, unit, locale)}
                        </span>
                        <span className="text-muted-foreground">
                            {labelOf(metric)}
                        </span>
                    </p>
                );
            })}
        </div>
    );
}

/**
 * A line chart of one or more series that share a unit. Thin 2px lines in the fixed categorical order (a series keeps its colour when
 * another is hidden), one tooltip for every series at the hovered or focused date, a legend of toggle buttons (two or more series: identity
 * is never colour alone), keyboard navigation of the points (Recharts' accessibility layer), no animation (so `prefers-reduced-motion`
 * needs nothing), and a table of the same values under "View as table".
 */
export function TimeSeriesChart({
    id,
    label,
    series,
    unit,
    interval,
    labels,
    colorIndex = [0, 1, 2],
    domain,
    height = 220,
}: {
    id: string;
    /** The chart's accessible name (its title). */
    label: string;
    series: SeriesData[];
    unit: SeriesUnit;
    interval: Interval;
    /** metric -> the words for it (legend, tooltip, table). */
    labels: Record<string, string>;
    /** Which categorical slot each series wears, by position (fixed per metric, not per rank). */
    colorIndex?: number[];
    domain?: [number, number];
    height?: number;
}) {
    const { t, locale } = useTrans();
    const [hidden, setHidden] = useState<string[]>([]);
    const visible = series.filter((entry) => !hidden.includes(entry.metric));
    const colorOf = (metric: string): string =>
        SERIES_VARS[
            colorIndex[series.findIndex((entry) => entry.metric === metric)] ??
                0
        ] ?? SERIES_VARS[0];
    const labelOf = (metric: string): string => labels[metric] ?? metric;

    const rows = useMemo<Row[]>(() => {
        const dates = series[0]?.points.map((point) => point.date) ?? [];

        return dates.map((date, index) => {
            const row: Row = { date };

            for (const entry of series) {
                row[entry.metric] = entry.points[index]?.value ?? null;
            }

            return row;
        });
    }, [series]);

    const config = useMemo<ChartConfig>(
        () =>
            Object.fromEntries(
                series.map((entry, position) => [
                    entry.metric,
                    {
                        label: labels[entry.metric] ?? entry.metric,
                        color:
                            SERIES_VARS[colorIndex[position] ?? position] ??
                            SERIES_VARS[0],
                    },
                ]),
            ),
        [series, labels, colorIndex],
    );

    const hasData = series.some((entry) =>
        entry.points.some((point) => point.value !== null && point.value !== 0),
    );

    const summary = visible
        .map((entry) => {
            const values = entry.points
                .map((point) => point.value)
                .filter((value): value is number => value !== null);

            if (values.length === 0) {
                return null;
            }

            return t('analytics.chart.summary', {
                series: labelOf(entry.metric),
                min: formatValue(Math.min(...values), unit, locale),
                max: formatValue(Math.max(...values), unit, locale),
                last: formatValue(values[values.length - 1], unit, locale),
            });
        })
        .filter((line): line is string => line !== null)
        .join(' ');

    if (!hasData) {
        return (
            <EmptyReport title={t('analytics.chart.empty')}>
                {t('analytics.state.empty_body')}
            </EmptyReport>
        );
    }

    const dense = rows.length > 31;

    return (
        <figure
            data-testid={`${id}-figure`}
            aria-label={label}
            aria-describedby={`${id}-summary`}
            className="grid gap-3"
        >
            {series.length > 1 && (
                <ul
                    aria-label={t('analytics.chart.legend')}
                    data-testid={`${id}-legend`}
                    className="flex flex-wrap gap-x-2 gap-y-1"
                >
                    {series.map((entry) => {
                        const on = !hidden.includes(entry.metric);
                        const last = on && visible.length === 1;

                        return (
                            <li key={entry.metric}>
                                <button
                                    type="button"
                                    aria-pressed={on}
                                    disabled={last}
                                    data-testid={`${id}-toggle-${entry.metric}`}
                                    title={t('analytics.chart.toggle', {
                                        series: labelOf(entry.metric),
                                    })}
                                    onClick={() =>
                                        setHidden((previous) =>
                                            previous.includes(entry.metric)
                                                ? previous.filter(
                                                      (item) =>
                                                          item !== entry.metric,
                                                  )
                                                : [...previous, entry.metric],
                                        )
                                    }
                                    className={cn(
                                        'inline-flex items-center gap-2 rounded-md border px-2.5 py-1 text-xs outline-none',
                                        'focus-visible:ring-[3px] focus-visible:ring-ring/50',
                                        on
                                            ? 'bg-secondary text-secondary-foreground'
                                            : 'text-muted-foreground line-through',
                                    )}
                                >
                                    <span
                                        aria-hidden
                                        className="h-0.5 w-4 rounded-full"
                                        style={{
                                            background: colorOf(entry.metric),
                                        }}
                                    />
                                    {labelOf(entry.metric)}
                                </button>
                            </li>
                        );
                    })}
                </ul>
            )}

            <ChartContainer
                id={id}
                config={config}
                className="aspect-auto w-full"
                style={{ height }}
            >
                <LineChart
                    data={rows}
                    accessibilityLayer
                    margin={{ top: 8, right: 12, bottom: 0, left: 0 }}
                >
                    <CartesianGrid vertical={false} />
                    <XAxis
                        dataKey="date"
                        tickLine={false}
                        axisLine={false}
                        tickMargin={8}
                        minTickGap={28}
                        tickFormatter={(value: string) =>
                            formatBucket(value, interval, locale)
                        }
                    />
                    <YAxis
                        width={unit === 'seconds' ? 56 : 44}
                        tickLine={false}
                        axisLine={false}
                        allowDecimals={unit !== 'count'}
                        domain={domain ?? [0, 'auto']}
                        tickFormatter={(value: number) =>
                            formatValue(value, unit, locale)
                        }
                    />
                    <ChartTooltip
                        cursor={{ strokeWidth: 1 }}
                        content={(props) => (
                            <SeriesTooltip
                                props={props as unknown as TooltipProps}
                                unit={unit}
                                interval={interval}
                                labelOf={labelOf}
                                colorOf={colorOf}
                            />
                        )}
                    />
                    {visible.map((entry) => (
                        <Line
                            key={entry.metric}
                            dataKey={entry.metric}
                            type="monotone"
                            stroke={`var(--color-${entry.metric})`}
                            strokeWidth={2}
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            dot={
                                dense
                                    ? false
                                    : {
                                          r: 4,
                                          strokeWidth: 2,
                                          stroke: 'var(--card)',
                                          fill: `var(--color-${entry.metric})`,
                                      }
                            }
                            activeDot={{
                                r: 5,
                                strokeWidth: 2,
                                stroke: 'var(--card)',
                            }}
                            isAnimationActive={false}
                        />
                    ))}
                </LineChart>
            </ChartContainer>

            <figcaption id={`${id}-summary`} className="sr-only">
                {summary}
            </figcaption>

            <details data-testid={`${id}-table`} className="text-sm">
                <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    {t('analytics.chart.table')}
                </summary>
                <div className="mt-2 max-h-72 overflow-auto rounded-md border">
                    <table className="w-full text-start text-xs tabular-nums">
                        <caption className="sr-only">
                            {t('analytics.chart.table_caption', {
                                series: series
                                    .map((entry) => labelOf(entry.metric))
                                    .join(', '),
                            })}
                        </caption>
                        <thead className="sticky top-0 bg-muted text-muted-foreground">
                            <tr>
                                <th
                                    scope="col"
                                    className="px-3 py-1.5 text-start font-medium"
                                >
                                    {t('analytics.chart.table_date')}
                                </th>
                                {series.map((entry) => (
                                    <th
                                        key={entry.metric}
                                        scope="col"
                                        className="px-3 py-1.5 text-end font-medium"
                                    >
                                        {labelOf(entry.metric)}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {rows.map((row) => (
                                <tr key={row.date} className="border-t">
                                    <th
                                        scope="row"
                                        className="px-3 py-1.5 text-start font-normal"
                                    >
                                        {formatBucket(
                                            row.date,
                                            interval,
                                            locale,
                                        )}
                                    </th>
                                    {series.map((entry) => (
                                        <td
                                            key={entry.metric}
                                            className="px-3 py-1.5 text-end"
                                        >
                                            {formatValue(
                                                (row[entry.metric] as
                                                    | number
                                                    | null) ?? null,
                                                unit,
                                                locale,
                                            )}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </details>
        </figure>
    );
}
