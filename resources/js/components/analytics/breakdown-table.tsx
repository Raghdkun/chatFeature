import { useMemo, useState } from 'react';
import {
    EmptyReport,
    ReportError,
    SkeletonBlock,
} from '@/components/analytics/states';
import { Sparkline } from '@/components/analytics/sparkline';
import { Badge } from '@/components/ui/badge';
import { useTrans } from '@/hooks/use-trans';
import {
    formatCount,
    formatDecimal,
    formatDuration,
} from '@/lib/analytics/format';
import { analyticsApi } from '@/lib/analytics/client';
import { useReport } from '@/lib/analytics/use-report';
import type {
    BreakdownBy,
    BreakdownRow,
    ReportParams,
} from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

const BYS: BreakdownBy[] = ['category', 'widget', 'agent'];
const ULID = /^[0-9A-Za-z]{26}$/;

/** Whether a row can become the page filter: the API filters by ulid (widget, topic) or user id (agent), and "no topic" / "unassigned" is neither. */
function filterable(by: BreakdownBy, row: BreakdownRow): boolean {
    return by === 'agent' ? /^[1-9]\d*$/.test(row.key) : ULID.test(row.key);
}

/**
 * The whole account split by topic, widget or agent (administrators): one row each with its volume trend, handled / missed, the times and the
 * rating. A name is a button that turns it into the page filter (the drill-down). Names are plain text; a deleted widget, topic or account
 * keeps its numbers and says so.
 */
export function BreakdownTable({
    params,
    onFilter,
}: {
    params: ReportParams;
    onFilter: (by: BreakdownBy, key: string) => void;
}) {
    const { t, locale } = useTrans();
    const [by, setBy] = useState<BreakdownBy>('category');
    const key = `${by}:${params.from}:${params.to}`;
    const report = useReport(key, (signal) =>
        analyticsApi.breakdown(params, by, signal),
    );
    const rows = useMemo(() => report.data?.rows ?? [], [report.data]);
    const agentView = by === 'agent';

    return (
        <div className="grid gap-3" data-testid="analytics-breakdown">
            <div
                role="tablist"
                aria-label={t('analytics.breakdown.by')}
                className="flex flex-wrap gap-1.5"
            >
                {BYS.map((option) => (
                    <button
                        key={option}
                        type="button"
                        role="tab"
                        id={`breakdown-tab-${option}`}
                        aria-selected={by === option}
                        aria-controls="breakdown-panel"
                        tabIndex={by === option ? 0 : -1}
                        data-testid={`breakdown-tab-${option}`}
                        onClick={() => setBy(option)}
                        onKeyDown={(event) => {
                            const index = BYS.indexOf(option);

                            if (
                                event.key === 'ArrowRight' ||
                                event.key === 'ArrowLeft'
                            ) {
                                event.preventDefault();
                                const next =
                                    BYS[
                                        (index +
                                            (event.key === 'ArrowRight'
                                                ? 1
                                                : BYS.length - 1)) %
                                            BYS.length
                                    ];

                                setBy(next);
                                document
                                    .getElementById(`breakdown-tab-${next}`)
                                    ?.focus();
                            }
                        }}
                        className={cn(
                            'rounded-md border px-3 py-1 text-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                            by === option
                                ? 'bg-primary text-primary-foreground'
                                : 'bg-card hover:bg-accent',
                        )}
                    >
                        {t(`analytics.breakdown.by_${option}`)}
                    </button>
                ))}
            </div>

            <div
                role="tabpanel"
                id="breakdown-panel"
                aria-labelledby={`breakdown-tab-${by}`}
                aria-busy={report.loading ? 'true' : undefined}
                className={cn(
                    'transition-opacity motion-reduce:transition-none',
                    report.loading && report.data && 'opacity-60',
                )}
            >
                {report.error !== null && (
                    <ReportError
                        error={report.error}
                        onRetry={report.retry}
                        className="mb-3"
                    />
                )}
                {report.data === null && report.loading ? (
                    <SkeletonBlock className="h-40" />
                ) : rows.length === 0 && report.data ? (
                    <EmptyReport title={t('analytics.breakdown.empty')} />
                ) : rows.length > 0 ? (
                    <div className="overflow-x-auto rounded-md border">
                        <table
                            data-testid="breakdown-table"
                            className="w-full min-w-[44rem] text-sm tabular-nums"
                        >
                            <caption className="sr-only">
                                {t(`analytics.breakdown.caption_${by}`)}
                            </caption>
                            <thead className="bg-muted text-xs text-muted-foreground">
                                <tr>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-start font-medium"
                                    >
                                        {t('analytics.breakdown.name')}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-start font-medium"
                                    >
                                        {t('analytics.breakdown.trend')}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {agentView
                                            ? t('analytics.breakdown.accepted')
                                            : t('analytics.breakdown.started')}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {t('analytics.breakdown.handled')}
                                    </th>
                                    {!agentView && (
                                        <th
                                            scope="col"
                                            className="px-3 py-2 text-end font-medium"
                                        >
                                            {t('analytics.breakdown.missed')}
                                        </th>
                                    )}
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {t('analytics.breakdown.wait')}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {t(
                                            'analytics.breakdown.first_response',
                                        )}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {t('analytics.breakdown.handling')}
                                    </th>
                                    <th
                                        scope="col"
                                        className="px-3 py-2 text-end font-medium"
                                    >
                                        {t('analytics.breakdown.rating')}
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {rows.map((row) => (
                                    <tr
                                        key={row.key}
                                        data-testid={`breakdown-row-${row.key}`}
                                        className="border-t"
                                    >
                                        <th
                                            scope="row"
                                            className="px-3 py-2 text-start font-normal"
                                        >
                                            <span className="flex flex-wrap items-center gap-2">
                                                {filterable(by, row) ? (
                                                    <button
                                                        type="button"
                                                        title={t(
                                                            'analytics.breakdown.filter',
                                                            {
                                                                name: row.label,
                                                            },
                                                        )}
                                                        onClick={() =>
                                                            onFilter(
                                                                by,
                                                                row.key,
                                                            )
                                                        }
                                                        className="rounded text-start font-medium underline-offset-4 outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                                                    >
                                                        {row.label}
                                                    </button>
                                                ) : (
                                                    <span className="font-medium">
                                                        {row.label}
                                                    </span>
                                                )}
                                                {row.deleted && (
                                                    <Badge variant="secondary">
                                                        {t(
                                                            'analytics.breakdown.deleted',
                                                        )}
                                                    </Badge>
                                                )}
                                            </span>
                                        </th>
                                        <td className="px-3 py-2">
                                            <Sparkline values={row.sparkline} />
                                        </td>
                                        <td className="px-3 py-2 text-end">
                                            {formatCount(
                                                agentView
                                                    ? row.kpis.handled +
                                                          row.kpis.reclaimed
                                                    : row.kpis.started,
                                                locale,
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-end">
                                            {formatCount(
                                                row.kpis.handled,
                                                locale,
                                            )}
                                        </td>
                                        {!agentView && (
                                            <td className="px-3 py-2 text-end">
                                                {formatCount(
                                                    row.kpis.missed,
                                                    locale,
                                                )}
                                            </td>
                                        )}
                                        <td className="px-3 py-2 text-end">
                                            {formatDuration(
                                                row.kpis.wait.averageSeconds,
                                                locale,
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-end">
                                            {formatDuration(
                                                row.kpis.firstResponse
                                                    .averageSeconds,
                                                locale,
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-end">
                                            {formatDuration(
                                                row.kpis.handling
                                                    .averageSeconds,
                                                locale,
                                            )}
                                        </td>
                                        <td className="px-3 py-2 text-end">
                                            {row.kpis.ratings.count === 0
                                                ? '–'
                                                : `${formatDecimal(row.kpis.ratings.average, locale, 2)} (${formatCount(row.kpis.ratings.count, locale)})`}
                                        </td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                ) : null}
            </div>
        </div>
    );
}
