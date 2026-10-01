<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Catalog\Support\CategorySlugger;
use App\Models\Category;
use App\Models\User;

/**
 * Creates a category; the slug is generated from the name unless the admin typed one.
 */
final class CreateCategory
{
    public function __construct(
        private readonly CategorySlugger $slugger,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array<string, mixed>  $attributes  validated: name, slug?, description?, icon?, color?, sort_order?, is_active?, name_i18n?
     */
    public function handle(array $attributes, ?User $actor = null): Category
    {
        $slug = is_string($attributes['slug'] ?? null) && $attributes['slug'] !== ''
            ? $attributes['slug']
            : $this->slugger->unique((string) $attributes['name']);

        $category = new Category($attributes);
        $category->slug = $slug;

        if (! array_key_exists('sort_order', $attributes)) {
            $category->sort_order = (int) Category::query()->max('sort_order') + 1;
        }

        $category->save();

        $this->audit->record('category.created', $category, ['slug' => $category->slug, 'name' => $category->name], $actor);

        return $category->refresh();
    }
}
