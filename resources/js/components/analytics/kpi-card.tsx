import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import { usePlural } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import {
    deltaOf,
    formatCount,
    formatDuration,
    formatPercent,
    formatValue,
    type Delta,
} from '@/lib/analytics/format';
import type { KpiDefinition } from '@/lib/analytics/kpis';
import type { Kpis } from '@/lib/analytics/types';
import { cn } from '@/lib/utils';

/** Whether a move is good, bad or neither for a metric (words and an icon say it; colour only repeats it). */
export function judgement(
    delta: Delta,
    better: KpiDefinition['better'],
): 'better' | 'worse' | null {
    if (delta.kind !== 'up' && delta.kind !== 'down') {
        return null;
    }

    if (better === 'neutral') {
        return null;
    }

    return (delta.kind === 'up') === (better === 'up') ? 'better' : 'worse';
}

function Subtext({ def, kpis }: { def: KpiDefinition; kpis: Kpis }) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    let text: string | null = null;

    switch (def.id) {
        case 'handled':
            text =
                kpis.answerRate === null
                    ? null
                    : t('analytics.kpi.answer_rate', {
                          rate: formatPercent(kpis.answerRate, locale),
                      });
            break;
        case 'rating':
            text =
                kpis.ratings.count === 0
                    ? t('analytics.kpi.no_ratings')
                    : plural('analytics.kpi.ratings_count', kpis.ratings.count);
            break;
        case 'peak':
            text =
                kpis.queuePeak === null
                    ? null
                    : t('analytics.kpi.queue_peak', {
                          count: formatCount(kpis.queuePeak, locale),
                      });
            break;
        case 'wait':
            text = t('analytics.kpi.longest', {
                value: formatDuration(kpis.wait.maxSeconds, locale),
            });
            break;
        case 'firstResponse':
            text = t('analytics.kpi.longest', {
                value: formatDuration(kpis.firstResponse.maxSeconds, locale),
            });
            break;
        case 'handling':
            text = t('analytics.kpi.longest', {
                value: formatDuration(kpis.handling.maxSeconds, locale),
            });
            break;
        case 'offers':
            text =
                kpis.offers.acceptRate === null
                    ? null
                    : t('analytics.kpi.accepted', {
                          rate: formatPercent(kpis.offers.acceptRate, locale),
                      });
            break;
        default:
            break;
    }

    return text === null ? null : (
        <p className="text-xs text-muted-foreground">{text}</p>
    );
}

/**
 * One headline number with its change against the previous period. The change is an arrow AND words ("Up 12%"), and says better or worse
 * in text where "better" has a direction; the colour of the arrow only repeats what the words say.
 */
export function KpiCard({
    def,
    current,
    previous,
    compare,
    previousDays,
}: {
    def: KpiDefinition;
    current: Kpis;
    previous: Kpis | null;
    compare: boolean;
    previousDays: number;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();
    const value = def.value(current);
    const before = previous ? def.value(previous) : null;
    const delta = compare ? deltaOf(value, before) : null;
    const verdict = delta ? judgement(delta, def.better) : null;
    const label = t(`analytics.kpi.${def.id}`);
    const shown = formatValue(value, def.unit, locale);

    return (
        <article
            data-testid={`kpi-${def.id}`}
            aria-label={label}
            className="grid content-start gap-1 rounded-xl border bg-card p-4"
        >
            <h3 className="text-xs font-medium text-muted-foreground">
                {label}
            </h3>
            <p
                data-testid={`kpi-${def.id}-value`}
                className="text-3xl leading-tight font-semibold tracking-tight"
            >
                {shown}
            </p>
            <Subtext def={def} kpis={current} />
            {delta && (
                <p
                    data-testid={`kpi-${def.id}-delta`}
                    className="mt-1 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
                >
                    {delta.kind === 'none' ? (
                        <span>{t('analytics.delta.none')}</span>
                    ) : delta.kind === 'flat' ? (
                        <>
                            <Minus className="size-3.5" aria-hidden />
                            <span>{t('analytics.delta.flat')}</span>
                        </>
                    ) : (
                        <>
                            {delta.kind === 'up' ? (
                                <ArrowUp
                                    className={cn(
                                        'size-3.5',
                                        verdict === 'better' && 'text-(--good)',
                                        verdict === 'worse' && 'text-(--bad)',
                                    )}
                                    aria-hidden
                                />
                            ) : (
                                <ArrowDown
                                    className={cn(
                                        'size-3.5',
                                        verdict === 'better' && 'text-(--good)',
                                        verdict === 'worse' && 'text-(--bad)',
                                    )}
                                    aria-hidden
                                />
                            )}
                            <span className="font-medium text-foreground tabular-nums">
                                {delta.ratio === null
                                    ? t(
                                          delta.kind === 'up'
                                              ? 'analytics.delta.from_zero'
                                              : 'analytics.delta.to_zero',
                                      )
                                    : t(
                                          delta.kind === 'up'
                                              ? 'analytics.delta.up'
                                              : 'analytics.delta.down',
                                          {
                                              value: formatPercent(
                                                  delta.ratio,
                                                  locale,
                                              ),
                                          },
                                      )}
                            </span>
                            {verdict && (
                                <span>{t(`analytics.delta.${verdict}`)}</span>
                            )}
                        </>
                    )}
                    <span className="sr-only">
                        {t('analytics.delta.previous_value', {
                            value: formatValue(before, def.unit, locale),
                        })}
                    </span>
                    <span aria-hidden>
                        {plural('analytics.delta.vs', previousDays)}
                    </span>
                </p>
            )}
        </article>
    );
}
