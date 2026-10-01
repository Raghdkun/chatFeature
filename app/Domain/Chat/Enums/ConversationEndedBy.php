<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Who ended a live conversation (`conversations.ended_by`); `system` is reserved for server-initiated endings. */
#[TypeScript]
enum ConversationEndedBy: string
{
    case Visitor = 'visitor';
    case Agent = 'agent';
    case Admin = 'admin';
    case System = 'system';
}
