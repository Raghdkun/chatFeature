<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\ConversationEndedBy;
use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A live chat moved to `ended` (the visitor is asked to rate). Dispatched by the end action (4A); consumed by 4B:
 * `conversation.ended` on `private-conversation.{ulid}` (`ConversationEndedPayload`) and `conversation.updated`.
 */
final class ConversationEnded implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly ConversationEndedBy $endedBy,
    ) {}
}
