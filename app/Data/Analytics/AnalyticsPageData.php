<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** The Inertia props of `/analytics`. The numbers themselves come from the analytics API after the first paint. */
#[TypeScript]
class AnalyticsPageData extends Data
{
    public function __construct(
        public AnalyticsPageScopeData $scope,
        public string $timezone,
        public string $today,
        public AnalyticsFiltersData $filters,
        public AnalyticsOptionsData $options,
    ) {}
}
