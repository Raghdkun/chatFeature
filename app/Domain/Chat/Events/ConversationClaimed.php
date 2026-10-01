<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * The conversation became `active` for `$agent` (after `ChatTaken`'s transaction). Dispatched by the claim action (4A);
 * consumed by 4B: `chat.claimed` on `private-conversation.{ulid}` (`ChatClaimedPayload`) and `conversation.updated`.
 */
final class ConversationClaimed implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly User $agent,
    ) {}
}
