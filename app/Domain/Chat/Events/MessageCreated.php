<?php

namespace App\Domain\Chat\Events;

use App\Models\Message;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A message was stored (visitor, agent or system). Dispatched by the message actions (4A); consumed by 4B:
 * `message.created` on `private-conversation.{ulid}` (`MessageCreatedPayload`, broadcast NOW for latency), the unseen counters
 * and push notifications.
 */
final class MessageCreated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Message $message) {}
}
