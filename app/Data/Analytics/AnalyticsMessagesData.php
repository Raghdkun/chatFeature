<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Visitor and agent messages sent in the range, and the average per finished chat (visitor + agent messages of the chats that finished). */
#[TypeScript]
class AnalyticsMessagesData extends Data
{
    public function __construct(
        public ?int $visitor,
        public int $agent,
        public ?float $perChat,
    ) {}
}
