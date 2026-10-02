<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The filters the analytics page opened with (normalised: what the query string said, minus whatever is not valid or not allowed for the viewer). */
#[TypeScript]
class AnalyticsFiltersData extends Data
{
    public function __construct(
        public string $from,
        public string $to,
        public ?string $widget,
        public ?string $category,
        public ?int $agent,
        public bool $compare,
    ) {}
}
