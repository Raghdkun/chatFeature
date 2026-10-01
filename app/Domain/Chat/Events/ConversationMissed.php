<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A queued live chat nobody accepted before its deadline became `missed`. Dispatched by the queue-expiry action (4A);
 * consumed by 4B: `conversation.missed` on `private-conversation.{ulid}` (`ConversationMissedPayload`, so the waiting visitor
 * learns at once that it should offer the offline form) and `conversation.updated`.
 */
final class ConversationMissed implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Conversation $conversation) {}
}
