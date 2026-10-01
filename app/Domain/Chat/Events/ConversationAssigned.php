<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A conversation was handed to a specific agent (transfer to an agent, or an admin assigning it).
 * Dispatched by the transfer / assign actions (4A); consumed by 4B: `chat.assigned` to `private-staff.{agent id}`
 * (`ChatAssignedPayload`), `conversation.updated` to the former assignee and admins.
 */
final class ConversationAssigned implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly User $agent,
        public readonly ?User $assignedBy = null,
        public readonly ?User $previousAgent = null,
    ) {}
}
