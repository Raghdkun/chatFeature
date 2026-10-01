<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * The set of queued conversations changed (one entered or left the queue). Dispatched by the Chat actions and the queue-expiry
 * job (4A); consumed by 4B: `queue.updated` to every staff channel and `private-admin`, each with the count that audience can
 * see (`QueueUpdatedPayload`; `Conversation::visibleTo()` + `status = queued`). `$conversation` is the trigger, when known.
 */
final class QueueChanged implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly ?Conversation $conversation = null) {}
}
