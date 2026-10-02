<?php

namespace App\Data\WhatsApp\Events;

use App\Data\WhatsApp\WaChatData;
use App\Data\WhatsApp\WaMessageData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * `wa.message.created` on `private-whatsapp-admin`: `{v, message, chat}` (the new message and its chat's list entry, so an open
 * inbox can append and re-order without a refetch). Admin-only.
 */
#[TypeScript]
class WaMessageCreatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public WaMessageData $message,
        public WaChatData $chat,
    ) {}
}
