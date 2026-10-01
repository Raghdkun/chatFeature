<?php

namespace App\Domain\Widgets\Data;

use Spatie\LaravelData\Data;
use Spatie\TypeScriptTransformer\Attributes\TypeScript;

/**
 * What `/w/{key}.js` inlines and `GET /api/v1/public/widgets/{key}/config` returns (docs/contracts/widget-config.md):
 * the published config plus greetings, enabled categories, availability and the `api` block.
 * `locale` is the locale the texts were resolved for (the requested one after fallbacks, else the default locale).
 */
#[TypeScript]
class ResolvedBootConfigData extends Data
{
    /**
     * @param  array<int, BootGreetingData>  $greetings
     * @param  array<int, BootCategoryData>  $categories
     */
    public function __construct(
        public int $v,
        public string $key,
        public int $configVersion,
        public string $generatedAt,
        public string $locale,
        public BootApiData $api,
        public PublicWidgetConfigData $config,
        public array $greetings,
        public array $categories,
        public AvailabilityData $availability,
    ) {}
}
