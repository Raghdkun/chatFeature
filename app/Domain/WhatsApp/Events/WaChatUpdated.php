<?php

namespace App\Domain\WhatsApp\Events;

use App\Models\WaChat;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A chat's list entry changed (unread counter reset by opening it, archived / re-opened, name refreshed). Dispatched by the chat actions
 * (6A); consumed by 6A's broadcast (`wa.chat.updated`).
 */
final class WaChatUpdated implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly WaChat $chat) {}
}
