<?php

namespace App\Domain\Chat\Events;

use App\Models\Conversation;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An offline ticket (`type = offline`) was created. Dispatched by the offline-form action (4A); consumed by 4B:
 * `offline-ticket.created` on `private-admin` (`OfflineTicketCreatedPayload`), the offline-ticket list and push (P5).
 */
final class OfflineTicketCreated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly Conversation $conversation) {}
}
