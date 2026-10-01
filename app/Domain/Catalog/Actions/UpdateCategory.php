<?php

namespace App\Domain\Catalog\Actions;

use App\Domain\Audit\AuditLogger;
use App\Http\Exceptions\ApiProblemException;
use App\Models\Category;
use App\Models\User;
use Illuminate\Database\UniqueConstraintViolationException;

/**
 * Updates a category and refreshes the boot config of every widget that offers it. A slug that another request took
 * between validation and save answers `409 slug_taken`.
 */
final class UpdateCategory
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly BustCategoryWidgets $bust,
    ) {}

    /**
     * @param  array<string, mixed>  $attributes  validated, partial
     *
     * @throws ApiProblemException 409 `slug_taken`
     */
    public function handle(Category $category, array $attributes, ?User $actor = null): Category
    {
        $category->fill($attributes);

        if ($category->isDirty()) {
            $changes = $category->getDirty();

            try {
                $category->save();
            } catch (UniqueConstraintViolationException) {
                throw ApiProblemException::conflict('slug_taken', __('This slug is already used by another category.'));
            }

            $this->audit->record('category.updated', $category, $changes, $actor);
            $this->bust->handle($category);
        }

        return $category->refresh();
    }
}
