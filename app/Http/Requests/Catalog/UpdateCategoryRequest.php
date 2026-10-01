<?php

namespace App\Http\Requests\Catalog;

use App\Models\Category;

/**
 * Body of `PATCH /api/v1/categories/{ulid}`: every field optional.
 */
class UpdateCategoryRequest extends StoreCategoryRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        $category = $this->route('category');

        return $this->categoryRules(creating: false, ignoreId: $category instanceof Category ? $category->id : null);
    }
}
