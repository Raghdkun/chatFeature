<?php

namespace App\Data\WhatsApp\Events;

use App\Data\WhatsApp\WaMessageData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `wa.message.updated` on `private-whatsapp-admin`: `{v, message}` after a delivery ack or a failure (merge by `message.ulid`). Admin-only. */
#[TypeScript]
class WaMessageUpdatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public WaMessageData $message,
    ) {}
}
