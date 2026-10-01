<?php

namespace App\Data\Catalog;

use App\Models\Category;
use Spatie\LaravelData\Attributes\WithTransformer;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * A support category as the dashboard shows it (docs/contracts/dashboard-pages-p3.md). Counts come from
 * `withCount` (`agents_count` = active agents (`is_agent`) serving it, `widgets_count` = widgets it is enabled on); missing counts read as 0.
 */
#[TypeScript]
class CategoryData extends Data
{
    /**
     * @param  array<string, string>  $name_i18n
     */
    public function __construct(
        public string $ulid,
        public string $slug,
        public string $name,
        #[WithTransformer(ObjectMapTransformer::class)]
        public array $name_i18n,
        public ?string $description,
        public ?string $icon,
        public ?string $color,
        public int $sort_order,
        public bool $is_active,
        public int $agents_count,
        public int $widgets_count,
    ) {}

    public static function fromCategory(Category $category): self
    {
        return new self(
            ulid: $category->ulid,
            slug: $category->slug,
            name: $category->name,
            name_i18n: $category->name_i18n ?? [],
            description: $category->description,
            icon: $category->icon,
            color: $category->color,
            sort_order: $category->sort_order,
            is_active: $category->is_active,
            agents_count: (int) $category->agents_count,
            widgets_count: (int) $category->widgets_count,
        );
    }
}
