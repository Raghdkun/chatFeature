import { ChevronsUpDown } from 'lucide-react';
import { useId } from 'react';
import { toggleUlid } from '@/components/agents/agent-model';
import { CategoryChip } from '@/components/categories/category-visuals';
import { Checkbox } from '@/components/ui/checkbox';
import { Label } from '@/components/ui/label';
import {
    Popover,
    PopoverContent,
    PopoverTrigger,
} from '@/components/ui/popover';
import { useTrans } from '@/hooks/use-trans';
import { cn } from '@/lib/utils';
import type { CategoryData } from '@/types/widgets';

const VISIBLE_CHIPS = 3;

/**
 * The categories an agent serves: chips in the row, a popover with one checkbox per category to
 * change them. Each tick is applied optimistically by the parent (`onChange` gets the new set).
 */
export function AgentCategoriesPicker({
    agentId,
    agentName,
    categories,
    selected,
    onChange,
    disabled,
}: {
    agentId: number | string;
    agentName: string;
    categories: CategoryData[];
    selected: string[];
    onChange: (ulids: string[]) => void;
    disabled?: boolean;
}) {
    const { t } = useTrans();
    const uid = useId();
    const chosen = categories.filter((category) =>
        selected.includes(category.ulid),
    );

    return (
        <Popover>
            <PopoverTrigger asChild>
                <button
                    type="button"
                    disabled={disabled}
                    aria-label={t('agents.categories.edit_for', {
                        name: agentName,
                    })}
                    data-testid={`agent-categories-${agentId}`}
                    className={cn(
                        'group flex min-h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-background px-2 py-1 text-start text-sm shadow-xs transition-colors',
                        'hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none',
                        'disabled:cursor-not-allowed disabled:opacity-60',
                    )}
                >
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-1">
                        {chosen.length === 0 ? (
                            <span className="px-1 text-muted-foreground">
                                {t('agents.categories.none')}
                            </span>
                        ) : (
                            <>
                                {chosen
                                    .slice(0, VISIBLE_CHIPS)
                                    .map((category) => (
                                        <CategoryChip
                                            key={category.ulid}
                                            name={category.name}
                                            color={category.color}
                                            muted={!category.is_active}
                                        />
                                    ))}
                                {chosen.length > VISIBLE_CHIPS && (
                                    <span className="px-1 text-xs text-muted-foreground tabular-nums">
                                        {t('agents.categories.more', {
                                            count:
                                                chosen.length - VISIBLE_CHIPS,
                                        })}
                                    </span>
                                )}
                            </>
                        )}
                    </span>
                    <ChevronsUpDown
                        className="size-4 shrink-0 text-muted-foreground"
                        aria-hidden
                    />
                </button>
            </PopoverTrigger>
            <PopoverContent
                align="start"
                className="w-72 max-w-[calc(100vw-2rem)] p-2"
                data-testid={`agent-categories-menu-${agentId}`}
            >
                <p className="px-2 pt-1 pb-2 text-xs font-medium text-muted-foreground">
                    {t('agents.categories.menu_title', { name: agentName })}
                </p>
                {categories.length === 0 ? (
                    <p className="px-2 py-4 text-sm text-muted-foreground">
                        {t('agents.categories.no_catalog')}
                    </p>
                ) : (
                    <ul className="grid max-h-64 gap-0.5 overflow-y-auto">
                        {categories.map((category) => {
                            const id = `${uid}-${category.ulid}`;

                            return (
                                <li key={category.ulid}>
                                    <div className="flex items-center gap-2.5 rounded-md px-2 py-1.5 hover:bg-accent/60">
                                        <Checkbox
                                            id={id}
                                            checked={selected.includes(
                                                category.ulid,
                                            )}
                                            onCheckedChange={() =>
                                                onChange(
                                                    toggleUlid(
                                                        selected,
                                                        category.ulid,
                                                    ),
                                                )
                                            }
                                            data-testid={`agent-category-option-${agentId}-${category.ulid}`}
                                        />
                                        <Label
                                            htmlFor={id}
                                            className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 py-0.5 text-sm font-normal"
                                        >
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
                                            <span className="truncate">
                                                {category.name}
                                            </span>
                                            {!category.is_active && (
                                                <span className="text-xs text-muted-foreground">
                                                    {t(
                                                        'agents.categories.inactive',
                                                    )}
                                                </span>
                                            )}
                                        </Label>
                                    </div>
                                </li>
                            );
                        })}
                    </ul>
                )}
            </PopoverContent>
        </Popover>
    );
}
