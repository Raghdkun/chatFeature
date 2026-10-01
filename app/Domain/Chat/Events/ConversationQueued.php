<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A conversation entered the queue (created `queued`, or re-queued by a transfer / deactivated agent).
 * Dispatched by the Chat actions (4A); consumed by routing (offers), `queue.updated` and `conversation.updated` (4B).
 */
final class ConversationQueued implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Conversation $conversation) {}
}
