import {
    ChevronDown,
    ChevronUp,
    LayoutTemplate,
    Pencil,
    Trash2,
    Users,
} from 'lucide-react';
import { CategoryTile } from '@/components/categories/category-visuals';
import { usePlural } from '@/components/widgets/page-chrome';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import { useTrans } from '@/hooks/use-trans';
import type { CategoryData } from '@/types/widgets';

export function CategoryRow({
    category,
    canMoveUp,
    canMoveDown,
    reorderDisabled,
    onToggleActive,
    onMove,
    onEdit,
    onDelete,
}: {
    category: CategoryData;
    canMoveUp: boolean;
    canMoveDown: boolean;
    /** Reordering only makes sense on the full, unfiltered list. */
    reorderDisabled: boolean;
    onToggleActive: (category: CategoryData, active: boolean) => void;
    onMove: (category: CategoryData, direction: -1 | 1) => void;
    onEdit: (category: CategoryData) => void;
    onDelete: (category: CategoryData) => void;
}) {
    const { t } = useTrans();
    const plural = usePlural();
    const switchId = `category-active-${category.ulid}`;

    return (
        <li
            data-testid={`category-row-${category.ulid}`}
            className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:gap-4"
        >
            <div className="flex min-w-0 flex-1 items-start gap-3">
                <CategoryTile icon={category.icon} color={category.color} />
                <div className="grid min-w-0 gap-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                        <h3 className="font-medium break-words">
                            {category.name}
                        </h3>
                        <code
                            dir="ltr"
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground"
                        >
                            {category.slug}
                        </code>
                        {!category.is_active && (
                            <Badge variant="secondary">
                                {t('categories.inactive')}
                            </Badge>
                        )}
                    </div>
                    {category.description && (
                        <p className="line-clamp-2 text-sm text-muted-foreground">
                            {category.description}
                        </p>
                    )}
                    <p className="mt-0.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span className="inline-flex items-center gap-1.5">
                            <Users className="size-3.5" aria-hidden />
                            {plural(
                                'categories.agents_count',
                                category.agents_count,
                            )}
                        </span>
                        <span className="inline-flex items-center gap-1.5">
                            <LayoutTemplate className="size-3.5" aria-hidden />
                            {plural(
                                'categories.widgets_count',
                                category.widgets_count,
                            )}
                        </span>
                    </p>
                </div>
            </div>

            <div className="flex flex-wrap items-center gap-1 sm:flex-nowrap sm:justify-end">
                <div className="me-2 flex items-center gap-2">
                    <Switch
                        id={switchId}
                        checked={category.is_active}
                        onCheckedChange={(checked) =>
                            onToggleActive(category, checked)
                        }
                        data-testid={switchId}
                    />
                    <Label htmlFor={switchId} className="text-sm font-normal">
                        {t('categories.active')}
                    </Label>
                </div>

                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={reorderDisabled || !canMoveUp}
                    aria-label={t('categories.move_up', {
                        name: category.name,
                    })}
                    data-testid={`category-move-up-${category.ulid}`}
                    onClick={() => onMove(category, -1)}
                >
                    <ChevronUp aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    disabled={reorderDisabled || !canMoveDown}
                    aria-label={t('categories.move_down', {
                        name: category.name,
                    })}
                    data-testid={`category-move-down-${category.ulid}`}
                    onClick={() => onMove(category, 1)}
                >
                    <ChevronDown aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('categories.edit', { name: category.name })}
                    data-testid={`category-edit-${category.ulid}`}
                    onClick={() => onEdit(category)}
                >
                    <Pencil aria-hidden />
                </Button>
                <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={t('categories.delete_action', {
                        name: category.name,
                    })}
                    data-testid={`category-delete-${category.ulid}`}
                    onClick={() => onDelete(category)}
                    className="text-destructive-foreground hover:text-destructive-foreground"
                >
                    <Trash2 aria-hidden />
                </Button>
            </div>
        </li>
    );
}
