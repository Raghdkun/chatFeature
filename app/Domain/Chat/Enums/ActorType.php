<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Who caused a `conversation_events` row (`actor_id` is the user id for agents / admins, the visitor id for visitors). */
#[TypeScript]
enum ActorType: string
{
    case Visitor = 'visitor';
    case Agent = 'agent';
    case Admin = 'admin';
    case System = 'system';
}
