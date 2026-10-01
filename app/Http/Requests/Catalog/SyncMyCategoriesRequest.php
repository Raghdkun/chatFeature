<?php

namespace App\Http\Requests\Catalog;

/**
 * Body of `PUT /api/v1/me/categories`: agents may only pick active categories.
 */
class SyncMyCategoriesRequest extends SyncCategoriesRequest
{
    protected function onlyActiveCategories(): bool
    {
        return true;
    }
}
