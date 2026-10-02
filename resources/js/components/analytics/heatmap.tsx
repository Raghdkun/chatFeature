import { useMemo, useState, type KeyboardEvent } from 'react';
import { EmptyReport } from '@/components/analytics/states';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import { formatCount, hourLabel, weekdayName } from '@/lib/analytics/format';
import { cn } from '@/lib/utils';

const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
const DAYS = Array.from({ length: 7 }, (_, day) => day);

function shade(count: number, max: number): string {
    if (count === 0 || max === 0) {
        return 'var(--muted)';
    }

    // One hue, light to dark: the share of the busiest cell, never below a visible wash.
    const share = 18 + Math.round((82 * count) / max);

    return `color-mix(in oklab, var(--heat-high) ${share}%, var(--heat-low))`;
}

/**
 * Weekday x hour of the viewer's time zone, as a grid you can walk with the arrow keys (Home / End: the row's ends, Ctrl+Home / Ctrl+End:
 * the corners). One hue from light to dark; a zero is the muted surface, never a colour. The hovered or focused cell is read out below the
 * grid, and the same numbers are in a table under "View as table".
 */
export function Heatmap({
    matrix,
    max,
    total,
    label,
    unitKey,
}: {
    matrix: number[][];
    max: number;
    total: number;
    /** What the grid counts (the aria label of the grid). */
    label: string;
    /** The plural key family of one cell's sentence (`analytics.heatmap.cell_started` -> `.one` / `.other`). */
    unitKey: string;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const [focus, setFocus] = useState<[number, number]>([0, 0]);
    const [shown, setShown] = useState<[number, number] | null>(null);

    const busiest = useMemo(() => {
        let best: [number, number] = [0, 0];

        matrix.forEach((row, day) =>
            row.forEach((count, hour) => {
                if (count > (matrix[best[0]]?.[best[1]] ?? 0)) {
                    best = [day, hour];
                }
            }),
        );

        return best;
    }, [matrix]);

    if (total === 0) {
        return (
            <EmptyReport title={t('analytics.heatmap.empty')}>
                {t('analytics.state.empty_body')}
            </EmptyReport>
        );
    }

    const describe = (day: number, hour: number): string =>
        plural(unitKey, matrix[day]?.[hour] ?? 0)
            .replace(':day', weekdayName(day, locale))
            .replace(':hour', hourLabel(hour, locale));

    const move = (
        event: KeyboardEvent<HTMLDivElement>,
        day: number,
        hour: number,
    ) => {
        let next: [number, number] | null = null;

        switch (event.key) {
            case 'ArrowRight':
                next = [day, Math.min(23, hour + 1)];
                break;
            case 'ArrowLeft':
                next = [day, Math.max(0, hour - 1)];
                break;
            case 'ArrowDown':
                next = [Math.min(6, day + 1), hour];
                break;
            case 'ArrowUp':
                next = [Math.max(0, day - 1), hour];
                break;
            case 'Home':
                next = event.ctrlKey ? [0, 0] : [day, 0];
                break;
            case 'End':
                next = event.ctrlKey ? [6, 23] : [day, 23];
                break;
            default:
                return;
        }

        event.preventDefault();
        setFocus(next);
        setShown(next);
        document
            .getElementById(`heat-${next[0]}-${next[1]}`)
            ?.focus({ preventScroll: false });
    };

    const [readDay, readHour] = shown ?? busiest;

    return (
        <div className="grid gap-3" data-testid="analytics-heatmap">
            <div className="overflow-x-auto" tabIndex={-1}>
                <div
                    role="grid"
                    aria-label={label}
                    aria-rowcount={8}
                    aria-colcount={25}
                    className="grid min-w-[34rem] gap-0.5 text-[0.65rem] text-muted-foreground"
                    style={{
                        gridTemplateColumns:
                            '2.75rem repeat(24, minmax(0, 1fr))',
                    }}
                    onMouseLeave={() => setShown(null)}
                >
                    <div role="row" className="contents">
                        <span role="columnheader">
                            <span className="sr-only">
                                {t('analytics.heatmap.weekday')}
                            </span>
                        </span>
                        {HOURS.map((hour) => (
                            <span
                                key={hour}
                                role="columnheader"
                                className="text-center tabular-nums"
                            >
                                <span className="sr-only">
                                    {hourLabel(hour, locale)}
                                </span>
                                <span aria-hidden>
                                    {hour % 3 === 0 ? hour : ''}
                                </span>
                            </span>
                        ))}
                    </div>
                    {DAYS.map((day) => (
                        <div key={day} role="row" className="contents">
                            <span
                                role="rowheader"
                                className="flex items-center pe-1 text-xs"
                            >
                                {weekdayName(day, locale, 'short')}
                            </span>
                            {HOURS.map((hour) => {
                                const count = matrix[day]?.[hour] ?? 0;
                                const current =
                                    focus[0] === day && focus[1] === hour;

                                return (
                                    <div
                                        key={hour}
                                        id={`heat-${day}-${hour}`}
                                        role="gridcell"
                                        tabIndex={current ? 0 : -1}
                                        aria-label={describe(day, hour)}
                                        data-count={count}
                                        data-testid={`heat-${day}-${hour}`}
                                        onFocus={() => {
                                            setFocus([day, hour]);
                                            setShown([day, hour]);
                                        }}
                                        onMouseEnter={() =>
                                            setShown([day, hour])
                                        }
                                        onKeyDown={(event) =>
                                            move(event, day, hour)
                                        }
                                        className={cn(
                                            'h-6 rounded-[3px] outline-none',
                                            'focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-card',
                                            'hover:ring-2 hover:ring-foreground/40',
                                        )}
                                        style={{
                                            background: shade(count, max),
                                        }}
                                    />
                                );
                            })}
                        </div>
                    ))}
                </div>
            </div>

            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
                <p
                    aria-live="polite"
                    data-testid="analytics-heatmap-readout"
                    className="text-sm"
                >
                    {shown === null && (
                        <span className="text-muted-foreground">
                            {t('analytics.heatmap.busiest')}{' '}
                        </span>
                    )}
                    <span className="font-medium">
                        {describe(readDay, readHour)}
                    </span>
                </p>
                <div
                    aria-hidden
                    className="flex items-center gap-2 text-xs text-muted-foreground"
                >
                    {t('analytics.heatmap.fewer')}
                    <span
                        className="h-2.5 w-24 rounded-full"
                        style={{
                            background:
                                'linear-gradient(to right, var(--heat-low), var(--heat-high))',
                        }}
                    />
                    {t('analytics.heatmap.more')} ({formatCount(max, locale)})
                </div>
            </div>

            <details data-testid="analytics-heatmap-table" className="text-sm">
                <summary className="w-fit cursor-pointer rounded text-xs text-muted-foreground underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50">
                    {t('analytics.heatmap.table')}
                </summary>
                <div className="mt-2 max-h-80 overflow-auto rounded-md border">
                    <table className="w-full text-xs tabular-nums">
                        <caption className="sr-only">{label}</caption>
                        <thead className="sticky top-0 bg-muted text-muted-foreground">
                            <tr>
                                <th
                                    scope="col"
                                    className="px-2 py-1.5 text-start font-medium"
                                >
                                    {t('analytics.heatmap.weekday')}
                                </th>
                                {HOURS.map((hour) => (
                                    <th
                                        key={hour}
                                        scope="col"
                                        className="px-1.5 py-1.5 text-end font-medium"
                                    >
                                        {hour}
                                    </th>
                                ))}
                            </tr>
                        </thead>
                        <tbody>
                            {DAYS.map((day) => (
                                <tr key={day} className="border-t">
                                    <th
                                        scope="row"
                                        className="px-2 py-1.5 text-start font-normal"
                                    >
                                        {weekdayName(day, locale)}
                                    </th>
                                    {HOURS.map((hour) => (
                                        <td
                                            key={hour}
                                            className="px-1.5 py-1.5 text-end"
                                        >
                                            {matrix[day]?.[hour] ?? 0}
                                        </td>
                                    ))}
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            </details>
        </div>
    );
}
