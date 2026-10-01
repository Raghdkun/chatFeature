<?php

namespace App\Domain\Widgets\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;

/**
 * Replaces the categories enabled on a widget; the order of the ULIDs is the display order.
 * Serialised per widget by a row lock: two overlapping replacements cannot collide in the `(widget_id, category_id)` key.
 */
final class ReplaceCategories
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly WidgetCache $cache,
    ) {}

    /**
     * @param  list<string>  $categoryUlids  existing, non-deleted categories, in display order
     * @return list<string> the stored ULIDs in display order
     */
    public function handle(Widget $widget, array $categoryUlids, ?User $actor = null): array
    {
        $categoryUlids = array_values(array_unique($categoryUlids));
        $ids = Category::query()->whereIn('ulid', $categoryUlids)->pluck('id', 'ulid');

        $sync = [];

        foreach ($categoryUlids as $position => $ulid) {
            if (isset($ids[$ulid])) {
                $sync[$ids[$ulid]] = ['sort_order' => $position];
            }
        }

        DB::transaction(function () use ($widget, $sync): void {
            Widget::query()->lockForUpdate()->findOrFail($widget->getKey());

            $widget->categories()->sync($sync);
        });

        $this->cache->bust($widget);
        $this->audit->record('widget.categories_updated', $widget, ['category_ulids' => $categoryUlids], $actor);

        return $categoryUlids;
    }
}
