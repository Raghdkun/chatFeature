<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * The assigned agent's unseen counter (`unseen_by_agent`) changed. Dispatched by the message / receipts actions (4A);
 * consumed by 4B: `unread.updated` to `private-staff.{assigned agent id}` (`UnreadUpdatedPayload`, the absolute counter).
 */
final class UnseenCountChanged implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Conversation $conversation) {}
}
