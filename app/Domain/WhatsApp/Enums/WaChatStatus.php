<?php

namespace App\Domain\WhatsApp\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** A recorded WhatsApp chat in the admin inbox: shown (`open`) or put away (`archived`). A new inbound message re-opens an archived chat. */
#[TypeScript]
enum WaChatStatus: string
{
    case Open = 'open';
    case Archived = 'archived';
}
