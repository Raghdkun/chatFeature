<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Who wrote a message. Admins who reply are `agent` senders (their user id is in `sender_user_id`). */
#[TypeScript]
enum SenderType: string
{
    case Visitor = 'visitor';
    case Agent = 'agent';
    case System = 'system';
}
