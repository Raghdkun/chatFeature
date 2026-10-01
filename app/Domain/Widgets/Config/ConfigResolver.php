<?php

namespace App\Domain\Widgets\Config;

use App\Domain\Widgets\Availability\AvailabilityService;
use App\Domain\Widgets\Data\BootApiData;
use App\Domain\Widgets\Data\BootGreetingData;
use App\Domain\Widgets\Data\PublicWidgetConfigData;
use App\Domain\Widgets\Data\ResolvedBootConfigData;
use App\Domain\Widgets\Support\AppOrigin;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;
use App\Models\WidgetGreeting;

/**
 * Builds the ResolvedBootConfig (docs/contracts/widget-config.md): the PUBLISHED config with the five operational
 * columns overlaid, complete texts per locale, active greetings, the widget's enabled categories, availability and
 * the `api` block. Drafts never leave the dashboard.
 *
 * The locale-independent base is cached once per widget revision (any widget change busts it); the visitor's `?locale=`
 * is applied to that cached base in memory, so callers cannot multiply cache entries. The base embeds this installation's
 * origin (`api.*`), so it is keyed by that origin too: changing `app.url` takes effect immediately instead of after the
 * lifetime of the cache entry. Availability always goes through its own short cache.
 */
final class ConfigResolver
{
    /** Lifetime of the cached base; any widget change busts it earlier. */
    public const CACHE_SECONDS = 3600;

    public function __construct(
        private readonly WidgetConfigValidator $configs,
        private readonly WidgetCache $cache,
        private readonly AvailabilityService $availability,
        private readonly AppOrigin $origin,
    ) {}

    /**
     * @param  mixed  $locale  The raw `?locale=` value; anything that is not a locale tag is ignored.
     */
    public function resolve(Widget $widget, mixed $locale = null): ResolvedBootConfigData
    {
        return ResolvedBootConfigData::from($this->resolveArray($widget, $locale));
    }

    /**
     * The same boot config as a plain array in its JSON shape (the hot path of the public endpoints: no object hydration).
     *
     * @param  mixed  $locale  The raw `?locale=` value; anything that is not a locale tag is ignored.
     * @return array<string, mixed>
     */
    public function resolveArray(Widget $widget, mixed $locale = null): array
    {
        $origin = $this->origin->url();

        /** @var array<string, mixed> $base */
        $base = $this->cache->repository()->remember(
            $this->cache->key($widget, 'boot', substr(sha1($origin), 0, 10)),
            self::CACHE_SECONDS,
            fn (): array => $this->build($widget, $origin),
        );

        return [
            ...$this->localise($base, LocaleResolver::sanitize($locale)),
            'availability' => $this->availability->arrayFor($widget),
        ];
    }

    /**
     * @return array<string, mixed>
     */
    private function build(Widget $widget, string $origin): array
    {
        $config = $this->configs->hydrate(ConfigMirror::overlayColumns($widget->config, $widget));
        // A WhatsApp hand-off needs a connected session (P6); until then the feature is never offered to visitors.
        $config->features->whatsapp = false;

        // Complete text blocks (locale -> default locale -> built-in English), including the default locale itself.
        $texts = [];

        foreach (array_values(array_unique([$config->defaultLocale, ...array_keys($config->texts)])) as $key) {
            $texts[$key] = LocaleResolver::completeTexts($config->texts, $config->defaultLocale, $key);
        }

        return [
            'v' => 1,
            'key' => $widget->public_key,
            'configVersion' => $widget->config_version,
            'generatedAt' => now()->utc()->format('Y-m-d\TH:i:s.v\Z'),
            'api' => (new BootApiData(
                base: $origin.'/api/v1/public',
                embed: $origin.'/embed/'.$widget->public_key,
                appOrigin: $origin,
            ))->toArray(),
            'config' => PublicWidgetConfigData::fromConfig($config, $texts)->toArray(),
            'greetings' => $widget->greetings()
                ->where('is_active', true)
                ->get()
                ->map(fn (WidgetGreeting $greeting): array => BootGreetingData::fromGreeting($greeting)->toArray())
                ->all(),
            // Raw names and translations: the label is picked per request.
            'categories' => $widget->categories()
                ->where('categories.is_active', true)
                ->get()
                ->map(fn (Category $category): array => [
                    'slug' => $category->slug,
                    'name' => $category->name,
                    'name_i18n' => $category->name_i18n ?? [],
                    'description' => $category->description,
                    'icon' => $category->icon,
                    'color' => $category->color,
                ])
                ->all(),
        ];
    }

    /**
     * Apply the visitor's locale to the cached base: which text blocks to send, the category labels and the greetings.
     *
     * @param  array<string, mixed>  $base
     * @return array<string, mixed>
     */
    private function localise(array $base, ?string $requested): array
    {
        /** @var array<string, array<string, string>> $texts */
        $texts = $base['config']['texts'];
        $default = (string) $base['config']['defaultLocale'];
        $resolved = LocaleResolver::resolve($requested, $default, array_map('strval', array_keys($texts)));
        $labelLocale = $requested ?? $default;

        $keep = $requested === null ? array_keys($texts) : array_unique([$default, $resolved]);
        $base['config']['texts'] = array_intersect_key($texts, array_flip($keep));
        $base['locale'] = $resolved;

        $base['categories'] = array_map(static fn (array $category): array => [
            'slug' => $category['slug'],
            'label' => LocaleResolver::translate($category['name'], $category['name_i18n'], $labelLocale),
            'description' => $category['description'],
            'icon' => $category['icon'],
            'color' => $category['color'],
        ], $base['categories']);

        if ($requested !== null) {
            $language = strtolower(explode('-', $requested)[0]);

            $base['greetings'] = array_values(array_filter(
                $base['greetings'],
                static fn (array $greeting): bool => $greeting['locale'] === null || strtolower(explode('-', (string) $greeting['locale'])[0]) === $language,
            ));
        }

        return $base;
    }
}
