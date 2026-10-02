<?php

namespace App\Domain\WhatsApp\Events;

use App\Domain\WhatsApp\Enums\WaMessageStatus;
use App\Models\WaMessage;
use Illuminate\Contracts\Events\ShouldDispatchAfterCommit;
use Illuminate\Foundation\Events\Dispatchable;
use Illuminate\Queue\SerializesModels;

/**
 * An outbound message moved forward (`$from` -> `$message->status`) after a `message.ack` / `message.failed` webhook. Dispatched by the
 * ack processor (6A); consumed by 6A's broadcast (`wa.message.updated`).
 */
final class WaMessageStatusChanged implements ShouldDispatchAfterCommit
{
    use Dispatchable, SerializesModels;

    public function __construct(
        public readonly WaMessage $message,
        public readonly WaMessageStatus $from,
    ) {}
}
