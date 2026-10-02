<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** How handled chats finished: ended by the visitor, by an agent or an admin, by the system (or closed by staff without an end), or closed by the idle sweep. */
#[TypeScript]
class AnalyticsResolutionData extends Data
{
    public function __construct(
        public int $visitor,
        public int $agent,
        public int $system,
        public int $idle,
    ) {}
}
