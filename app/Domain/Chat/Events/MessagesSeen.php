<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\SenderType;
use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * One side read the conversation up to `$upToSeq` (`$by` is `visitor` or `agent`, never `system`). Dispatched by the receipts
 * action (4A); consumed by 4B: `message.seen` on `private-conversation.{ulid}` (`MessageSeenPayload`).
 */
final class MessagesSeen implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly int $upToSeq,
        public readonly SenderType $by,
    ) {}
}
