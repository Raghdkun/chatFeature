<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\User;
use App\Models\Widget;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * Soft-deletes a category unless a live chat still uses it. The slug is released (renamed) so the name can be
 * reused; widget and agent links are removed.
 */
final class DeleteCategory
{
    public function __construct(
        private readonly CategoryUsageChecker $usage,
        private readonly AuditLogger $audit,
        private readonly BustCategoryWidgets $bust,
    ) {}

    /**
     * @throws ApiProblemException 409 `category_in_use`
     */
    public function handle(Category $category, ?User $actor = null): void
    {
        if ($this->usage->isInUse($category)) {
            throw ApiProblemException::conflict('category_in_use', __('This category is used by an active conversation and cannot be deleted yet.'));
        }

        $originalSlug = $category->slug;
        $widgets = $category->widgets()->get();

        DB::transaction(function () use ($category): void {
            $category->widgets()->detach();
            $category->users()->detach();
            $category->forceFill(['slug' => substr($category->slug, 0, 55).'~'.Str::lower(Str::random(8))])->save();
            $category->delete();
        });

        $widgets->each(fn (Widget $widget) => $this->bust->bustWidget($widget));
        $this->audit->record('category.deleted', $category, ['slug' => $originalSlug, 'name' => $category->name], $actor);
    }
}
