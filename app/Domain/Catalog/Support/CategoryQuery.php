<?php

namespace App\Domain\Catalog\Support;

use App\Models\Category;
use Illuminate\Database\Eloquent\Collection;

/**
 * Category reads with the counts the dashboard shows (`agents_count` = active agents (`is_agent`) serving it, `widgets_count`).
 */
final class CategoryQuery
{
    /**
     * @return Collection<int, Category>
     */
    public function all(bool $onlyActive = false): Collection
    {
        return Category::query()
            ->when($onlyActive, fn ($query) => $query->where('is_active', true))
            ->withCount([
                'users as agents_count' => fn ($query) => $query->where('users.is_active', true)->where('users.is_agent', true),
                'widgets',
            ])
            ->orderBy('sort_order')
            ->orderBy('name')
            ->get();
    }

    public function withCounts(Category $category): Category
    {
        return $category->loadCount([
            'users as agents_count' => fn ($query) => $query->where('users.is_active', true)->where('users.is_agent', true),
            'widgets',
        ]);
    }
}
