<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Offers of queued chats to agents, and the share of them that ended in an accept (`acceptRate`, 0-1). */
#[TypeScript]
class AnalyticsOffersData extends Data
{
    public function __construct(
        public int $received,
        public ?float $acceptRate,
    ) {}
}
