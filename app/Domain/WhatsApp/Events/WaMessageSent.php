<?php

namespace App\Domain\WhatsApp\Events;

use App\Models\WaMessage;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An administrator's reply was stored and handed to OpenWA (an outbound row, `pending` or already `sent`). Dispatched by the reply
 * action (6A); consumed by 6A's broadcasts (`wa.message.created` + `wa.chat.updated`).
 */
final class WaMessageSent implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly WaMessage $message) {}
}
