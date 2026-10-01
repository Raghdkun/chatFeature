<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * Something list-visible changed (status, assignee, unseen counter, last message). Dispatched by the Chat actions (4A);
 * consumed by 4B: `conversation.updated` to the assigned agent, offered agents and `private-admin`
 * (`ConversationUpdatedPayload`).
 */
final class ConversationUpdated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Conversation $conversation) {}
}
