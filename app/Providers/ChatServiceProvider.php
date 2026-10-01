<?php

namespace App\Providers;

use App\Domain\Catalog\Contracts\CategoryUsageChecker;
use App\Domain\Chat\Contracts\AttachmentUrls;
use App\Domain\Chat\Policies\ConversationPolicy;
use App\Domain\Chat\Support\ConversationCategoryUsageChecker;
use App\Domain\Chat\Support\SignedAttachmentUrls;
use App\Models\Conversation;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\ServiceProvider;

/**
 * Conversation lifecycle, messages, attachments, ratings (P4).
 *
 * Owns the bindings of the chat context: the conversation policy, signed attachment URLs and the category usage guard
 * (a queued or active conversation keeps its category from being deleted). Keep bindings and boot logic for this bounded
 * context here so parallel tracks never edit the same provider.
 */
class ChatServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bindIf(AttachmentUrls::class, SignedAttachmentUrls::class);
        $this->app->bind(CategoryUsageChecker::class, ConversationCategoryUsageChecker::class);
    }

    public function boot(): void
    {
        Gate::policy(Conversation::class, ConversationPolicy::class);
    }
}
