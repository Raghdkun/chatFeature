<?php

namespace App\Data\WhatsApp\Events;

use App\Data\WhatsApp\WaChatData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `wa.chat.updated` on `private-whatsapp-admin`: `{v, chat}` (unread counter, link to a widget, archive, new activity). Admin-only. */
#[TypeScript]
class WaChatUpdatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public WaChatData $chat,
    ) {}
}
