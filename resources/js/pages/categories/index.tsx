import { Head } from '@inertiajs/react';
import { Plus, Search, Tags } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { toast } from 'sonner';
import { CategoryDeleteDialog } from '@/components/categories/category-delete-dialog';
import { CategoryDialog } from '@/components/categories/category-dialog';
import {
    matchesSearch,
    nextSortOrder,
    reorderCategories,
    sortCategories,
} from '@/components/categories/category-form';
import { CategoryRow } from '@/components/categories/category-row';
import { PageHeader, PageShell } from '@/components/widgets/page-chrome';
import { Button } from '@/components/ui/button';
import {
    Empty,
    EmptyContent,
    EmptyDescription,
    EmptyHeader,
    EmptyMedia,
    EmptyTitle,
} from '@/components/ui/empty';
import { Input } from '@/components/ui/input';
import { useTrans } from '@/hooks/use-trans';
import AppLayout from '@/layouts/app-layout';
import { api, describeApiError } from '@/lib/api-client';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { CategoryData } from '@/types/widgets';

type DialogState =
    | { mode: 'create' }
    | { mode: 'edit'; category: CategoryData };

export default function CategoriesIndex({
    categories,
}: {
    categories: CategoryData[];
}) {
    const { t } = useTrans();
    const [items, setItems] = useState<CategoryData[]>(() =>
        sortCategories(categories),
    );
    const [query, setQuery] = useState('');
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [deleting, setDeleting] = useState<CategoryData | null>(null);

    const searching = query.trim() !== '';
    const visible = items.filter((category) => matchesSearch(category, query));

    function upsert(saved: CategoryData) {
        setItems((current) =>
            sortCategories(
                current.some((item) => item.ulid === saved.ulid)
                    ? current.map((item) =>
                          item.ulid === saved.ulid ? saved : item,
                      )
                    : [...current, saved],
            ),
        );
        toast.success(t('categories.toast.saved', { name: saved.name }));
    }

    async function toggleActive(category: CategoryData, active: boolean) {
        const before = items;

        setItems((current) =>
            current.map((item) =>
                item.ulid === category.ulid
                    ? { ...item, is_active: active }
                    : item,
            ),
        );

        try {
            const saved = await api.patch<CategoryData>(
                widgetsRoutes.api.categories.show(category.ulid),
                { is_active: active },
            );

            setItems((current) =>
                current.map((item) =>
                    item.ulid === saved.ulid ? saved : item,
                ),
            );
        } catch (error) {
            setItems(before);
            toast.error(describeApiError(error, t));
        }
    }

    async function move(category: CategoryData, direction: -1 | 1) {
        const changes = reorderCategories(items, category.ulid, direction);

        if (changes.length === 0) {
            return;
        }

        const before = items;
        const order = new Map(changes.map((c) => [c.ulid, c.sort_order]));

        setItems(
            sortCategories(
                items.map((item) =>
                    order.has(item.ulid)
                        ? { ...item, sort_order: order.get(item.ulid)! }
                        : item,
                ),
            ),
        );

        try {
            await Promise.all(
                changes.map((change) =>
                    api.patch<CategoryData>(
                        widgetsRoutes.api.categories.show(change.ulid),
                        { sort_order: change.sort_order },
                    ),
                ),
            );
        } catch (error) {
            setItems(before);
            toast.error(describeApiError(error, t));
        }
    }

    return (
        <>
            <Head title={t('categories.title')} />

            <PageShell testId="categories-page">
                <PageHeader
                    title={t('categories.title')}
                    description={t('categories.description')}
                    actions={
                        <Button
                            data-testid="category-create"
                            onClick={() => setDialog({ mode: 'create' })}
                        >
                            <Plus aria-hidden />
                            {t('categories.create')}
                        </Button>
                    }
                />

                {items.length === 0 ? (
                    <Empty
                        data-testid="categories-empty"
                        className="border bg-card"
                    >
                        <EmptyHeader>
                            <EmptyMedia variant="icon">
                                <Tags aria-hidden />
                            </EmptyMedia>
                            <EmptyTitle>
                                {t('categories.empty.title')}
                            </EmptyTitle>
                            <EmptyDescription>
                                {t('categories.empty.body')}
                            </EmptyDescription>
                        </EmptyHeader>
                        <EmptyContent>
                            <Button
                                onClick={() => setDialog({ mode: 'create' })}
                            >
                                <Plus aria-hidden />
                                {t('categories.create')}
                            </Button>
                        </EmptyContent>
                    </Empty>
                ) : (
                    <section
                        aria-label={t('categories.list_label')}
                        className="overflow-hidden rounded-xl border bg-card"
                    >
                        <div className="relative border-b p-3">
                            <Search
                                className="pointer-events-none absolute start-6 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
                                aria-hidden
                            />
                            <Input
                                type="search"
                                value={query}
                                onChange={(event) =>
                                    setQuery(event.target.value)
                                }
                                placeholder={t('categories.search')}
                                aria-label={t('categories.search')}
                                data-testid="category-search"
                                className="ps-9"
                            />
                        </div>

                        {visible.length === 0 ? (
                            <p
                                className="px-4 py-10 text-center text-sm text-muted-foreground"
                                data-testid="categories-no-match"
                            >
                                {t('categories.no_match', {
                                    query: query.trim(),
                                })}
                            </p>
                        ) : (
                            <ul
                                className="divide-y"
                                data-testid="categories-list"
                            >
                                {visible.map((category, index) => (
                                    <CategoryRow
                                        key={category.ulid}
                                        category={category}
                                        canMoveUp={index > 0}
                                        canMoveDown={index < visible.length - 1}
                                        reorderDisabled={searching}
                                        onToggleActive={toggleActive}
                                        onMove={move}
                                        onEdit={(entry) =>
                                            setDialog({
                                                mode: 'edit',
                                                category: entry,
                                            })
                                        }
                                        onDelete={setDeleting}
                                    />
                                ))}
                            </ul>
                        )}
                    </section>
                )}
            </PageShell>

            <CategoryDialog
                // A fresh dialog (and form state) per target.
                key={dialog?.mode === 'edit' ? dialog.category.ulid : 'create'}
                open={dialog !== null}
                onOpenChange={(open) => !open && setDialog(null)}
                category={dialog?.mode === 'edit' ? dialog.category : undefined}
                nextSortOrder={nextSortOrder(items)}
                onSaved={upsert}
            />

            <CategoryDeleteDialog
                category={deleting}
                onClose={() => setDeleting(null)}
                onDeleted={(ulid) => {
                    setItems((current) =>
                        current.filter((item) => item.ulid !== ulid),
                    );
                    setDeleting(null);
                    toast.success(t('categories.toast.deleted'));
                }}
                onDeactivate={(category) => void toggleActive(category, false)}
            />
        </>
    );
}

CategoriesIndex.layout = CategoriesLayout;

function CategoriesLayout({ children }: { children: ReactNode }) {
    const { t } = useTrans();

    return (
        <AppLayout
            breadcrumbs={[
                {
                    title: t('categories.title'),
                    href: widgetsRoutes.pages.categories(),
                },
            ]}
        >
            {children}
        </AppLayout>
    );
}
