<?php

namespace App\Domain\Catalog\Contracts;

use App\Models\Category;

/**
 * Tells the catalog whether a category is still needed by live chats, so it can refuse to delete it
 * (`409 category_in_use`). P4 (Chat) rebinds this to look at active conversations.
 */
interface CategoryUsageChecker
{
    public function isInUse(Category $category): bool;
}
