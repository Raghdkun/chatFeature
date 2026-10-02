<?php

namespace App\Domain\WhatsApp\Events;

use App\Models\WaMessage;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An inbound WhatsApp message was recorded (a new `wa_messages` row; `$message->chat` is its chat). Dispatched by the inbound
 * processor (6A, after the webhook job stored it); consumed by 6A's broadcasts (`wa.message.created` + `wa.chat.updated` on
 * `private-whatsapp-admin`) and by P5's notifications for administrators.
 */
final class WaMessageReceived implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(public readonly WaMessage $message) {}
}
