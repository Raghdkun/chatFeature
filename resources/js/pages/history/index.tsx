import { Head, Link, router } from '@inertiajs/react';
import { ChevronLeft, ChevronRight, History } from 'lucide-react';
import { useCallback } from 'react';
import { HistoryFiltersBar } from '@/components/inbox/history-filters';
import {
    hasActiveFilters,
    historyQuery,
    pageWindow,
} from '@/components/inbox/history-model';
import { HistoryTable } from '@/components/inbox/history-table';
import { HistoryLayout } from '@/components/inbox/inbox-layout';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { PageHeader, PageShell } from '@/components/widgets/page-chrome';
import { useTrans } from '@/hooks/use-trans';
import { staffRoutes } from '@/lib/chat-api/staff';
import type { HistoryFilters, HistoryPageProps } from '@/types/chat-staff';

/** Only these props change when the filters or the page change; the filter options are sent once. */
const PARTIAL = ['conversations', 'pagination', 'filters', 'ratings'];

export default function HistoryIndex({
    conversations,
    pagination,
    filters,
    ratings,
    filterOptions,
}: HistoryPageProps) {
    const { t } = useTrans();
    const range = pageWindow(pagination);
    const filtered = hasActiveFilters(filters);

    const apply = useCallback((next: HistoryFilters, page = 1) => {
        router.get(staffRoutes.pages.history(), historyQuery(next, page), {
            only: PARTIAL,
            preserveState: true,
            preserveScroll: true,
            replace: true,
        });
    }, []);

    return (
        <>
            <Head title={t('history.title')} />

            <PageShell testId="history-page" wide>
                <PageHeader
                    title={t('history.title')}
                    description={t('history.description')}
                />

                <section
                    aria-label={t('history.results')}
                    className="overflow-hidden rounded-xl border bg-card"
                >
                    <HistoryFiltersBar
                        filters={filters}
                        options={filterOptions}
                        onChange={(next) => apply(next)}
                    />

                    {conversations.length === 0 ? (
                        <Empty data-testid="history-empty" className="border-0">
                            <EmptyHeader>
                                <EmptyMedia variant="icon">
                                    <History aria-hidden />
                                </EmptyMedia>
                                <EmptyTitle>
                                    {filtered
                                        ? t('history.empty.filtered_title')
                                        : t('history.empty.title')}
                                </EmptyTitle>
                                <EmptyDescription>
                                    {filtered
                                        ? t('history.empty.filtered_body')
                                        : t('history.empty.body')}
                                </EmptyDescription>
                            </EmptyHeader>
                        </Empty>
                    ) : (
                        <HistoryTable
                            conversations={conversations}
                            ratings={ratings}
                        />
                    )}

                    <nav
                        aria-label={t('history.pager.label')}
                        data-testid="history-pager"
                        className="flex flex-wrap items-center justify-between gap-2 border-t px-4 py-3 text-sm"
                    >
                        <p
                            data-testid="history-count"
                            className="text-muted-foreground tabular-nums"
                            aria-live="polite"
                        >
                            {range
                                ? t('history.pager.range', {
                                      from: range.from,
                                      to: range.to,
                                      total: range.total,
                                  })
                                : t('history.pager.none')}
                        </p>
                        <div className="flex items-center gap-2">
                            <Button
                                asChild={pagination.page > 1}
                                variant="outline"
                                size="sm"
                                disabled={pagination.page <= 1}
                                data-testid="history-prev"
                            >
                                {pagination.page > 1 ? (
                                    <Link
                                        href={staffRoutes.pages.history()}
                                        data={historyQuery(
                                            filters,
                                            pagination.page - 1,
                                        )}
                                        only={PARTIAL}
                                        preserveState
                                        preserveScroll
                                        replace
                                    >
                                        <ChevronLeft
                                            className="rtl:-scale-x-100"
                                            aria-hidden
                                        />
                                        {t('history.pager.prev')}
                                    </Link>
                                ) : (
                                    <>
                                        <ChevronLeft
                                            className="rtl:-scale-x-100"
                                            aria-hidden
                                        />
                                        {t('history.pager.prev')}
                                    </>
                                )}
                            </Button>
                            <span className="text-muted-foreground tabular-nums">
                                {t('history.pager.page', {
                                    page: pagination.page,
                                    pages: pagination.lastPage,
                                })}
                            </span>
                            <Button
                                asChild={pagination.page < pagination.lastPage}
                                variant="outline"
                                size="sm"
                                disabled={
                                    pagination.page >= pagination.lastPage
                                }
                                data-testid="history-next"
                            >
                                {pagination.page < pagination.lastPage ? (
                                    <Link
                                        href={staffRoutes.pages.history()}
                                        data={historyQuery(
                                            filters,
                                            pagination.page + 1,
                                        )}
                                        only={PARTIAL}
                                        preserveState
                                        preserveScroll
                                        replace
                                    >
                                        {t('history.pager.next')}
                                        <ChevronRight
                                            className="rtl:-scale-x-100"
                                            aria-hidden
                                        />
                                    </Link>
                                ) : (
                                    <>
                                        {t('history.pager.next')}
                                        <ChevronRight
                                            className="rtl:-scale-x-100"
                                            aria-hidden
                                        />
                                    </>
                                )}
                            </Button>
                        </div>
                    </nav>
                </section>
            </PageShell>
        </>
    );
}

HistoryIndex.layout = HistoryLayout;
