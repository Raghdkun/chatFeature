<?php

namespace App\Data\Analytics;

use Spatie\LaravelData\Attributes\DataCollectionOf;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/** What the filter menus offer (administrators; an agent gets three empty lists). */
#[TypeScript]
class AnalyticsOptionsData extends Data
{
    /**
     * @param  list<AnalyticsOptionData>  $widgets
     * @param  list<AnalyticsOptionData>  $categories
     * @param  list<AnalyticsOptionData>  $agents
     */
    public function __construct(
        #[DataCollectionOf(AnalyticsOptionData::class)]
        public array $widgets,
        #[DataCollectionOf(AnalyticsOptionData::class)]
        public array $categories,
        #[DataCollectionOf(AnalyticsOptionData::class)]
        public array $agents,
    ) {}
}
