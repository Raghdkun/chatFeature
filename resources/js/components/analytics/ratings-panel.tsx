import { Link } from '@inertiajs/react';
import { usePlural } from '@/components/widgets/page-chrome';
import { EmptyReport } from '@/components/analytics/states';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import {
    formatCount,
    formatDecimal,
    formatPercent,
} from '@/lib/analytics/format';
import type { RatingEntry, RatingsSummary } from '@/lib/analytics/types';

const STARS = [5, 4, 3, 2, 1] as const;

/**
 * The 1-5 rating distribution as a list (the numbers are text, the bars only repeat them: thin, one hue, never wider than 24 px) and, for
 * administrators, the latest ratings with their comments. Comments are rendered as plain text.
 */
export function RatingsPanel({
    ratings,
    recent,
    admin,
}: {
    ratings: RatingsSummary;
    recent: RatingEntry[];
    admin: boolean;
}) {
    const { t, locale } = useTrans();
    const plural = usePlural();

    if (ratings.count === 0) {
        return <EmptyReport title={t('analytics.ratings.empty')} />;
    }

    const max = Math.max(...ratings.distribution, 1);

    return (
        <div className="grid gap-5" data-testid="analytics-ratings">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <p className="text-3xl font-semibold tracking-tight">
                    {formatDecimal(ratings.average, locale, 2)}
                </p>
                <p className="text-sm text-muted-foreground">
                    {plural('analytics.ratings.from', ratings.count)}
                </p>
            </div>

            <ul
                className="grid gap-1.5"
                aria-label={t('analytics.ratings.distribution')}
            >
                {STARS.map((stars) => {
                    const count = ratings.distribution[stars - 1] ?? 0;

                    return (
                        <li
                            key={stars}
                            data-testid={`rating-row-${stars}`}
                            className="grid grid-cols-[5.5rem_1fr_7rem] items-center gap-3 text-sm"
                        >
                            <span className="text-muted-foreground">
                                {plural('analytics.ratings.star', stars)}
                            </span>
                            <span
                                aria-hidden
                                className="h-2 rounded-full bg-muted"
                            >
                                <span
                                    className="block h-2 rounded-full"
                                    style={{
                                        width: `${(count / max) * 100}%`,
                                        background: 'var(--series-1)',
                                    }}
                                />
                            </span>
                            <span className="text-end tabular-nums">
                                {formatCount(count, locale)}{' '}
                                <span className="text-muted-foreground">
                                    (
                                    {formatPercent(
                                        count / ratings.count,
                                        locale,
                                    )}
                                    )
                                </span>
                            </span>
                        </li>
                    );
                })}
            </ul>

            {admin ? (
                <div className="grid gap-2">
                    <h3 className="text-xs font-medium text-muted-foreground">
                        {t('analytics.ratings.recent')}
                    </h3>
                    {recent.length === 0 ? (
                        <p className="text-sm text-muted-foreground">
                            {t('analytics.ratings.recent_empty')}
                        </p>
                    ) : (
                        <ul
                            className="divide-y rounded-md border"
                            data-testid="analytics-recent-ratings"
                        >
                            {recent.map((entry) => (
                                <li
                                    key={entry.conversation}
                                    className="grid gap-0.5 px-3 py-2 text-sm"
                                >
                                    <p className="flex flex-wrap items-center gap-x-2">
                                        <span className="font-medium tabular-nums">
                                            {plural(
                                                'analytics.ratings.star',
                                                entry.score,
                                            )}
                                        </span>
                                        <span className="text-xs text-muted-foreground">
                                            {[
                                                entry.widget,
                                                entry.category,
                                                entry.agent,
                                            ]
                                                .filter(Boolean)
                                                .join(' · ')}
                                        </span>
                                        <Link
                                            href={staffRoutes.pages.conversation(
                                                entry.conversation,
                                            )}
                                            className="ms-auto text-xs underline-offset-4 hover:underline"
                                        >
                                            {t('analytics.ratings.open')}
                                        </Link>
                                    </p>
                                    <p
                                        className={
                                            entry.comment
                                                ? ''
                                                : 'text-muted-foreground'
                                        }
                                    >
                                        {entry.comment ??
                                            t('analytics.ratings.no_comment')}
                                    </p>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            ) : (
                <p className="text-xs text-muted-foreground">
                    {t('analytics.ratings.agent_note')}
                </p>
            )}
        </div>
    );
}
