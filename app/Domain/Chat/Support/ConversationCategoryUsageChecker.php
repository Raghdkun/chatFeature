<?php

namespace App\Domain\Chat\Support;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Chat\Enums\ConversationStatus;
use App\Models\Category;
use App\Models\Conversation;

/** A category is in use while a queued or active conversation (live or offline) belongs to it. */
final class ConversationCategoryUsageChecker implements CategoryUsageChecker
{
    public function isInUse(Category $category): bool
    {
        return Conversation::query()
            ->where('category_id', $category->id)
            ->whereIn('status', ConversationStatus::openValues())
            ->exists();
    }
}
