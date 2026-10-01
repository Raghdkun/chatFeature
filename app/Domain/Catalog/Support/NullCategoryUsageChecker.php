<?php

namespace App\Domain\Catalog\Support;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Models\Category;

/** Default binding until conversations exist (P4): nothing is ever in use. */
final class NullCategoryUsageChecker implements CategoryUsageChecker
{
    public function isInUse(Category $category): bool
    {
        return false;
    }
}
