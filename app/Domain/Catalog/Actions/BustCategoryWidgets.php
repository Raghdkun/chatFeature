<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;

/**
 * Category names, slugs and activity are part of every widget's boot config: drop the caches of the widgets using one.
 */
final class BustCategoryWidgets
{
    public function __construct(private readonly WidgetCache $cache) {}

    public function handle(Category $category): void
    {
        $category->widgets()->get()->each(fn (Widget $widget) => $this->bustWidget($widget));
    }

    public function bustWidget(Widget $widget): void
    {
        $this->cache->bust($widget);
    }
}
