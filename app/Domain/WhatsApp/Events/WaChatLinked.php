<?php

namespace App\Domain\WhatsApp\Events;

use App\Models\WaChat;
use App\Models\WaHandoffTicket;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * A hand-off code matched a chat: `$chat` now carries the widget, visitor and category of `$ticket` (consumed). Dispatched by
 * `ChatLinker` (6A); consumed by 6A's broadcast (`wa.chat.updated`).
 */
final class WaChatLinked implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly WaChat $chat,
        public readonly WaHandoffTicket $ticket,
    ) {}
}
