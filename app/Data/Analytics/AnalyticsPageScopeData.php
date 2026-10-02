<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** Who is looking: `role` decides which view the page shows (`admin`: the full dashboard, `agent`: "My performance"). */
#[TypeScript]
class AnalyticsPageScopeData extends Data
{
    public function __construct(
        public string $role,
        public int $userId,
        public bool $whatsapp,
    ) {}
}
