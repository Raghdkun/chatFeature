<?php

namespace App\Domain\Widgets\Availability;

use App\Domain\Widgets\Config\WidgetConfigValidator;
use App\Domain\Widgets\Contracts\PresenceReader;
use App\Domain\Widgets\Data\AvailabilityData;
use App\Domain\Widgets\Data\CategoryAvailabilityData;
use App\Domain\Widgets\Data\WhatsappAvailabilityData;
use App\Domain\Widgets\Support\WidgetCache;
use App\Models\Category;
use App\Models\Widget;
use Carbon\CarbonImmutable;

/**
 * Whether a widget can take chats right now: opening hours of the PUBLISHED config (in the widget's timezone,
 * DST-aware) combined with agent presence. Cached per widget for a few seconds and dropped on publish / settings changes.
 */
final class AvailabilityService
{
    /** Cache lifetime in seconds (contract: 5 to 10 s). */
    public const CACHE_SECONDS = 8;

    public function __construct(
        private readonly PresenceReader $presence,
        private readonly WidgetCache $cache,
        private readonly WidgetConfigValidator $configs,
    ) {}

    public function forWidget(Widget $widget): AvailabilityData
    {
        return AvailabilityData::from($this->arrayFor($widget));
    }

    /**
     * The cached answer as a plain array (the hot path of the public endpoints: no object hydration).
     *
     * @return array<string, mixed>
     */
    public function arrayFor(Widget $widget): array
    {
        $key = $this->cache->key($widget, 'availability');
        $cached = $this->cache->repository()->get($key);

        if (is_array($cached)) {
            return $cached;
        }

        $availability = $this->compute($widget, CarbonImmutable::now())->toArray();
        $this->cache->repository()->put($key, $availability, self::CACHE_SECONDS);

        return $availability;
    }

    /**
     * Uncached computation at a given instant (used by tests and by `forWidget`).
     */
    public function compute(Widget $widget, CarbonImmutable $now): AvailabilityData
    {
        $hours = OpeningHours::fromConfig($this->configs->hydrate($widget->config)->hours, $widget->offline_mode, $widget->timezone);
        $openNow = $hours->isOpen($now);

        $categories = $widget->categories()->where('categories.is_active', true)->get();
        $counts = $this->presence->onlineAgentsByCategory(array_values($categories->map(fn (Category $category): int => $category->id)->all()));

        $perCategory = $categories
            ->map(fn (Category $category): CategoryAvailabilityData => new CategoryAvailabilityData(
                slug: $category->slug,
                online: $openNow && ($counts[$category->id] ?? 0) > 0,
            ))
            ->values()
            ->all();

        $next = $openNow ? null : $hours->nextOpening($now);

        return new AvailabilityData(
            online: collect($perCategory)->contains(fn (CategoryAvailabilityData $category): bool => $category->online),
            openNow: $openNow,
            nextOpenAt: $next?->utc()->format('Y-m-d\TH:i:s.v\Z'),
            categories: $perCategory,
            whatsapp: new WhatsappAvailabilityData(enabled: false),
        );
    }
}
