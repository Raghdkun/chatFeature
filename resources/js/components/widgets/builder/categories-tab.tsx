import { Link } from '@inertiajs/react';
import { ChevronDown, ChevronUp, Plus, X } from 'lucide-react';
import { CategoryTile } from '@/components/categories/category-visuals';
import { errorsUnder } from '@/components/widgets/builder-state';
import type { TabProps } from '@/components/widgets/builder/tab-props';
import {
    ErrorLines,
    Notice,
    SectionCard,
} from '@/components/widgets/form-bits';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { useTrans } from '@/hooks/use-trans';
import { widgetsRoutes } from '@/lib/widgets-routes';
import type { CategoryData } from '@/types/widgets';

/** Which categories visitors can pick in this widget, and in which order. */
export function CategoriesTab({
    state,
    dispatch,
    categories,
}: TabProps & { categories: CategoryData[] }) {
    const { t } = useTrans();
    const enabled = state.doc.categoryUlids
        .map((ulid) => categories.find((category) => category.ulid === ulid))
        .filter((category): category is CategoryData => category !== undefined);
    const available = categories.filter(
        (category) => !state.doc.categoryUlids.includes(category.ulid),
    );
    // The server reports `category_ulids.N` (unknown / duplicate) as well as the list itself.
    const errors = errorsUnder(state.errors, 'categories');

    return (
        <div className="grid gap-5" data-testid="builder-panel-categories">
            {categories.length === 0 && (
                <Notice tone="warning" data-testid="builder-categories-none">
                    <p>{t('builder.categories.none_exist')}</p>
                    <Link
                        href={widgetsRoutes.pages.categories()}
                        className="mt-1 inline-block font-medium underline underline-offset-4"
                    >
                        {t('builder.categories.manage')}
                    </Link>
                </Notice>
            )}

            <SectionCard
                live
                title={t('builder.categories.enabled_title')}
                description={t('builder.categories.enabled_description')}
                testId="builder-categories-enabled"
            >
                <ErrorLines
                    messages={errors}
                    data-testid="builder-categories-errors"
                />
                {enabled.length === 0 ? (
                    <p className="rounded-lg border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
                        {t('builder.categories.enabled_empty')}
                    </p>
                ) : (
                    <ol className="grid gap-2">
                        {enabled.map((category, index) => (
                            <li
                                key={category.ulid}
                                data-testid={`builder-category-enabled-${category.ulid}`}
                                className="flex items-center gap-3 rounded-lg border bg-background p-2.5"
                            >
                                <span
                                    aria-hidden
                                    className="w-5 text-center text-xs text-muted-foreground tabular-nums"
                                >
                                    {index + 1}
                                </span>
                                <CategoryTile
                                    icon={category.icon}
                                    color={category.color}
                                    className="size-8"
                                />
                                <span className="min-w-0 flex-1">
                                    <span className="block truncate text-sm font-medium">
                                        {category.name}
                                    </span>
                                    {!category.is_active && (
                                        <Badge
                                            variant="secondary"
                                            className="mt-0.5"
                                        >
                                            {t('builder.categories.inactive')}
                                        </Badge>
                                    )}
                                </span>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-8"
                                    disabled={index === 0}
                                    aria-label={t(
                                        'builder.categories.move_up',
                                        { name: category.name },
                                    )}
                                    data-testid={`builder-category-up-${category.ulid}`}
                                    onClick={() =>
                                        dispatch({
                                            type: 'categories/move',
                                            ulid: category.ulid,
                                            direction: -1,
                                        })
                                    }
                                >
                                    <ChevronUp aria-hidden />
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-8"
                                    disabled={index === enabled.length - 1}
                                    aria-label={t(
                                        'builder.categories.move_down',
                                        { name: category.name },
                                    )}
                                    data-testid={`builder-category-down-${category.ulid}`}
                                    onClick={() =>
                                        dispatch({
                                            type: 'categories/move',
                                            ulid: category.ulid,
                                            direction: 1,
                                        })
                                    }
                                >
                                    <ChevronDown aria-hidden />
                                </Button>
                                <Button
                                    type="button"
                                    size="icon"
                                    variant="ghost"
                                    className="size-8"
                                    aria-label={t('builder.categories.remove', {
                                        name: category.name,
                                    })}
                                    data-testid={`builder-category-remove-${category.ulid}`}
                                    onClick={() =>
                                        dispatch({
                                            type: 'categories/toggle',
                                            ulid: category.ulid,
                                        })
                                    }
                                >
                                    <X aria-hidden />
                                </Button>
                            </li>
                        ))}
                    </ol>
                )}
            </SectionCard>

            {available.length > 0 && (
                <SectionCard
                    live
                    title={t('builder.categories.available_title')}
                    description={t('builder.categories.available_description')}
                    testId="builder-categories-available"
                >
                    <ul className="flex flex-wrap gap-2">
                        {available.map((category) => (
                            <li key={category.ulid}>
                                <button
                                    type="button"
                                    data-testid={`builder-category-add-${category.ulid}`}
                                    aria-label={t('builder.categories.add', {
                                        name: category.name,
                                    })}
                                    onClick={() =>
                                        dispatch({
                                            type: 'categories/toggle',
                                            ulid: category.ulid,
                                        })
                                    }
                                    className="inline-flex max-w-full items-center gap-1.5 rounded-full border bg-background py-1 ps-2 pe-3 text-xs font-medium transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                                >
                                    <Plus
                                        className="size-3.5 text-muted-foreground"
                                        aria-hidden
                                    />
                                    <span
                                        aria-hidden
                                        className="size-2 shrink-0 rounded-full bg-muted-foreground/50"
                                        style={
                                            category.color
                                                ? {
                                                      backgroundColor:
                                                          category.color,
                                                  }
                                                : undefined
                                        }
                                    />
                                    <span
                                        className={
                                            category.is_active
                                                ? 'truncate'
                                                : 'truncate text-muted-foreground'
                                        }
                                    >
                                        {category.name}
                                    </span>
                                </button>
                            </li>
                        ))}
                    </ul>
                </SectionCard>
            )}
        </div>
    );
}
