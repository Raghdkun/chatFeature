<?php

namespace App\Data\Widgets;

use App\Data\Catalog\CategoryData;
use App\Domain\Widgets\Data\WidgetConfigData;
use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * Everything the widget builder page needs (Inertia props of `widgets/builder`).
 * `config` is the published config, `draft_config` what the builder edits.
 */
#[TypeScript]
class WidgetBuilderData extends Data
{
    /**
     * @param  array<int, GreetingData>  $greetings
     * @param  array<int, string>  $domains  normalised hosts (wildcards allowed)
     * @param  array<int, string>  $category_ulids  enabled categories in display order
     * @param  array<int, CategoryData>  $all_categories
     */
    public function __construct(
        public WidgetData $widget,
        public WidgetConfigData $config,
        public WidgetConfigData $draft_config,
        public array $greetings,
        public array $domains,
        public array $category_ulids,
        public array $all_categories,
        public WidgetSnippetsData $snippets,
        public WidgetPreviewData $preview,
    ) {}
}
