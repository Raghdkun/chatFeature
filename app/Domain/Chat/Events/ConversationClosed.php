<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\ConversationCloseReason;
use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * The conversation reached `closed` (rated, skipped, idle, rating window, cancelled, system). Dispatched by the rating
 * action and the sweeps (4A); consumed by 4B: `conversation.closed` on `private-conversation.{ulid}`
 * (`ConversationClosedPayload`) and `conversation.updated`.
 */
final class ConversationClosed implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly ConversationCloseReason $reason,
    ) {}
}
