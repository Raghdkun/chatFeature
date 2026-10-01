<?php

namespace App\Data\Chat\Events;

use App\Data\Chat\ConversationStaffData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** `conversation.updated` on `private-staff.{id}` and `private-admin` (list refresh): `{v, conversation: ConversationStaff}`. */
#[TypeScript]
class ConversationUpdatedPayload extends Data
{
    public int $v = 1;

    public function __construct(
        public ConversationStaffData $conversation,
    ) {}
}
