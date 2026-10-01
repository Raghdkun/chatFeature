<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Models\Category;
use App\Models\User;

/**
 * Updates a category and refreshes the boot config of every widget that offers it.
 */
final class UpdateCategory
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly BustCategoryWidgets $bust,
    ) {}

    /**
     * @param  array<string, mixed>  $attributes  validated, partial
     */
    public function handle(Category $category, array $attributes, ?User $actor = null): Category
    {
        $category->fill($attributes);

        if ($category->isDirty()) {
            $changes = $category->getDirty();
            $category->save();
            $this->audit->record('category.updated', $category, $changes, $actor);
            $this->bust->handle($category);
        }

        return $category->refresh();
    }
}
