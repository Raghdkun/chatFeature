<?php

namespace App\Data\Chat\Events;

use App\Data\Chat\ConversationStaffData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `offline-ticket.created` on `private-admin`: `{v, conversation: ConversationStaff}`. */
#[TypeScript]
class OfflineTicketCreatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public ConversationStaffData $conversation,
    ) {}
}
