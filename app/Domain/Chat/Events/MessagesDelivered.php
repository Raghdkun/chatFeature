<?php

namespace App\Domain\Chat\Events;

use App\Domain\Chat\Enums\SenderType;
use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * One side's client received the other side's messages up to `$upToSeq` without reading them yet (`$by` is `visitor` or `agent`,
 * never `system`). Dispatched by the receipts action when `delivered_at` was newly stamped beyond what was read; consumed by the
 * realtime subscriber: `message.delivered` on `private-conversation.{ulid}` (`MessageDeliveredPayload`).
 */
final class MessagesDelivered implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly Conversation $conversation,
        public readonly int $upToSeq,
        public readonly SenderType $by,
    ) {}
}
