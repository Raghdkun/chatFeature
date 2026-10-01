<?php

namespace App\Domain\Chat\Events;

use App\Models\Category;
use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An active chat was taken away from its agent and re-queued (transfer to an agent or a category, or the agent was
 * deactivated). Dispatched by the transfer action (4A) next to `ConversationQueued` / `ConversationAssigned`; consumed by 4B:
 * `conversation.transferred` on `private-conversation.{ulid}` (`ConversationTransferredPayload`).
 */
final class ConversationTransferred implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly ?User $fromAgent = null,
        public readonly ?User $toAgent = null,
        public readonly ?Category $toCategory = null,
    ) {}
}
