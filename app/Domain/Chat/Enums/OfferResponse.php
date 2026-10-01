<?php

namespace App\Domain\Chat\Enums;

use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** How an offer (`conversation_agent_alerts`) ended: this agent accepted, somebody else did, it timed out, the agent declined. */
#[TypeScript]
enum OfferResponse: string
{
    case Accepted = 'accepted';
    case Taken = 'taken';
    case Expired = 'expired';
    case Dismissed = 'dismissed';
}
