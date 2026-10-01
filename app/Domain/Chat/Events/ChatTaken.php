<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use App\Models\User;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An agent won the atomic claim. Dispatched by the claim action (4A); consumed by 4B: `chat.taken` to the other offered
 * agents (`ChatTakenPayload`, `private-staff.{userId}`) and the silent push that dismisses their OS notification (P5).
 */
final class ChatTaken implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    /**
     * @param  list<int>  $otherOfferedUserIds  Users who were offered the chat and did not win it.
     */
    public function __construct(
        public readonly Conversation $conversation,
        public readonly User $claimedBy,
        public readonly array $otherOfferedUserIds,
    ) {}
}
